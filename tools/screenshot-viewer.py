#!/usr/bin/env python
"""Headless screenshot of the FormBuilderDSL viewer.

Spawns a local HTTP server rooted at the repo so the viewer can resolve
`../src/index.js` and the bundled samples, then launches Chrome headless
with the chosen sample preloaded via the share-hash URL fragment. The
viewer's existing decodeShareHash + setEditorText path renders the form
on load; Chrome's --screenshot flag writes a PNG. No new dependencies.

How it works:
  - The repo root is served at /, so /viewer/index.html, /src/index.js,
    and /editor/samples/* all resolve from the same origin without
    extra mount-point juggling.
  - The sample file is gzip+base64-url encoded in Python the same way
    viewer.js's encodeShareHash does it. Append #share=<encoded> to the
    URL and the viewer treats the load like a real share link.
  - --virtual-time-budget advances JS time so promises, timers, and the
    Vue/Vuetify mount complete before Chrome takes the screenshot.

Usage:
    python tools/screenshot-viewer.py
    python tools/screenshot-viewer.py --sample full-example.mmpform
    python tools/screenshot-viewer.py --output docs/assets/screenshots/viewer.png
    python tools/screenshot-viewer.py --width 1920 --height 1080
"""

from __future__ import annotations

import argparse
import base64
import functools
import gzip
import http.server
import shutil
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

DEFAULT_SAMPLE = REPO_ROOT / "editor" / "samples" / "full-example.mmpform"
DEFAULT_OUTPUT = REPO_ROOT / "docs" / "assets" / "screenshots" / "viewer-full-example.png"
DEFAULT_WIDTH = 1600
DEFAULT_HEIGHT = 900
DEFAULT_BUDGET_MS = 15000

# Chrome binary search list. First hit wins. Override with --chrome.
CHROME_CANDIDATES = (
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
)


def find_chrome(override: str | None) -> str:
    if override:
        if not Path(override).exists():
            sys.exit(f"error: --chrome path does not exist: {override}")
        return override
    for candidate in CHROME_CANDIDATES:
        if Path(candidate).exists():
            return candidate
    sys.exit("error: could not locate Chrome / Edge. Pass --chrome <path>.")


def encode_share_hash(text: str) -> str:
    """Match viewer.js encodeShareHash: gzip + URL-safe base64 without padding.

    The viewer's decoder does the inverse, then calls setEditorText, which
    runs process() — that parses + renders the form before Chrome captures.
    """
    gz = gzip.compress(text.encode("utf-8"))
    return base64.urlsafe_b64encode(gz).rstrip(b"=").decode("ascii")


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    """SimpleHTTPRequestHandler with the per-request log silenced."""

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        return


def find_free_port(preferred: int) -> int:
    if preferred != 0:
        return preferred
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--sample", type=Path, default=DEFAULT_SAMPLE,
        help=f"Path to the .mmpform sample (default: {DEFAULT_SAMPLE.name}).",
    )
    parser.add_argument(
        "--output", type=Path, default=DEFAULT_OUTPUT,
        help="Output PNG path (parent directories are created if missing).",
    )
    parser.add_argument(
        "--width",  type=int, default=DEFAULT_WIDTH,
        help=f"Viewport width in CSS pixels (default: {DEFAULT_WIDTH}).",
    )
    parser.add_argument(
        "--height", type=int, default=DEFAULT_HEIGHT,
        help=f"Viewport height in CSS pixels (default: {DEFAULT_HEIGHT}).",
    )
    parser.add_argument(
        "--budget", type=int, default=DEFAULT_BUDGET_MS,
        help=f"Virtual time budget in ms — advances JS time before capture (default: {DEFAULT_BUDGET_MS}).",
    )
    parser.add_argument(
        "--chrome", type=str, default=None,
        help="Path to Chrome / Edge binary (default: auto-detect).",
    )
    parser.add_argument(
        "--port", type=int, default=0,
        help="HTTP port (default: 0, kernel-assigned).",
    )
    args = parser.parse_args()

    sample = args.sample.resolve()
    if not sample.is_file():
        sys.exit(f"error: sample does not exist: {sample}")

    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)

    text = sample.read_text(encoding="utf-8")
    share_hash = encode_share_hash(text)

    chrome = find_chrome(args.chrome)

    print(f"Sample  : {sample}")
    print(f"Output  : {output}")
    print(f"Chrome  : {chrome}")
    print(f"Window  : {args.width}x{args.height}")

    # Serve REPO_ROOT so /viewer, /src, and /editor/samples all resolve
    # from one origin. Same-origin keeps the share-hash decode path clean
    # (no CORS surprises) and keeps the viewer's `import '../src/...'`
    # resolution working as-is.
    port = find_free_port(args.port)
    handler = functools.partial(QuietHandler, directory=str(REPO_ROOT))
    server = ThreadingServer(("127.0.0.1", port), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    url = f"http://127.0.0.1:{port}/viewer/index.html#share={share_hash}"
    print(f"URL     : http://127.0.0.1:{port}/viewer/index.html#share=<{len(share_hash)} chars>")
    print()

    user_data_dir = Path(tempfile.mkdtemp(prefix="fbdsl-screenshot-"))
    try:
        chrome_args = [
            chrome,
            "--headless=new",
            "--disable-gpu",
            "--disable-extensions",
            "--disable-background-networking",
            "--no-first-run",
            "--no-default-browser-check",
            "--hide-scrollbars",
            f"--user-data-dir={user_data_dir}",
            f"--window-size={args.width},{args.height}",
            f"--virtual-time-budget={args.budget}",
            f"--screenshot={output}",
            url,
        ]
        print("Launching headless Chrome...")
        # Wall-clock cap = budget + 30s slack for Chrome startup, CDN
        # fetches, and shutdown. Without this an unreachable CDN would
        # hang the tool indefinitely.
        timeout_s = args.budget // 1000 + 30
        proc = subprocess.run(
            chrome_args,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=timeout_s,
            check=False,
        )
        if not output.is_file():
            print(f"FAIL: Chrome did not write {output} (exit {proc.returncode}).")
            return 1
        size = output.stat().st_size
        if size < 1024:
            print(f"WARN: {output} is only {size} bytes — render may have failed.")
        print(f"OK: wrote {output} ({size:,} bytes)")
        return 0
    except subprocess.TimeoutExpired:
        print(f"FAIL: Chrome did not finish within {timeout_s}s.")
        return 1
    finally:
        server.shutdown()
        shutil.rmtree(user_data_dir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
