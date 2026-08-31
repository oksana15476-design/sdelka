#!/usr/bin/env python3
"""Common helpers for the crawl4ai-seo skill."""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlparse


SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
CONFIG_DIR = SKILL_DIR / "config"
CACHE_DIR = SKILL_DIR / "cache"
JOBS_DIR = CACHE_DIR / "jobs"
SITES_DIR = CACHE_DIR / "sites"
DEFAULTS_EXAMPLE_PATH = CONFIG_DIR / "defaults.example.json"
DEFAULTS_PATH = CONFIG_DIR / "defaults.json"
LEGACY_EXAMPLE_PATH = CONFIG_DIR / "config.example.json"
LEGACY_CONFIG_PATH = CONFIG_DIR / "config.json"


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def deep_merge(base: dict, override: dict) -> dict:
    result = deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def load_json_if_exists(path: Path) -> dict:
    if not path.exists():
        return {}
    return load_json(path)


def load_defaults() -> dict:
    defaults = {}
    if DEFAULTS_EXAMPLE_PATH.exists():
        defaults = load_json(DEFAULTS_EXAMPLE_PATH)
    elif LEGACY_EXAMPLE_PATH.exists():
        defaults = load_json(LEGACY_EXAMPLE_PATH)

    if DEFAULTS_PATH.exists():
        defaults = deep_merge(defaults, load_json(DEFAULTS_PATH))
    elif LEGACY_CONFIG_PATH.exists():
        defaults = deep_merge(defaults, load_json(LEGACY_CONFIG_PATH))

    return defaults


def resolve_skill_path(value: str | None) -> Path | None:
    if not value:
        return None
    path = Path(value)
    if path.is_absolute():
        return path
    return (SKILL_DIR / path).resolve()


def slugify(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"^https?://", "", value)
    value = value.split("/", 1)[0]
    value = re.sub(r"[^a-z0-9]+", "-", value)
    value = value.strip("-")
    return value or "default"


def normalize_domain(value: str) -> str:
    if not value:
        return ""
    parsed = urlparse(value if "://" in value else f"https://{value}")
    return (parsed.netloc or parsed.path).lower().strip()


def normalize_url(value: str) -> str:
    value = value.strip()
    if not value:
        return value
    parsed = urlparse(value if "://" in value else f"https://{value}")
    scheme = parsed.scheme or "https"
    netloc = parsed.netloc or parsed.path
    path = parsed.path if parsed.netloc else ""
    normalized = f"{scheme}://{netloc}{path or '/'}"
    if parsed.query:
        normalized += f"?{parsed.query}"
    return normalized


def prune_none(value: Any) -> Any:
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            cleaned = prune_none(item)
            if cleaned is not None:
                result[key] = cleaned
        return result
    if isinstance(value, list):
        return [prune_none(item) for item in value]
    return value


def load_launch_params(path: str | None) -> dict:
    if not path:
        return {}
    return prune_none(load_json(Path(path)))


def normalize_launch_params(payload: dict) -> dict:
    normalized = prune_none(deepcopy(payload))
    target = normalized.setdefault("target", {})
    domain = target.get("domain")
    if domain:
        target["domain"] = normalize_url(str(domain))
    site_slug = target.get("site_slug")
    if site_slug:
        target["site_slug"] = slugify(str(site_slug))
    elif domain:
        target["site_slug"] = slugify(normalize_domain(str(domain)))
    return normalized


def resolve_effective_config(launch_params: dict) -> dict:
    effective = deep_merge(load_defaults(), normalize_launch_params(launch_params))
    target = effective.setdefault("target", {})
    domain = target.get("domain")
    if domain:
        target["domain"] = normalize_url(str(domain))
    target["site_slug"] = slugify(str(target.get("site_slug") or normalize_domain(str(domain or "")) or "manual-list"))
    return effective


def make_job_id(site_slug: str) -> str:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    suffix = uuid.uuid4().hex[:8]
    site_part = slugify(site_slug) or "site"
    return f"{timestamp}-{site_part}-{suffix}"


def job_dir(job_id: str) -> Path:
    return JOBS_DIR / job_id


def site_ref_path(site_slug: str, job_id: str) -> Path:
    return SITES_DIR / slugify(site_slug) / "jobs" / f"{job_id}.json"


def build_job_paths(job_id: str, site_slug: str) -> dict[str, str]:
    root = job_dir(job_id)
    return {
        "job_dir": str(root),
        "launch_params_path": str(root / "launch_params.json"),
        "resolved_config_path": str(root / "resolved_config.json"),
        "manifest_path": str(root / "manifest.json"),
        "seed_path": str(root / "seed.json"),
        "pages_path": str(root / "pages.ndjson"),
        "links_path": str(root / "links.ndjson"),
        "summary_path": str(root / "summary.json"),
        "markdown_dir": str(root / "markdown"),
        "site_ref_path": str(site_ref_path(site_slug, job_id)),
    }


def ensure_job(launch_params: dict, job_id: str | None = None) -> dict:
    resolved = resolve_effective_config(launch_params)
    site_slug = resolved.get("target", {}).get("site_slug") or "manual-list"
    current_job_id = job_id or make_job_id(site_slug)
    root = job_dir(current_job_id)
    root.mkdir(parents=True, exist_ok=True)

    paths = build_job_paths(current_job_id, site_slug)
    created_at = utc_now_iso()
    normalized_launch = normalize_launch_params(launch_params)
    resolved_payload = deep_merge(
        resolved,
        {
            "job_meta": {
                "job_id": current_job_id,
                "created_at": created_at,
            },
            "paths": paths,
        },
    )
    manifest = {
        "job_id": current_job_id,
        "created_at": created_at,
        "updated_at": created_at,
        "status": "initialized",
        "target": resolved_payload.get("target", {}),
        "job": resolved_payload.get("job", {}),
        "paths": paths,
        "artifacts": {},
    }

    write_json(Path(paths["launch_params_path"]), normalized_launch)
    write_json(Path(paths["resolved_config_path"]), resolved_payload)
    write_json(Path(paths["manifest_path"]), manifest)
    write_json(
        Path(paths["site_ref_path"]),
        {
            "job_id": current_job_id,
            "site_slug": site_slug,
            "target": resolved_payload.get("target", {}),
            "job": resolved_payload.get("job", {}),
            "job_dir": paths["job_dir"],
            "manifest_path": paths["manifest_path"],
            "created_at": created_at,
        },
    )
    return load_job(current_job_id)


def load_job(job_id: str) -> dict:
    root = job_dir(job_id)
    resolved_path = root / "resolved_config.json"
    manifest_path = root / "manifest.json"
    launch_path = root / "launch_params.json"
    if not resolved_path.exists():
        raise FileNotFoundError(f"Job not found: {job_id}")
    return {
        "job_id": job_id,
        "job_dir": root,
        "launch_params": load_json_if_exists(launch_path),
        "resolved": load_json(resolved_path),
        "manifest": load_json_if_exists(manifest_path),
    }


def update_manifest(job_id: str, patch: dict) -> dict:
    current = load_job(job_id)
    manifest = deep_merge(current.get("manifest", {}), patch)
    manifest["job_id"] = job_id
    manifest["updated_at"] = utc_now_iso()
    write_json(Path(current["resolved"]["paths"]["manifest_path"]), manifest)
    return manifest


def url_fingerprint(value: str) -> str:
    return hashlib.sha1(normalize_url(value).encode("utf-8")).hexdigest()[:10]


def url_file_slug(value: str) -> str:
    normalized = normalize_url(value)
    return f"{slugify(normalized)[:80]}-{url_fingerprint(normalized)}"


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def write_ndjson(path: Path, rows: Iterable[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def load_seed_payload(path: Path) -> dict:
    return load_json(path)


def load_seed_urls(path: Path) -> list[str]:
    payload = load_seed_payload(path)
    urls = payload.get("urls") or []
    return [normalize_url(url) for url in urls if str(url).strip()]


def load_ndjson(path: Path) -> list[dict]:
    rows: list[dict] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def print_preview(items: list[str], limit: int = 20) -> None:
    for idx, item in enumerate(items[:limit], start=1):
        print(f"{idx:>2}. {item}")
    if len(items) > limit:
        print(f"... and {len(items) - limit} more")
