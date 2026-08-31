#!/usr/bin/env python3
"""Compare normalized page records from pages.ndjson."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from common import load_job, load_ndjson


def main() -> int:
    parser = argparse.ArgumentParser(description="Preview normalized page records for SEO comparison.")
    parser.add_argument("--pages", help="Path to pages.ndjson")
    parser.add_argument("--job-id", help="Read pages.ndjson from an existing job")
    parser.add_argument("--top", type=int, default=20, help="How many rows to preview")
    parser.add_argument("--json", action="store_true", help="Print JSON instead of a plain-text table")
    args = parser.parse_args()

    pages_path = args.pages
    if args.job_id:
        job = load_job(args.job_id)
        pages_path = job["resolved"]["paths"]["pages_path"]

    if not pages_path:
        parser.error("Provide --pages or --job-id.")

    rows = load_ndjson(Path(pages_path))
    preview = rows[: args.top]

    if args.json:
        print(json.dumps(preview, ensure_ascii=False, indent=2))
        return 0

    print("URL\tSuccess\tStatus\tTitle\tH1\tInternal\tExternal")
    for row in preview:
        print(
            "\t".join(
                [
                    str(row.get("url") or ""),
                    str(row.get("success")),
                    str(row.get("status_code") or ""),
                    str(row.get("title") or "")[:80],
                    str(row.get("h1") or "")[:80],
                    str(row.get("internal_links_count") or 0),
                    str(row.get("external_links_count") or 0),
                ]
            )
        )

    if len(rows) > args.top:
        print(f"... and {len(rows) - args.top} more rows in {pages_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
