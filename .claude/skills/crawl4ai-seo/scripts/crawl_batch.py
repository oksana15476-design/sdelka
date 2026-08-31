#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["crawl4ai>=0.8,<0.9", "beautifulsoup4>=4.12,<5"]
# ///
"""Batch crawl URLs via Crawl4AI and save normalized SEO research outputs."""

from __future__ import annotations

import argparse
import asyncio
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

from common import (
    deep_merge,
    ensure_job,
    load_job,
    load_launch_params,
    load_seed_payload,
    load_seed_urls,
    normalize_domain,
    normalize_launch_params,
    normalize_url,
    print_preview,
    utc_now_iso,
    update_manifest,
    url_file_slug,
    write_json,
    write_ndjson,
)


def first_non_empty(*values: Any) -> str | None:
    for value in values:
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return None


class SEOHTMLParser(HTMLParser):
    def __init__(self, base_url: str) -> None:
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.title: str | None = None
        self.canonical: str | None = None
        self.meta: dict[str, str] = {}
        self.og: dict[str, str] = {}
        self.h1: list[str] = []
        self.headings: list[str] = []
        self._title_chunks: list[str] = []
        self._heading_chunks: list[str] = []
        self._active_heading: str | None = None
        self._inside_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attrs_map = {str(key).lower(): value for key, value in attrs if key}
        if tag == "title":
            self._inside_title = True
            self._title_chunks = []
            return
        if tag == "meta":
            content = first_non_empty(attrs_map.get("content"))
            if not content:
                return
            name = first_non_empty(attrs_map.get("name"))
            prop = first_non_empty(attrs_map.get("property"))
            if name and name.lower() not in self.meta:
                self.meta[name.lower()] = content
            if prop and prop.lower().startswith("og:") and prop.lower() not in self.og:
                self.og[prop.lower()] = content
            return
        if tag == "link":
            href = first_non_empty(attrs_map.get("href"))
            rel = first_non_empty(attrs_map.get("rel"))
            if href and rel:
                rel_values = {item.strip().lower() for item in rel.split() if item.strip()}
                if "canonical" in rel_values and not self.canonical:
                    self.canonical = normalize_url(urljoin(self.base_url, href))
            return
        if tag in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            self._active_heading = tag
            self._heading_chunks = []

    def handle_endtag(self, tag: str) -> None:
        if tag == "title" and self._inside_title:
            title = " ".join(chunk.strip() for chunk in self._title_chunks if chunk.strip()).strip()
            if title and not self.title:
                self.title = title
            self._inside_title = False
            self._title_chunks = []
            return
        if tag == self._active_heading:
            heading = " ".join(chunk.strip() for chunk in self._heading_chunks if chunk.strip()).strip()
            if heading:
                self.headings.append(heading)
                if tag == "h1":
                    self.h1.append(heading)
            self._active_heading = None
            self._heading_chunks = []

    def handle_data(self, data: str) -> None:
        if self._inside_title:
            self._title_chunks.append(data)
        if self._active_heading:
            self._heading_chunks.append(data)


def extract_html_signals(page_url: str, html: Any) -> dict[str, Any]:
    if not isinstance(html, str) or not html.strip():
        return {
            "title": None,
            "description": None,
            "keywords": None,
            "robots": None,
            "canonical": None,
            "h1": [],
            "headings": [],
            "og": {},
        }

    parser = SEOHTMLParser(page_url)
    try:
        parser.feed(html)
        parser.close()
    except Exception:
        return {
            "title": None,
            "description": None,
            "keywords": None,
            "robots": None,
            "canonical": None,
            "h1": [],
            "headings": [],
            "og": {},
        }

    return {
        "title": parser.title,
        "description": parser.meta.get("description"),
        "keywords": parser.meta.get("keywords"),
        "robots": parser.meta.get("robots"),
        "canonical": parser.canonical,
        "h1": parser.h1,
        "headings": parser.headings,
        "og": parser.og,
    }


def extract_markdown_payload(markdown_obj: Any) -> tuple[str | None, str | None]:
    if markdown_obj is None:
        return None, None
    if isinstance(markdown_obj, str):
        return markdown_obj, None
    raw = getattr(markdown_obj, "raw_markdown", None)
    fit = getattr(markdown_obj, "fit_markdown", None)
    if raw is None and isinstance(markdown_obj, dict):
        raw = markdown_obj.get("raw_markdown") or markdown_obj.get("markdown")
        fit = markdown_obj.get("fit_markdown")
    return raw, fit


def extract_text_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, dict):
        items: list[str] = []
        for item in value.values():
            if isinstance(item, list):
                items.extend(str(x).strip() for x in item if str(x).strip())
            elif item:
                items.append(str(item).strip())
        return items
    return [str(value).strip()]


def extract_link_items(links: Any, key: str) -> list[dict]:
    if not isinstance(links, dict):
        return []
    value = links.get(key)
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def url_path_depth(value: str) -> int:
    path = urlparse(value).path.strip("/")
    if not path:
        return 0
    return len([part for part in path.split("/") if part])


def dedupe_texts(values: list[str], limit: int | None = None) -> list[str]:
    unique: list[str] = []
    seen: set[str] = set()
    for value in values:
        text = str(value).strip()
        if not text or text in seen:
            continue
        seen.add(text)
        unique.append(text)
        if limit is not None and len(unique) >= limit:
            break
    return unique


def extract_navigation_signals(page_url: str, html: Any) -> dict[str, Any]:
    payload = {
        "path_depth": url_path_depth(page_url),
        "has_breadcrumbs": False,
        "breadcrumb_texts": [],
        "breadcrumb_urls": [],
        "nav_block_count": 0,
        "nav_link_count": 0,
        "nav_urls_sample": [],
        "nav_texts_sample": [],
    }
    if not isinstance(html, str) or not html.strip():
        return payload

    try:
        soup = BeautifulSoup(html, "html.parser")
    except Exception:
        return payload

    page_domain = normalize_domain(page_url)

    def is_internal(url: str) -> bool:
        return normalize_domain(url) == page_domain

    def normalize_href(value: str | None) -> str | None:
        if not value:
            return None
        href = value.strip()
        if not href or href.startswith("#") or href.lower().startswith("javascript:"):
            return None
        return normalize_url(urljoin(page_url, href))

    def attr_blob(tag: Any) -> str:
        parts: list[str] = []
        for attr in ("class", "id", "role", "aria-label", "data-role"):
            value = tag.attrs.get(attr)
            if isinstance(value, list):
                parts.extend(str(item).lower() for item in value if str(item).strip())
            elif value:
                parts.append(str(value).lower())
        return " ".join(parts)

    breadcrumb_candidates: list[Any] = []
    nav_candidates: list[Any] = []
    seen_nodes: set[int] = set()

    for tag in soup.find_all(True):
        marker = attr_blob(tag)
        if "breadcrumb" in marker:
            identity = id(tag)
            if identity not in seen_nodes:
                breadcrumb_candidates.append(tag)
                seen_nodes.add(identity)

        is_nav_tag = tag.name in {"nav", "header"}
        has_nav_marker = (
            "navigation" in marker
            or " menu" in f" {marker}"
            or " nav" in f" {marker}"
            or "header" in marker
        )
        if is_nav_tag or has_nav_marker:
            nav_candidates.append(tag)

    breadcrumb_texts: list[str] = []
    breadcrumb_urls: list[str] = []
    for node in breadcrumb_candidates:
        texts = [text.strip() for text in node.stripped_strings if text.strip()]
        anchors = [normalize_href(anchor.get("href")) for anchor in node.find_all("a", href=True)]
        breadcrumb_texts.extend(texts[:10])
        breadcrumb_urls.extend(url for url in anchors if url and is_internal(url))

    breadcrumb_texts = dedupe_texts(breadcrumb_texts, limit=10)
    breadcrumb_urls = dedupe_texts(breadcrumb_urls, limit=10)
    payload["has_breadcrumbs"] = len(breadcrumb_texts) >= 2 or len(breadcrumb_urls) >= 1
    payload["breadcrumb_texts"] = breadcrumb_texts
    payload["breadcrumb_urls"] = breadcrumb_urls

    nav_urls: list[str] = []
    nav_texts: list[str] = []
    nav_block_count = 0
    for node in nav_candidates:
        local_urls: list[str] = []
        local_texts: list[str] = []
        for anchor in node.find_all("a", href=True):
            url = normalize_href(anchor.get("href"))
            if not url or not is_internal(url):
                continue
            local_urls.append(url)
            text = " ".join(anchor.stripped_strings).strip()
            if text:
                local_texts.append(text)
        local_urls = dedupe_texts(local_urls)
        local_texts = dedupe_texts(local_texts)
        if len(local_urls) >= 2:
            nav_block_count += 1
            nav_urls.extend(local_urls)
            nav_texts.extend(local_texts)

    payload["nav_block_count"] = nav_block_count
    payload["nav_urls_sample"] = dedupe_texts(nav_urls, limit=15)
    payload["nav_texts_sample"] = dedupe_texts(nav_texts, limit=15)
    payload["nav_link_count"] = len(dedupe_texts(nav_urls))
    return payload


def normalize_page(result: Any, run_id: str, markdown_root: Path, store_markdown: bool) -> tuple[dict, list[dict]]:
    metadata = getattr(result, "metadata", None) or {}
    links = getattr(result, "links", None) or {}
    html = getattr(result, "html", None) or getattr(result, "cleaned_html", None)
    markdown_obj = getattr(result, "markdown", None)
    raw_markdown, fit_markdown = extract_markdown_payload(markdown_obj)

    page_url = normalize_url(str(getattr(result, "url", "") or ""))
    page_domain = normalize_domain(page_url)
    html_signals = extract_html_signals(page_url, html)
    navigation_signals = extract_navigation_signals(page_url, html)

    markdown_path = None
    fit_markdown_path = None
    if store_markdown and raw_markdown:
        markdown_path = markdown_root / f"{url_file_slug(page_url)}.md"
        markdown_path.write_text(raw_markdown, encoding="utf-8")
    if store_markdown and fit_markdown:
        fit_markdown_path = markdown_root / f"{url_file_slug(page_url)}.fit.md"
        fit_markdown_path.write_text(fit_markdown, encoding="utf-8")

    internal_links = extract_link_items(links, "internal")
    external_links = extract_link_items(links, "external")
    headings = extract_text_list(metadata.get("headings"))
    h1_candidates = extract_text_list(metadata.get("h1") or metadata.get("h1_tags"))
    if not headings:
        headings = html_signals["headings"]
    if not h1_candidates:
        h1_candidates = html_signals["h1"]

    canonical = first_non_empty(metadata.get("canonical"), html_signals["canonical"])
    canonical = normalize_url(canonical) if canonical else None
    og_tags = html_signals["og"]

    page_row = {
        "run_id": run_id,
        "url": page_url,
        "domain": page_domain,
        "path_depth": navigation_signals["path_depth"],
        "success": bool(getattr(result, "success", False)),
        "status_code": getattr(result, "status_code", None),
        "title": first_non_empty(metadata.get("title"), html_signals["title"]),
        "description": first_non_empty(metadata.get("description"), html_signals["description"]),
        "canonical": canonical,
        "keywords": first_non_empty(metadata.get("keywords"), html_signals["keywords"]),
        "robots": first_non_empty(metadata.get("robots"), html_signals["robots"]),
        "og_title": first_non_empty(metadata.get("og:title"), og_tags.get("og:title")),
        "og_description": first_non_empty(metadata.get("og:description"), og_tags.get("og:description")),
        "og_image": first_non_empty(metadata.get("og:image"), og_tags.get("og:image")),
        "h1": h1_candidates[0] if h1_candidates else None,
        "headings": headings,
        "word_count": metadata.get("word_count"),
        "has_breadcrumbs": navigation_signals["has_breadcrumbs"],
        "breadcrumb_texts": navigation_signals["breadcrumb_texts"],
        "breadcrumb_urls": navigation_signals["breadcrumb_urls"],
        "nav_block_count": navigation_signals["nav_block_count"],
        "nav_link_count": navigation_signals["nav_link_count"],
        "nav_urls_sample": navigation_signals["nav_urls_sample"],
        "nav_texts_sample": navigation_signals["nav_texts_sample"],
        "internal_links_count": len(internal_links),
        "external_links_count": len(external_links),
        "markdown_path": str(markdown_path) if markdown_path else None,
        "fit_markdown_path": str(fit_markdown_path) if fit_markdown_path else None,
        "error": getattr(result, "error_message", None),
    }

    link_rows: list[dict] = []
    for kind, items in (("internal", internal_links), ("external", external_links)):
        for item in items or []:
            if not isinstance(item, dict):
                continue
            href = item.get("href")
            if not href:
                continue
            target_url = normalize_url(str(href))
            link_rows.append(
                {
                    "run_id": run_id,
                    "source_url": page_url,
                    "target_url": target_url,
                    "target_domain": normalize_domain(target_url),
                    "kind": kind,
                    "anchor_text": item.get("text"),
                    "nofollow": bool(item.get("nofollow")),
                    "same_domain": normalize_domain(target_url) == page_domain,
                }
            )

    return page_row, link_rows


async def crawl_urls(crawler: Any, urls: list[str], crawl_cfg: Any, max_concurrency: int) -> list[Any]:
    if hasattr(crawler, "arun"):
        semaphore = asyncio.Semaphore(max(1, max_concurrency))

        async def worker(url: str) -> Any:
            async with semaphore:
                return await crawler.arun(url=url, config=crawl_cfg)

        return list(await asyncio.gather(*(worker(url) for url in urls)))

    return list(await crawler.arun_many(urls=urls, config=crawl_cfg))


def build_cli_launch_params(args: argparse.Namespace) -> dict:
    return normalize_launch_params(
        {
            "target": {
                "domain": args.domain,
                "site_slug": args.site,
            },
            "job": {
                "project": args.project,
                "label": args.label,
            },
            "crawl": {
                "max_urls": args.limit,
                "cache_mode": "bypass" if args.fresh else None,
            },
        }
    )


async def run_crawl(args: argparse.Namespace) -> int:
    from crawl4ai import AsyncWebCrawler, BrowserConfig, CacheMode, CrawlerRunConfig

    existing_job = None
    if args.job_id:
        try:
            existing_job = load_job(args.job_id)
        except FileNotFoundError:
            existing_job = None

    seed_payload = None
    seed_path = Path(args.seed) if args.seed else None
    if existing_job and not seed_path:
        candidate = Path(existing_job["resolved"]["paths"]["seed_path"])
        if candidate.exists():
            seed_path = candidate

    urls = [normalize_url(url) for url in args.url]
    if seed_path:
        seed_payload = load_seed_payload(seed_path)
        urls.extend(load_seed_urls(seed_path))

    urls = list(dict.fromkeys(urls))
    if not urls:
        raise SystemExit("No URLs to crawl. Use --seed or one or more --url.")

    if existing_job:
        context = existing_job
    else:
        derived_domain = args.domain
        if not derived_domain and seed_payload:
            derived_domain = seed_payload.get("target", {}).get("domain") or seed_payload.get("domain")
        if not derived_domain:
            derived_domain = normalize_url(urls[0])
        launch_params = deep_merge(load_launch_params(args.params), build_cli_launch_params(args))
        launch_params = deep_merge(
            launch_params,
            {
                "target": {
                    "domain": derived_domain,
                    "site_slug": args.site or normalize_domain(derived_domain),
                }
            },
        )
        context = ensure_job(launch_params, job_id=args.job_id)

    config = context["resolved"]
    domain = config.get("target", {}).get("domain") or args.domain or normalize_domain(urls[0])
    max_urls = int(config.get("crawl", {}).get("max_urls", 100))
    urls = urls[:max_urls]

    run_id = context["job_id"]
    markdown_root = Path(config["paths"]["markdown_dir"])
    markdown_root.mkdir(parents=True, exist_ok=True)

    browser_cfg = BrowserConfig(
        headless=bool(config.get("browser", {}).get("headless", True)),
        verbose=bool(config.get("browser", {}).get("verbose", False)),
    )

    cache_mode_name = "BYPASS" if args.fresh else str(config.get("crawl", {}).get("cache_mode", "enabled")).upper()
    cache_mode = getattr(CacheMode, cache_mode_name, None)
    if cache_mode is None:
        cache_mode = getattr(CacheMode, "ENABLED")

    crawl_cfg = CrawlerRunConfig(
        cache_mode=cache_mode,
        word_count_threshold=int(config.get("crawl", {}).get("word_count_threshold", 20)),
        page_timeout=int(config.get("crawl", {}).get("page_timeout_ms", 45000)),
    )
    max_concurrency = int(config.get("crawl", {}).get("max_concurrency", 5))

    pages: list[dict] = []
    links: list[dict] = []

    async with AsyncWebCrawler(config=browser_cfg) as crawler:
        results = await crawl_urls(crawler, urls, crawl_cfg, max_concurrency=max_concurrency)

    for result in results:
        page_row, link_rows = normalize_page(
            result=result,
            run_id=run_id,
            markdown_root=markdown_root,
            store_markdown=bool(config.get("output", {}).get("store_markdown", True)),
        )
        pages.append(page_row)
        links.extend(link_rows)

    pages_path = Path(config["paths"]["pages_path"])
    links_path = Path(config["paths"]["links_path"])
    summary_path = Path(config["paths"]["summary_path"])
    manifest_path = Path(config["paths"]["manifest_path"])

    write_ndjson(pages_path, pages)
    write_ndjson(links_path, links)

    summary = {
        "job_id": run_id,
        "target": config.get("target", {}),
        "job": config.get("job", {}),
        "domain": normalize_domain(str(domain)),
        "run_id": run_id,
        "created_at": utc_now_iso(),
        "requested_urls": len(urls),
        "crawled_ok": sum(1 for page in pages if page["success"]),
        "crawled_failed": sum(1 for page in pages if not page["success"]),
        "internal_links": sum(1 for link in links if link["kind"] == "internal"),
        "external_links": sum(1 for link in links if link["kind"] == "external"),
        "pages_path": str(pages_path),
        "links_path": str(links_path),
    }

    write_json(summary_path, summary)
    update_manifest(
        context["job_id"],
        {
            "status": "crawl_completed",
            "artifacts": {
                "seed_path": str(seed_path) if seed_path else None,
                "pages_path": str(pages_path),
                "links_path": str(links_path),
                "summary_path": str(summary_path),
            },
            "crawl": {
                "requested_urls": len(urls),
                "seed_path": str(seed_path) if seed_path else None,
                "urls": urls,
            },
            "summary": summary,
        },
    )

    preview_rows = int(config.get("output", {}).get("preview_rows", 20))
    print(f"Job completed: {run_id}")
    print(f"Manifest:      {manifest_path}")
    print(f"Summary:       {summary_path}")
    print(f"Pages:         {pages_path}")
    print(f"Links:         {links_path}")
    print("")
    preview = [page["url"] for page in pages]
    print_preview(preview, limit=preview_rows)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Batch crawl URLs with Crawl4AI.")
    parser.add_argument("--params", help="Path to JSON launch params")
    parser.add_argument("--job-id", help="Existing job_id to reuse, or new one to create")
    parser.add_argument("--site", help="Optional site slug override")
    parser.add_argument("--project", help="Optional project/client label for this job")
    parser.add_argument("--label", help="Optional free-form job label")
    parser.add_argument("--domain", help="Domain slug used in cache layout.")
    parser.add_argument("--seed", help="Path to seed.json produced by seed_urls.py.")
    parser.add_argument("--url", action="append", default=[], help="URL to crawl. Repeatable.")
    parser.add_argument("--limit", type=int, help="Override crawl.max_urls.")
    parser.add_argument("--fresh", action="store_true", help="Bypass Crawl4AI cache for this run.")
    args = parser.parse_args()
    return asyncio.run(run_crawl(args))


if __name__ == "__main__":
    raise SystemExit(main())
