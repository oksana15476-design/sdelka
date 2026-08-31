#!/usr/bin/env python3
"""Environment checks for the crawl4ai-seo skill."""

from __future__ import annotations

import argparse
import importlib.util
import json
import subprocess
import shutil
import sys
from pathlib import Path

from common import (
    DEFAULTS_EXAMPLE_PATH,
    DEFAULTS_PATH,
    LEGACY_CONFIG_PATH,
    SKILL_DIR,
    load_defaults,
    resolve_skill_path,
)


def check_module(name: str) -> bool:
    return importlib.util.find_spec(name) is not None


def local_venv_python() -> Path:
    return SKILL_DIR / ".venv" / "bin" / "python"


def run_local_venv_probe() -> dict:
    python_bin = local_venv_python()
    if not python_bin.exists():
        return {
            "python_path": str(python_bin),
            "venv_exists": False,
            "crawl4ai_module": False,
            "playwright_module": False,
            "chromium_runtime": False,
            "chromium_path": None,
        }

    probe = """
import importlib.util
import json

payload = {
    "python_path": __import__("sys").executable,
    "venv_exists": True,
    "crawl4ai_module": importlib.util.find_spec("crawl4ai") is not None,
    "playwright_module": importlib.util.find_spec("playwright") is not None,
    "chromium_runtime": False,
    "chromium_path": None,
}

if payload["playwright_module"]:
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        chromium_path = p.chromium.executable_path
        payload["chromium_path"] = chromium_path
        payload["chromium_runtime"] = bool(chromium_path)

print(json.dumps(payload, ensure_ascii=False))
""".strip()
    try:
        result = subprocess.run(
            [str(python_bin), "-c", probe],
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        return {
            "python_path": str(python_bin),
            "venv_exists": True,
            "crawl4ai_module": False,
            "playwright_module": False,
            "chromium_runtime": False,
            "chromium_path": None,
            "probe_error": str(exc),
        }
    return json.loads(result.stdout)


def main() -> int:
    parser = argparse.ArgumentParser(description="Check local readiness for crawl4ai-seo.")
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON result.")
    parser.add_argument("--strict", action="store_true", help="Exit non-zero on warnings.")
    args = parser.parse_args()

    config = load_defaults()
    scrapedo_cfg = config.get("scrapedo", {})
    token_path = resolve_skill_path(scrapedo_cfg.get("token_file"))
    local_probe = run_local_venv_probe()
    system_crawl4ai = check_module("crawl4ai")
    system_playwright = check_module("playwright")
    runtime_ready = (system_crawl4ai and system_playwright) or (
        local_probe.get("crawl4ai_module")
        and local_probe.get("playwright_module")
        and local_probe.get("chromium_runtime")
    )

    checks = {
        "python": {
            "ok": sys.version_info >= (3, 10),
            "detail": sys.version.split()[0],
        },
        "uv": {
            "ok": shutil.which("uv") is not None,
            "detail": shutil.which("uv") or "not found",
        },
        "crawl4ai_module": {
            "ok": system_crawl4ai or bool(local_probe.get("crawl4ai_module")),
            "detail": (
                "installed in current python"
                if system_crawl4ai
                else (
                    f"available in local skill venv: {local_probe.get('python_path')}"
                    if local_probe.get("crawl4ai_module")
                    else "not installed"
                )
            ),
        },
        "playwright_module": {
            "ok": system_playwright or bool(local_probe.get("playwright_module")),
            "detail": (
                "installed in current python"
                if system_playwright
                else (
                    f"available in local skill venv: {local_probe.get('python_path')}"
                    if local_probe.get("playwright_module")
                    else "not installed"
                )
            ),
        },
        "playwright_chromium_runtime": {
            "ok": bool(local_probe.get("chromium_runtime")) or system_playwright,
            "detail": local_probe.get("chromium_path") or "not verified",
        },
        "local_skill_venv": {
            "ok": bool(local_probe.get("venv_exists")),
            "detail": local_probe.get("python_path") or "not present",
        },
        "defaults_example": {
            "ok": DEFAULTS_EXAMPLE_PATH.exists(),
            "detail": str(DEFAULTS_EXAMPLE_PATH) if DEFAULTS_EXAMPLE_PATH.exists() else "missing defaults.example.json",
        },
        "local_defaults_json": {
            "ok": True,
            "detail": str(DEFAULTS_PATH) if DEFAULTS_PATH.exists() else "optional; create only for local overrides",
        },
        "legacy_config_json": {
            "ok": True,
            "detail": str(LEGACY_CONFIG_PATH) if LEGACY_CONFIG_PATH.exists() else "not present",
        },
        "scrapedo_token_path": {
            "ok": (not scrapedo_cfg.get("enabled")) or (token_path is not None and token_path.exists()),
            "detail": str(token_path) if token_path else "not configured",
        },
    }

    overall_ok = (
        checks["python"]["ok"]
        and checks["uv"]["ok"]
        and runtime_ready
        and checks["defaults_example"]["ok"]
        and checks["scrapedo_token_path"]["ok"]
    )
    payload = {
        "ok": overall_ok,
        "checks": checks,
        "next_steps": [
            "Recommended local activation: uv venv .codex/skills/crawl4ai-seo/.venv --python 3.12",
            "Install runtime once: uv pip install --python .codex/skills/crawl4ai-seo/.venv/bin/python 'crawl4ai>=0.8,<0.9' playwright && .codex/skills/crawl4ai-seo/.venv/bin/python -m playwright install chromium",
            "Create config/defaults.json only if you need local overrides on top of defaults.example.json.",
            "Treat crawl4ai/playwright as manual activation, not auto-installed runtime.",
            "Create a job with init_job.py or let seed_urls.py/crawl_batch.py create one from launch params.",
        ],
    }

    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print("=== crawl4ai-seo doctor ===")
        for name, check in checks.items():
            status = "OK" if check["ok"] else "WARN"
            print(f"{status:>4}  {name}: {check['detail']}")
        print("")
        print("Overall:", "ready" if overall_ok else "scaffold-only / partial readiness")

    if overall_ok:
        return 0
    if args.strict:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
