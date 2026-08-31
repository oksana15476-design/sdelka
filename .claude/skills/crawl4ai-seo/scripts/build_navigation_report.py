#!/usr/bin/env python3
"""Build a navigation audit report from one seed job and one or more crawl jobs."""

from __future__ import annotations

import argparse
import csv
import json
import statistics
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from common import load_job, load_ndjson, load_seed_payload, normalize_domain, normalize_url, utc_now_iso, write_json


def path_depth(url: str) -> int:
    path = urlparse(url).path.strip("/")
    if not path:
        return 0
    return len([part for part in path.split("/") if part])


def prefix(url: str, parts_count: int = 1) -> str:
    parts = [part for part in urlparse(url).path.strip("/").split("/") if part]
    if not parts:
        return "/"
    return "/" + "/".join(parts[:parts_count]) + "/"


def url_parts(url: str) -> list[str]:
    return [part for part in urlparse(url).path.strip("/").split("/") if part]


def safe_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def section_prefix(url: str) -> str:
    parts = url_parts(url)
    if len(parts) >= 2 and parts[0] in {"catalog", "articles", "news", "tags"}:
        return "/" + "/".join(parts[:2]) + "/"
    return prefix(url, 1)


def breadcrumb_signature(page: dict[str, Any]) -> str | None:
    breadcrumb_urls = [urlparse(normalize_url(item)).path or "/" for item in safe_list(page.get("breadcrumb_urls"))]
    if breadcrumb_urls:
        return " > ".join(breadcrumb_urls)

    breadcrumb_texts = safe_list(page.get("breadcrumb_texts"))
    if len(breadcrumb_texts) >= 2:
        return " > ".join(breadcrumb_texts[:-1] or breadcrumb_texts)
    return None


def nav_url_set(page: dict[str, Any]) -> set[str]:
    return {normalize_url(item) for item in safe_list(page.get("nav_urls_sample")) if normalize_url(item)}


def is_asset_like_url(url: str) -> bool:
    path = (urlparse(url).path or "").lower()
    suffixes = (
        ".jpg",
        ".jpeg",
        ".png",
        ".gif",
        ".svg",
        ".webp",
        ".pdf",
        ".doc",
        ".docx",
        ".xls",
        ".xlsx",
        ".zip",
        ".rar",
        ".mp4",
        ".webm",
    )
    if path.startswith("/upload/") or path.startswith("/downloads/"):
        return True
    return path.endswith(suffixes)


def classify_url_noise(url: str, page: dict[str, Any] | None = None) -> list[str]:
    parsed = urlparse(url)
    reasons: list[str] = []
    path = parsed.path or "/"
    query = parsed.query or ""

    if "login=yes" in query:
        reasons.append("login query URL")
    if "PAGEN_" in query:
        reasons.append("pagination URL")
    if path.endswith(".php"):
        reasons.append("php endpoint")
    if path.endswith("json.php") or path.endswith(".json"):
        reasons.append("json/service endpoint")
    if path in {"/personal/", "/personal/cart/"}:
        reasons.append("personal area URL")
    if path in {"/virtual.php", "/catalog/index1.php"}:
        reasons.append("alternate/technical endpoint")
    if path == "/policy/":
        reasons.append("document-like policy URL")
    if is_asset_like_url(url):
        reasons.append("asset/document URL")

    if page is not None:
        if page.get("success") and not page.get("title") and not page.get("has_breadcrumbs") and int(page.get("nav_link_count") or 0) == 0:
            reasons.append("document-like page without HTML nav signals")

    return reasons


def is_hub_candidate(url: str, page: dict[str, Any]) -> bool:
    parts = url_parts(url)
    depth = int(page.get("path_depth") or path_depth(url))
    if not parts:
        return True
    if depth <= 2:
        return True
    if len(parts) == 2 and parts[0] in {"catalog", "articles", "news", "tags"}:
        return True
    return False


def pick_best_page(current: dict[str, Any] | None, candidate: dict[str, Any]) -> dict[str, Any]:
    if current is None:
        return candidate

    current_score = (
        1 if current.get("success") else 0,
        1 if (current.get("status_code") or 0) < 400 else 0,
        1 if current.get("has_breadcrumbs") else 0,
        current.get("nav_link_count") or 0,
        current.get("internal_links_count") or 0,
        current.get("run_id") or "",
    )
    candidate_score = (
        1 if candidate.get("success") else 0,
        1 if (candidate.get("status_code") or 0) < 400 else 0,
        1 if candidate.get("has_breadcrumbs") else 0,
        candidate.get("nav_link_count") or 0,
        candidate.get("internal_links_count") or 0,
        candidate.get("run_id") or "",
    )
    return candidate if candidate_score >= current_score else current


def write_csv(path: Path, rows: list[dict[str, Any]], fieldnames: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def main() -> int:
    parser = argparse.ArgumentParser(description="Build a navigation audit report from cached crawl jobs.")
    parser.add_argument("--seed-job-id", help="Job id with seed.json that defines the full sitemap frontier")
    parser.add_argument("--seed-path", help="Direct path to seed.json")
    parser.add_argument("--crawl-job-id", action="append", default=[], help="Repeatable crawl job id")
    parser.add_argument("--report-dir", required=True, help="Directory for human-facing report artifacts")
    parser.add_argument("--label", default="navigation-audit", help="Free-form label for report metadata")
    args = parser.parse_args()

    if not args.seed_job_id and not args.seed_path:
        parser.error("Provide --seed-job-id or --seed-path.")
    if not args.crawl_job_id:
        parser.error("Provide at least one --crawl-job-id.")

    if args.seed_path:
        seed_path = Path(args.seed_path)
    else:
        seed_job = load_job(args.seed_job_id)
        seed_path = Path(seed_job["resolved"]["paths"]["seed_path"])

    seed_payload = load_seed_payload(seed_path)
    seed_urls = [normalize_url(url) for url in seed_payload.get("urls", []) if str(url).strip()]
    seed_set = set(seed_urls)
    domain = normalize_domain(seed_payload.get("target", {}).get("domain") or seed_payload.get("domain") or "")

    pages_by_url: dict[str, dict[str, Any]] = {}
    all_links: dict[tuple[str, str, str], dict[str, Any]] = {}
    crawl_jobs_meta: list[dict[str, Any]] = []

    for job_id in args.crawl_job_id:
        job = load_job(job_id)
        crawl_jobs_meta.append(
            {
                "job_id": job_id,
                "job_dir": str(job["job_dir"]),
                "label": job.get("resolved", {}).get("job", {}).get("label"),
            }
        )
        pages_path = Path(job["resolved"]["paths"]["pages_path"])
        links_path = Path(job["resolved"]["paths"]["links_path"])

        for page in load_ndjson(pages_path):
            url = normalize_url(page.get("url", ""))
            if not url:
                continue
            page["path_depth"] = page.get("path_depth") if page.get("path_depth") is not None else path_depth(url)
            pages_by_url[url] = pick_best_page(pages_by_url.get(url), page)

        for link in load_ndjson(links_path):
            if link.get("kind") != "internal":
                continue
            source_url = normalize_url(link.get("source_url", ""))
            target_url = normalize_url(link.get("target_url", ""))
            if not source_url or not target_url:
                continue
            if normalize_domain(source_url) != domain or normalize_domain(target_url) != domain:
                continue
            key = (source_url, target_url, link.get("anchor_text") or "")
            all_links[key] = {
                "source_url": source_url,
                "target_url": target_url,
                "anchor_text": link.get("anchor_text") or "",
            }

    crawled_urls = set(pages_by_url)
    links = list(all_links.values())

    incoming_sources: dict[str, set[str]] = defaultdict(set)
    outgoing_targets: dict[str, set[str]] = defaultdict(set)
    for link in links:
        source_url = link["source_url"]
        target_url = link["target_url"]
        if source_url == target_url:
            continue
        outgoing_targets[source_url].add(target_url)
        incoming_sources[target_url].add(source_url)

    successful_pages = [
        page
        for page in pages_by_url.values()
        if page.get("success") and (page.get("status_code") or 0) < 400
    ]
    hub_pages = [page for page in successful_pages if is_hub_candidate(page["url"], page)]

    nav_counts = [int(page.get("nav_link_count") or 0) for page in successful_pages if int(page.get("nav_link_count") or 0) > 0]
    nav_median = int(statistics.median(nav_counts)) if nav_counts else 0
    low_nav_threshold = max(3, nav_median // 2) if nav_median else 3

    nav_pages = [page for page in successful_pages if nav_url_set(page)]
    common_nav_counts: Counter[str] = Counter()
    for page in nav_pages:
        common_nav_counts.update(nav_url_set(page))
    common_nav_threshold = max(3, int(len(nav_pages) * 0.85)) if nav_pages else 999999
    common_nav_targets = {
        url
        for url, count in common_nav_counts.most_common(20)
        if count >= common_nav_threshold
    }

    page_inventory: list[dict[str, Any]] = []
    failed_pages: list[dict[str, Any]] = []
    orphan_like: list[dict[str, Any]] = []
    weakly_linked: list[dict[str, Any]] = []
    breadcrumb_issues: list[dict[str, Any]] = []
    breadcrumb_inconsistencies: list[dict[str, Any]] = []
    nav_issues: list[dict[str, Any]] = []
    menu_inconsistencies: list[dict[str, Any]] = []
    weak_hubs: list[dict[str, Any]] = []
    canonical_mismatches: list[dict[str, Any]] = []
    linked_not_seeded_rows: list[dict[str, Any]] = []
    technical_junk_rows: list[dict[str, Any]] = []

    title_map: dict[str, list[str]] = defaultdict(list)
    breadcrumb_signatures_by_section: dict[str, Counter[str]] = defaultdict(Counter)
    technical_junk_seen: set[tuple[str, str]] = set()

    for url, page in sorted(pages_by_url.items()):
        incoming = len(incoming_sources.get(url, set()))
        outgoing = len(outgoing_targets.get(url, set()))
        breadcrumb_sig = breadcrumb_signature(page)
        missing_common_nav = sorted(common_nav_targets - nav_url_set(page))
        record = {
            "url": url,
            "status_code": page.get("status_code"),
            "success": page.get("success"),
            "title": page.get("title"),
            "path_depth": page.get("path_depth"),
            "incoming_internal_links": incoming,
            "outgoing_internal_links": outgoing,
            "has_breadcrumbs": page.get("has_breadcrumbs"),
            "nav_link_count": page.get("nav_link_count"),
            "internal_links_count": page.get("internal_links_count"),
            "canonical": page.get("canonical"),
            "breadcrumb_signature": breadcrumb_sig,
            "menu_common_nav_missing": len(missing_common_nav),
        }
        page_inventory.append(record)

        title = (page.get("title") or "").strip().lower()
        if title:
            title_map[title].append(url)

        status_code = page.get("status_code") or 0
        if not page.get("success") or status_code >= 400:
            failed_pages.append(
                {
                    "type": "http_error",
                    "url": url,
                    "status_code": status_code,
                    "detail": page.get("error") or "",
                }
            )
            continue

        if page.get("canonical") and normalize_url(page["canonical"]) != url:
            canonical_mismatches.append(
                {
                    "type": "canonical_mismatch",
                    "url": url,
                    "status_code": status_code,
                    "detail": page.get("canonical"),
                }
            )

        if url != f"https://{domain}/" and incoming == 0:
            orphan_like.append(
                {
                    "type": "orphan_like",
                    "url": url,
                    "status_code": status_code,
                    "detail": f"path_depth={page.get('path_depth')}",
                }
            )
        elif incoming == 1:
            weakly_linked.append(
                {
                    "type": "weak_inlinks",
                    "url": url,
                    "status_code": status_code,
                    "detail": "only 1 internal inlink in crawled graph",
                }
            )

        if int(page.get("path_depth") or 0) >= 2 and not page.get("has_breadcrumbs"):
            breadcrumb_issues.append(
                {
                    "type": "missing_breadcrumbs",
                    "url": url,
                    "status_code": status_code,
                    "detail": "",
                }
            )

        if page.get("has_breadcrumbs") and breadcrumb_sig:
            breadcrumb_signatures_by_section[section_prefix(url)][breadcrumb_sig] += 1

        nav_link_count = int(page.get("nav_link_count") or 0)
        if is_hub_candidate(url, page) and nav_link_count < low_nav_threshold:
            nav_issues.append(
                {
                    "type": "weak_nav_template",
                    "url": url,
                    "status_code": status_code,
                    "detail": f"nav_link_count={nav_link_count}, median={nav_median}",
                }
            )

        if is_hub_candidate(url, page) and common_nav_targets and len(missing_common_nav) >= 2:
            menu_inconsistencies.append(
                {
                    "type": "menu_inconsistency",
                    "url": url,
                    "status_code": status_code,
                    "detail": f"missing_common_nav={len(missing_common_nav)}",
                }
            )

        if is_hub_candidate(url, page) and outgoing < 5:
            weak_hubs.append(
                {
                    "type": "weak_hub_outlinks",
                    "url": url,
                    "status_code": status_code,
                    "detail": f"outgoing_internal_links={outgoing}",
                }
            )

        for reason in classify_url_noise(url, page):
            key = (url, reason)
            if key in technical_junk_seen:
                continue
            technical_junk_seen.add(key)
            technical_junk_rows.append(
                {
                    "type": "technical_junk",
                    "url": url,
                    "status_code": status_code,
                    "detail": reason,
                }
            )

    all_linked_not_seeded_targets = sorted(
        {
            link["target_url"]
            for link in links
            if link["target_url"] not in seed_set
        }
    )
    linked_not_seeded_targets = []
    for url in all_linked_not_seeded_targets:
        if is_asset_like_url(url):
            for reason in classify_url_noise(url):
                key = (url, reason)
                if key in technical_junk_seen:
                    continue
                technical_junk_seen.add(key)
                technical_junk_rows.append(
                    {
                        "type": "technical_junk",
                        "url": url,
                        "status_code": "",
                        "detail": reason,
                    }
                )
            continue
        linked_not_seeded_targets.append(url)
        incoming = len(incoming_sources.get(url, set()))
        linked_not_seeded_rows.append(
            {
                "type": "linked_not_seeded",
                "url": url,
                "status_code": "",
                "detail": f"incoming_from_crawled={incoming}",
            }
        )
        for reason in classify_url_noise(url):
            key = (url, reason)
            if key in technical_junk_seen:
                continue
            technical_junk_seen.add(key)
            technical_junk_rows.append(
                {
                    "type": "technical_junk",
                    "url": url,
                    "status_code": "",
                    "detail": reason,
                }
            )

    for section, signatures in sorted(breadcrumb_signatures_by_section.items()):
        if sum(signatures.values()) < 2 or len(signatures) < 2:
            continue
        top_signature, top_count = signatures.most_common(1)[0]
        if top_count == sum(signatures.values()):
            continue
        breadcrumb_inconsistencies.append(
            {
                "type": "breadcrumb_inconsistency",
                "url": section,
                "status_code": "",
                "detail": f"signature_variants={len(signatures)}, dominant={top_count}/{sum(signatures.values())}, dominant_signature={top_signature}",
            }
        )

    duplicate_title_groups = [
        {"type": "duplicate_title", "title": title, "urls": urls}
        for title, urls in title_map.items()
        if len(urls) > 1
    ]
    duplicate_title_rows = [
        {
            "type": "duplicate_title",
            "url": ", ".join(item["urls"]),
            "status_code": "",
            "detail": item["title"],
        }
        for item in duplicate_title_groups
    ]

    crawled_prefix_counts = Counter(prefix(url, 1) for url in crawled_urls)
    seed_prefix_counts = Counter(prefix(url, 1) for url in seed_urls)
    backlog = sorted(seed_set - crawled_urls)
    backlog_prefix_counts = Counter(prefix(url, 1) for url in backlog)
    linked_not_seeded_prefix_counts = Counter(prefix(url, 1) for url in linked_not_seeded_targets)
    technical_junk_prefix_counts = Counter(prefix(row["url"], 1) for row in technical_junk_rows)

    structural_anti_patterns: list[str] = []
    catalog_seed = seed_prefix_counts.get("/catalog/", 0)
    if seed_urls and catalog_seed / len(seed_urls) >= 0.8 and (seed_prefix_counts.get("/tags/", 0) or seed_prefix_counts.get("/news/", 0)):
        structural_anti_patterns.append(
            f"sitemap frontier перегружен catalog/archive mix: /catalog/={catalog_seed}, /tags/={seed_prefix_counts.get('/tags/', 0)}, /news/={seed_prefix_counts.get('/news/', 0)}"
        )
    if linked_not_seeded_prefix_counts:
        top_prefix, top_count = linked_not_seeded_prefix_counts.most_common(1)[0]
        structural_anti_patterns.append(
            f"сайт линкует зоны вне seed frontier: linked-not-seeded={len(linked_not_seeded_targets)}, крупнейший префикс {top_prefix} ({top_count})"
        )
    if any("login query URL" in row["detail"] for row in technical_junk_rows):
        structural_anti_patterns.append("внутренний граф содержит login/query URL, что загрязняет навигационный слой и создаёт crawl waste")
    if any("php endpoint" in row["detail"] or "json/service endpoint" in row["detail"] for row in technical_junk_rows):
        structural_anti_patterns.append("в навигационный граф попадают php/json/service endpoints вместо чистых HTML landing pages")
    if menu_inconsistencies:
        structural_anti_patterns.append(f"есть menu/template drift: {len(menu_inconsistencies)} hub-like страниц отклоняются от common nav set")
    if breadcrumb_inconsistencies:
        structural_anti_patterns.append(f"есть breadcrumb drift по секциям: {len(breadcrumb_inconsistencies)} section groups с несколькими trail signature")

    summary = {
        "created_at": utc_now_iso(),
        "label": args.label,
        "domain": domain,
        "seed_url_count": len(seed_urls),
        "crawled_unique_urls": len(crawled_urls),
        "successful_pages": len(successful_pages),
        "internal_link_edges": len(links),
        "coverage_pct": round((len(crawled_urls) / len(seed_urls) * 100), 2) if seed_urls else 0,
        "nav_link_count_median": nav_median,
        "backlog_url_count": len(backlog),
        "failed_pages": len(failed_pages),
        "orphan_like_pages": len(orphan_like),
        "weakly_linked_pages": len(weakly_linked),
        "missing_breadcrumbs": len(breadcrumb_issues),
        "weak_nav_templates": len(nav_issues),
        "weak_hubs": len(weak_hubs),
        "canonical_mismatches": len(canonical_mismatches),
        "duplicate_title_groups": len(duplicate_title_groups),
        "linked_not_seeded": len(linked_not_seeded_targets),
        "technical_junk": len(technical_junk_rows),
        "menu_inconsistencies": len(menu_inconsistencies),
        "breadcrumb_inconsistencies": len(breadcrumb_inconsistencies),
        "structural_anti_patterns": len(structural_anti_patterns),
        "crawl_jobs": crawl_jobs_meta,
        "seed_path": str(seed_path),
    }

    issues_rows = (
        failed_pages
        + orphan_like[:200]
        + weakly_linked[:200]
        + breadcrumb_issues[:200]
        + breadcrumb_inconsistencies[:200]
        + nav_issues[:200]
        + menu_inconsistencies[:200]
        + weak_hubs[:200]
        + canonical_mismatches[:200]
        + linked_not_seeded_rows[:200]
        + technical_junk_rows[:200]
        + duplicate_title_rows[:200]
    )

    report_dir = Path(args.report_dir)
    report_dir.mkdir(parents=True, exist_ok=True)
    summary_path = report_dir / "summary.json"
    issues_csv_path = report_dir / "issues.csv"
    page_inventory_path = report_dir / "page-inventory.csv"
    report_path = report_dir / "navigation-audit-report.md"
    linked_not_seeded_path = report_dir / "linked-but-not-seeded.txt"

    write_json(summary_path, summary)
    linked_not_seeded_path.write_text("\n".join(linked_not_seeded_targets) + ("\n" if linked_not_seeded_targets else ""), encoding="utf-8")
    write_csv(
        page_inventory_path,
        page_inventory,
        [
            "url",
            "status_code",
            "success",
            "title",
            "path_depth",
            "incoming_internal_links",
            "outgoing_internal_links",
            "has_breadcrumbs",
            "nav_link_count",
            "internal_links_count",
            "canonical",
            "breadcrumb_signature",
            "menu_common_nav_missing",
        ],
    )
    write_csv(
        issues_csv_path,
        issues_rows,
        ["type", "url", "status_code", "detail"],
    )

    lines: list[str] = []
    lines.append(f"# Navigation Audit: {domain}")
    lines.append("")
    lines.append(f"Дата: `{summary['created_at']}`")
    lines.append("")
    lines.append("## Scope")
    lines.append("")
    lines.append(f"- Seed frontier: `{len(seed_urls)}` URL из sitemap/robots.")
    lines.append(f"- Crawled unique URLs: `{len(crawled_urls)}` (`{summary['coverage_pct']}%` seed frontier).")
    lines.append(f"- Successful pages: `{len(successful_pages)}`.")
    lines.append(f"- Internal link edges captured: `{len(links)}`.")
    lines.append(f"- Crawl jobs: `{', '.join(job['job_id'] for job in crawl_jobs_meta)}`.")
    lines.append("")
    lines.append("## Practical Plan")
    lines.append("")
    lines.append("- Seed source: sitemap index + robots.txt, как дешёвый и repeatable frontier.")
    lines.append("- Crawl order: pilot core pages -> hub/category coverage -> product sample expansion.")
    lines.append("- Resume model: каждый chunk = отдельный crawl job в skill cache; report rebuild не требует повторного fetch.")
    lines.append("- Reporting model: markdown/csv/json в отдельной `reports/...` директории; jobs/cache остаются внутри skill.")
    lines.append("")
    lines.append("## Coverage By Prefix")
    lines.append("")
    lines.append("| Prefix | Seed | Crawled | Backlog |")
    lines.append("|---|---:|---:|---:|")
    for pref, seed_count in seed_prefix_counts.most_common(15):
        lines.append(f"| `{pref}` | {seed_count} | {crawled_prefix_counts.get(pref, 0)} | {backlog_prefix_counts.get(pref, 0)} |")
    lines.append("")
    lines.append("## Findings")
    lines.append("")
    lines.append(f"1. `orphan-like / zero-inlink`: `{len(orphan_like)}` страниц среди crawled set не получили ни одной внутренней ссылки из других crawled pages.")
    lines.append(f"2. `weak inlinks`: `{len(weakly_linked)}` страниц имеют только одну внутреннюю ссылку в captured graph.")
    lines.append(f"3. `missing breadcrumbs`: `{len(breadcrumb_issues)}` страниц глубже первого уровня без заметного breadcrumb signal.")
    lines.append(f"4. `breadcrumb inconsistency`: `{len(breadcrumb_inconsistencies)}` section groups имеют несколько breadcrumb trail signatures.")
    lines.append(f"5. `weak nav template`: `{len(nav_issues)}` hub/category страниц имеют подозрительно слабый nav footprint относительно медианы `{nav_median}`.")
    lines.append(f"6. `menu inconsistency`: `{len(menu_inconsistencies)}` hub-like страниц теряют часть common nav targets.")
    lines.append(f"7. `weak hubs`: `{len(weak_hubs)}` hub/category страниц отдают меньше `5` уникальных внутренних ссылок.")
    lines.append(f"8. `linked-not-seeded`: `{len(linked_not_seeded_targets)}` внутренних URL линкуются сайтом, но отсутствуют в seed frontier.")
    lines.append(f"9. `technical junk`: `{len(technical_junk_rows)}` URL/страниц выглядят как query/php/service/document noise.")
    lines.append(f"10. `http errors / failed pages`: `{len(failed_pages)}`.")
    lines.append(f"11. `canonical mismatches`: `{len(canonical_mismatches)}`.")
    lines.append(f"12. `duplicate title groups`: `{len(duplicate_title_groups)}`.")
    lines.append("")

    def add_examples(title: str, rows: list[dict[str, Any]], limit: int = 10) -> None:
        lines.append(f"### {title}")
        lines.append("")
        if not rows:
            lines.append("- Не найдено в текущем покрытии.")
            lines.append("")
            return
        for row in rows[:limit]:
            detail = row.get("detail", "")
            suffix = f" — {detail}" if detail else ""
            lines.append(f"- `{row.get('url')}`{suffix}")
        lines.append("")

    add_examples("Zero-Inlink Examples", orphan_like)
    add_examples("Weakly Linked Examples", weakly_linked)
    add_examples("Missing Breadcrumbs Examples", breadcrumb_issues)
    add_examples("Breadcrumb Inconsistency Examples", breadcrumb_inconsistencies)
    add_examples("Weak Nav Template Examples", nav_issues)
    add_examples("Menu Inconsistency Examples", menu_inconsistencies)
    add_examples("Weak Hub Examples", weak_hubs)
    add_examples("Linked-Not-Seeded Examples", linked_not_seeded_rows)
    add_examples("Technical Junk Examples", technical_junk_rows)
    add_examples("Failed Pages", failed_pages)

    lines.append("## Structural Anti-Patterns")
    lines.append("")
    if structural_anti_patterns:
        for item in structural_anti_patterns:
            lines.append(f"- {item}")
    else:
        lines.append("- Явные structural anti-patterns не выделились на текущем покрытии.")
    lines.append("")

    lines.append("## Linked-Not-Seeded Zones")
    lines.append("")
    if linked_not_seeded_prefix_counts:
        for pref, count in linked_not_seeded_prefix_counts.most_common(10):
            lines.append(f"- `{pref}`: {count} URL")
    else:
        lines.append("- Не найдено в текущем покрытии.")
    lines.append("")

    lines.append("## Technical Junk By Prefix")
    lines.append("")
    if technical_junk_prefix_counts:
        for pref, count in technical_junk_prefix_counts.most_common(10):
            lines.append(f"- `{pref}`: {count} observations")
    else:
        lines.append("- Не найдено в текущем покрытии.")
    lines.append("")

    lines.append("## Remaining Frontier")
    lines.append("")
    lines.append(f"- Необойдённый backlog: `{len(backlog)}` URL.")
    if backlog_prefix_counts:
        for pref, count in backlog_prefix_counts.most_common(10):
            lines.append(f"- `{pref}`: {count} URL ещё не crawled.")
    lines.append("")
    lines.append("## Artifacts")
    lines.append("")
    lines.append(f"- Summary: `{summary_path}`")
    lines.append(f"- Issues CSV: `{issues_csv_path}`")
    lines.append(f"- Page inventory CSV: `{page_inventory_path}`")
    lines.append(f"- Linked but not seeded: `{linked_not_seeded_path}`")
    lines.append("")

    report_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    print(json.dumps(
        {
            "report_path": str(report_path),
            "summary_path": str(summary_path),
            "issues_csv_path": str(issues_csv_path),
            "page_inventory_path": str(page_inventory_path),
            "summary": summary,
        },
        ensure_ascii=False,
        indent=2,
    ))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
