#!/usr/bin/env python3
"""Discover seed URLs from robots.txt, sitemap.xml, or a local file."""

from __future__ import annotations

import argparse
import re
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import urljoin, urlparse

from common import (
    deep_merge,
    ensure_job,
    load_job,
    load_launch_params,
    normalize_launch_params,
    normalize_domain,
    normalize_url,
    print_preview,
    slugify,
    utc_now_iso,
    resolve_effective_config,
    update_manifest,
    write_json,
)


USER_AGENT = "marketing-analytics-crawl4ai-seo/0.1"


def fetch_text(url: str, timeout: int) -> str | None:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            content_type = response.headers.get("Content-Type", "")
            if "xml" not in content_type and "text" not in content_type and not url.endswith(".xml"):
                return None
            return response.read().decode("utf-8", errors="replace")
    except (urllib.error.URLError, TimeoutError, ValueError):
        return None


def sitemap_urls_from_robots(robots_text: str, base_url: str) -> list[str]:
    urls: list[str] = []
    for line in robots_text.splitlines():
        if line.lower().startswith("sitemap:"):
            value = line.split(":", 1)[1].strip()
            if value:
                urls.append(urljoin(base_url, value))
    return urls


def extract_urls_from_sitemap(
    sitemap_url: str,
    timeout: int,
    visited: set[str],
    max_sitemaps: int = 20,
) -> list[str]:
    if sitemap_url in visited or len(visited) >= max_sitemaps:
        return []
    visited.add(sitemap_url)
    text = fetch_text(sitemap_url, timeout)
    if not text:
        return []

    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        return []

    urls: list[str] = []
    namespace = ""
    if root.tag.startswith("{"):
        namespace = root.tag.split("}", 1)[0] + "}"

    if root.tag.endswith("sitemapindex"):
        for node in root.findall(f"{namespace}sitemap/{namespace}loc"):
            child = (node.text or "").strip()
            if child:
                urls.extend(extract_urls_from_sitemap(child, timeout, visited, max_sitemaps))
        return urls

    for node in root.findall(f"{namespace}url/{namespace}loc"):
        value = (node.text or "").strip()
        if value:
            urls.append(value)
    return urls


def filter_urls(urls: list[str], domain: str, same_host_only: bool, include: list[str], exclude: list[str]) -> list[str]:
    filtered: list[str] = []
    host = normalize_domain(domain)
    include_re = [re.compile(pattern) for pattern in include]
    exclude_re = [re.compile(pattern) for pattern in exclude]

    for raw_url in urls:
        url = normalize_url(raw_url)
        parsed = urlparse(url)
        if same_host_only and normalize_domain(parsed.netloc) != host:
            continue
        if include_re and not any(regex.search(url) for regex in include_re):
            continue
        if any(regex.search(url) for regex in exclude_re):
            continue
        filtered.append(url)

    unique = sorted(dict.fromkeys(filtered))
    return unique


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
            "seed": {
                "limit": args.limit,
                "same_host_only": args.same_host_only,
                "include_patterns": args.include_pattern or None,
                "exclude_patterns": args.exclude_pattern or None,
            },
        }
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Build a seed.json file for crawl4ai-seo.")
    parser.add_argument("--params", help="Path to JSON launch params")
    parser.add_argument("--job-id", help="Existing job_id to reuse, or new one to create")
    parser.add_argument("--domain", help="Domain or site root, e.g. https://example.com")
    parser.add_argument("--site", help="Optional site slug override")
    parser.add_argument("--project", help="Optional project/client label for this job")
    parser.add_argument("--label", help="Optional free-form job label")
    parser.add_argument("--sitemap", help="Explicit sitemap.xml URL")
    parser.add_argument("--file", help="Local text file with one URL per line")
    parser.add_argument("--limit", type=int, help="Max URLs to keep")
    parser.add_argument(
        "--same-host-only",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="Override seed.same_host_only for this job",
    )
    parser.add_argument("--include-pattern", action="append", default=[], help="Repeatable include regex")
    parser.add_argument("--exclude-pattern", action="append", default=[], help="Repeatable exclude regex")
    args = parser.parse_args()

    existing_job = None
    if args.job_id:
        try:
            existing_job = load_job(args.job_id)
        except FileNotFoundError:
            existing_job = None

    if existing_job:
        effective = existing_job["resolved"]
    else:
        launch_params = deep_merge(load_launch_params(args.params), build_cli_launch_params(args))
        effective = resolve_effective_config(launch_params)

    timeout = int(effective.get("seed", {}).get("request_timeout_seconds", 20))
    same_host_only = bool(effective.get("seed", {}).get("same_host_only", True))
    include = list(effective.get("seed", {}).get("include_patterns", []))
    exclude = list(effective.get("seed", {}).get("exclude_patterns", []))
    limit = int(effective.get("seed", {}).get("limit", 200))

    domain_hint = args.domain or effective.get("target", {}).get("domain")
    if not any([domain_hint, args.sitemap, args.file]):
        parser.error("Provide one of --domain, --sitemap, or --file.")

    sources: list[str] = []
    collected_urls: list[str] = []

    domain = domain_hint or args.sitemap or "manual-list"
    domain_host = normalize_domain(domain)

    if args.file:
        file_path = Path(args.file)
        sources.append(str(file_path.resolve()))
        collected_urls.extend(
            line.strip()
            for line in file_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        )

    if args.sitemap:
        sources.append(args.sitemap)
        collected_urls.extend(extract_urls_from_sitemap(args.sitemap, timeout, set()))

    if args.domain:
        base = normalize_url(args.domain)
        robots_url = urljoin(base if base.endswith("/") else base + "/", "robots.txt")
        sitemap_url = urljoin(base if base.endswith("/") else base + "/", "sitemap.xml")
        robots_text = fetch_text(robots_url, timeout)
        if robots_text:
            sources.append(robots_url)
            discovered = sitemap_urls_from_robots(robots_text, base)
            if discovered:
                for item in discovered:
                    collected_urls.extend(extract_urls_from_sitemap(item, timeout, set()))
                    sources.append(item)
            else:
                sources.append(sitemap_url)
                collected_urls.extend(extract_urls_from_sitemap(sitemap_url, timeout, set()))
        else:
            sources.append(sitemap_url)
            collected_urls.extend(extract_urls_from_sitemap(sitemap_url, timeout, set()))
    elif not args.file and not args.sitemap and effective.get("target", {}).get("domain"):
        base = normalize_url(str(effective["target"]["domain"]))
        robots_url = urljoin(base if base.endswith("/") else base + "/", "robots.txt")
        sitemap_url = urljoin(base if base.endswith("/") else base + "/", "sitemap.xml")
        robots_text = fetch_text(robots_url, timeout)
        if robots_text:
            sources.append(robots_url)
            discovered = sitemap_urls_from_robots(robots_text, base)
            if discovered:
                for item in discovered:
                    collected_urls.extend(extract_urls_from_sitemap(item, timeout, set()))
                    sources.append(item)
            else:
                sources.append(sitemap_url)
                collected_urls.extend(extract_urls_from_sitemap(sitemap_url, timeout, set()))
        else:
            sources.append(sitemap_url)
            collected_urls.extend(extract_urls_from_sitemap(sitemap_url, timeout, set()))

    effective_same_host_only = same_host_only and domain_host != "manual-list"
    if domain_host == "manual-list" and collected_urls:
        domain_host = normalize_domain(collected_urls[0])

    final_urls = filter_urls(collected_urls, domain_host, effective_same_host_only, include, exclude)[:limit]
    if not final_urls:
        print("No URLs discovered. Check domain/sitemap, filters, or connectivity.", file=sys.stderr)
        return 1

    if existing_job:
        context = existing_job
    else:
        target_domain = domain_hint or f"https://{domain_host}"
        launch_params = deep_merge(
            load_launch_params(args.params),
            build_cli_launch_params(args),
        )
        launch_params = deep_merge(
            launch_params,
            {
                "target": {
                    "domain": target_domain,
                    "site_slug": args.site or slugify(domain_host),
                }
            },
        )
        context = ensure_job(launch_params, job_id=args.job_id)

    output_path = Path(context["resolved"]["paths"]["seed_path"])
    payload = {
        "job_id": context["job_id"],
        "target": context["resolved"].get("target", {}),
        "job": context["resolved"].get("job", {}),
        "domain": domain_host,
        "created_at": utc_now_iso(),
        "sources": sources,
        "url_count": len(final_urls),
        "urls": final_urls,
    }
    write_json(output_path, payload)
    update_manifest(
        context["job_id"],
        {
            "status": "seed_ready",
            "artifacts": {
                "seed_path": str(output_path),
            },
            "seed_summary": {
                "domain": domain_host,
                "url_count": len(final_urls),
                "sources": sources,
            },
        },
    )

    preview_rows = int(context["resolved"].get("output", {}).get("preview_rows", 20))
    print(f"Job:    {context['job_id']}")
    print(f"Seed:   {output_path}")
    print(f"Domain: {domain_host}")
    print(f"URLs:   {len(final_urls)}")
    print("")
    print_preview(final_urls, limit=preview_rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
