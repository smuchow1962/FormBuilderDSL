#!/usr/bin/env python
"""Headless-browser smoke for the staged FormBuilderDSL npm bundle.

Loads the staged package's ESM into a real Chrome process the same way a
browser consumer would, then runs three suites against it:

  1. Surface check    — the seven entry points listed in package.json:exports
                        resolve and expose the names the README documents.
  2. README quick-start — the verbatim source from README.md "Quick start"
                        parses to ERR.OK.
  3. Sample suite     — every .mmpform file in editor/samples is parsed +
                        processed; each must return ERR.OK and produce an
                        AST root with a nodeKind.

How it works:
  - A ThreadingHTTPServer in this process serves three roots:
      /                     -> the generated harness HTML
      /pkg/<rest>           -> staged bundle (npm-bundle/) — src/, types/, …
      /samples/<rest>       -> editor/samples/ on the source tree
      POST /__report        -> harness POSTs its result JSON here
  - The harness HTML embeds an importmap built from the bundle's
    package.json exports so `import '@mmpworks/formbuilder-dsl'` and the
    six documented subpaths resolve in the browser without npm install.
  - Python launches Chrome headless against the harness URL, waits for
    the POST, kills Chrome, prints the report.

No new package dependencies. Uses the Chrome already on the machine.

Usage:
    python tools/npm-headless-test.py
    python tools/npm-headless-test.py --keep-alive       # leave server up to debug in a real browser
    python tools/npm-headless-test.py --chrome "C:/path/to/chrome.exe"
"""

from __future__ import annotations

import argparse
import http.server
import json
import os
import shutil
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

DEFAULT_BUNDLE = REPO_ROOT / "npm-bundle"
DEFAULT_SAMPLES = REPO_ROOT / "editor" / "samples"

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


def load_bundle_package_json(bundle: Path) -> dict:
    pkg_path = bundle / "package.json"
    if not pkg_path.exists():
        sys.exit(f"error: no package.json under {bundle} — run stage-npm.py first.")
    return json.loads(pkg_path.read_text(encoding="utf-8"))


def build_importmap(pkg: dict) -> dict:
    """Translate the bundle's package.json exports into a browser importmap.

    Each export entry like
        "./expression": { "types": ..., "import": "./src/expression.js" }
    becomes
        "@scope/name/expression": "/pkg/src/expression.js"

    The "." entry maps the bare package name. Subpath patterns are not
    supported — the bundle declares each subpath explicitly so this is fine.
    """
    name = pkg["name"]
    exports = pkg.get("exports", {})
    if not isinstance(exports, dict):
        sys.exit("error: bundle package.json has no 'exports' object.")

    imports: dict[str, str] = {}
    for subpath, conditions in exports.items():
        target = conditions.get("import") if isinstance(conditions, dict) else conditions
        if not isinstance(target, str):
            sys.exit(f"error: exports['{subpath}'] has no 'import' string.")
        rel = target.lstrip("./")  # "./src/index.js" -> "src/index.js"
        url = f"/pkg/{rel}"
        if subpath == ".":
            imports[name] = url
        else:
            tail = subpath.removeprefix("./")
            imports[f"{name}/{tail}"] = url
    return {"imports": imports}


def collect_samples(samples_dir: Path) -> list[str]:
    if not samples_dir.is_dir():
        sys.exit(f"error: samples directory does not exist: {samples_dir}")
    files = sorted(p.name for p in samples_dir.glob("*.mmpform"))
    if not files:
        sys.exit(f"error: no *.mmpform files found in {samples_dir}")
    return files


# --------------------------------------------------------------------------- #
# Harness HTML — kept inline so the tool is one file.                         #
# --------------------------------------------------------------------------- #

HARNESS_HTML = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>FormBuilderDSL headless smoke</title>
<script type="importmap">
__IMPORTMAP_JSON__
</script>
<style>
  body { font: 13px/1.4 system-ui, sans-serif; padding: 1rem; }
  pre  { white-space: pre-wrap; }
</style>
</head>
<body>
<h1>FormBuilderDSL headless smoke</h1>
<pre id="result">running...</pre>
<script type="module">
const SAMPLES = __SAMPLES_JSON__;
const PKG     = "__PKG_NAME__";

const out = { suites: [], pass: 0, fail: 0, version: null };

function record(name, ok, detail) {
  out.suites.push({ name, ok, detail: detail ?? "" });
  if (ok) out.pass++; else out.fail++;
}

async function postReport() {
  document.getElementById("result").textContent = JSON.stringify(out, null, 2);
  try {
    await fetch("/__report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(out),
    });
  } catch (e) {
    // Server may already be tearing down — best-effort post.
  }
}

try {
  // ---- Suite 1: import the seven entry points the package documents.
  const root   = await import(PKG);
  const expr   = await import(PKG + "/expression");
  const interp = await import(PKG + "/interpolate");
  const tf     = await import(PKG + "/text-fragment");
  const rp     = await import(PKG + "/render-preview");
  const is     = await import(PKG + "/infer-schema");
  const pc     = await import(PKG + "/property-collector");

  out.version = root.VERSION ?? null;

  record("root: TextFormBuilder is a class",       typeof root.TextFormBuilder === "function");
  record("root: ERR is an object",                  typeof root.ERR === "object" && root.ERR !== null);
  record("root: VERSION is a non-empty string",    typeof root.VERSION === "string" && root.VERSION.length > 0,
                                                   root.VERSION ?? "");
  record("root: errorName(ERR.OK) === 'OK'",       root.errorName(root.ERR.OK) === "OK");
  record("root: defaultControlSpec object",        typeof root.defaultControlSpec === "object" && root.defaultControlSpec !== null);
  record("root: isReserved('container') === true", root.isReserved("container") === true);
  record("root: TupleResponse.ok exists",          typeof root.TupleResponse?.ok === "function");

  record("expression: parseWhen + evaluateWhen",   typeof expr.parseWhen === "function" && typeof expr.evaluateWhen === "function");
  record("interpolate: function exported",         typeof interp.interpolate === "function");
  record("text-fragment: parseDecorated + renderFragments",
                                                   typeof tf.parseDecorated === "function" && typeof tf.renderFragments === "function");
  record("render-preview: renderFormPreview",      typeof rp.renderFormPreview === "function");
  record("infer-schema: inferDataSchema + scaffoldDataObject",
                                                   typeof is.inferDataSchema === "function" && typeof is.scaffoldDataObject === "function");
  record("property-collector: collectProperties + renderPropertiesBlock",
                                                   typeof pc.collectProperties === "function" && typeof pc.renderPropertiesBlock === "function");

  // ---- Suite 2: the README "Quick start" example, verbatim.
  const quickStart =
    'columns: 10\n' +
    '\n' +
    'levels = ["Debug", "Info", "Warn"] -> {logLevel}\n' +
    '\n' +
    '[container({title})]\n' +
    '  - [select(5,#levels,{logLevel})] Log level\n';

  const qs = new root.TextFormBuilder({ schemaText: quickStart }).parse();
  record("README quick-start parses to ERR.OK",
         qs.error === root.ERR.OK,
         qs.error === root.ERR.OK ? "" : (qs.messages || []).slice(0, 3).join(" | "));

  // ---- Suite 3: every editor/samples/*.mmpform must parse + process clean.
  for (const name of SAMPLES) {
    let label = "sample: " + name;
    try {
      const text = await (await fetch("/samples/" + name)).text();

      const parsed = new root.TextFormBuilder({ schemaText: text }).parse();
      const okParse = parsed.error === root.ERR.OK
        && parsed.payload?.root
        && typeof parsed.payload.root.nodeKind === "string";
      record(label + " — parse()", okParse,
             okParse ? "" : (parsed.messages || []).slice(0, 3).join(" | "));

      const processed = new root.TextFormBuilder({ schemaText: text }).process();
      const okProcess = processed.error === root.ERR.OK
        && processed.payload?.__properties
        && typeof processed.payload.__properties === "object";
      record(label + " — process()", okProcess,
             okProcess ? "" : (processed.messages || []).slice(0, 3).join(" | "));
    } catch (e) {
      record(label, false, String(e?.stack || e));
    }
  }
} catch (e) {
  record("fatal exception during suite", false, String(e?.stack || e));
}

await postReport();
</script>
</body>
</html>
"""


# --------------------------------------------------------------------------- #
# HTTP server — three roots + a POST callback.                                 #
# --------------------------------------------------------------------------- #

class HarnessServerState:
    """Shared state between the request handler and the main thread."""

    def __init__(self, harness_html: str, bundle: Path, samples: Path) -> None:
        self.harness_html = harness_html.encode("utf-8")
        self.bundle = bundle
        self.samples = samples
        self.report: dict | None = None
        self.report_event = threading.Event()


def make_handler(state: HarnessServerState) -> type[http.server.BaseHTTPRequestHandler]:
    """Build a handler class bound to this run's state.

    `http.server` instantiates the handler class per-request, which is why
    we close over `state` here instead of stashing it on the class.
    """

    bundle_root = state.bundle.resolve()
    samples_root = state.samples.resolve()

    # Map of file extension -> Content-Type. Covers what the suite serves.
    MIME = {
        ".js":      "text/javascript; charset=utf-8",
        ".mjs":     "text/javascript; charset=utf-8",
        ".json":    "application/json; charset=utf-8",
        ".html":    "text/html; charset=utf-8",
        ".css":     "text/css; charset=utf-8",
        ".mmpform": "text/plain; charset=utf-8",
        ".d.ts":    "text/plain; charset=utf-8",
    }

    def _safe_join(root: Path, rel_url: str) -> Path | None:
        """Resolve `root + rel_url` and refuse paths that escape `root`.

        Reduces Cognitive Complexity in do_GET by isolating the path-traversal
        guard. Returns None on traversal attempts so the handler can 403.
        """
        rel = rel_url.lstrip("/")
        candidate = (root / rel).resolve()
        try:
            candidate.relative_to(root)
        except ValueError:
            return None
        return candidate

    class Handler(http.server.BaseHTTPRequestHandler):
        # Silence the per-request access log — the suite's report is the
        # interesting output, the request stream is noise.
        def log_message(self, format: str, *args) -> None:  # noqa: A002
            return

        def _send_bytes(self, status: int, body: bytes, content_type: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _send_file(self, path: Path) -> None:
            if not path.is_file():
                self._send_bytes(404, b"not found", "text/plain; charset=utf-8")
                return
            mime = MIME.get(path.suffix, "application/octet-stream")
            self._send_bytes(200, path.read_bytes(), mime)

        def do_GET(self) -> None:
            url = self.path.split("?", 1)[0]

            # Root -> the harness page itself.
            if url == "/" or url == "/index.html":
                self._send_bytes(200, state.harness_html, "text/html; charset=utf-8")
                return

            # Bundle is mounted at /pkg/ so the importmap can resolve
            # @scope/name -> /pkg/src/index.js.
            if url.startswith("/pkg/"):
                target = _safe_join(bundle_root, url[len("/pkg/"):])
                if target is None:
                    self._send_bytes(403, b"forbidden", "text/plain; charset=utf-8")
                    return
                self._send_file(target)
                return

            # Samples are mounted separately because they live outside
            # the bundle (the bundle ships only src/ + types/).
            if url.startswith("/samples/"):
                target = _safe_join(samples_root, url[len("/samples/"):])
                if target is None:
                    self._send_bytes(403, b"forbidden", "text/plain; charset=utf-8")
                    return
                self._send_file(target)
                return

            self._send_bytes(404, b"not found", "text/plain; charset=utf-8")

        def do_POST(self) -> None:
            if self.path != "/__report":
                self._send_bytes(404, b"not found", "text/plain; charset=utf-8")
                return
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length > 0 else b""
            try:
                state.report = json.loads(raw.decode("utf-8"))
            except json.JSONDecodeError as e:
                state.report = {"error": "invalid JSON", "detail": str(e), "raw": raw.decode("utf-8", "replace")}
            state.report_event.set()
            self._send_bytes(200, b'{"ok":true}', "application/json")

    return Handler


class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def find_free_port(preferred: int) -> int:
    if preferred != 0:
        return preferred
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# --------------------------------------------------------------------------- #
# Reporting                                                                    #
# --------------------------------------------------------------------------- #

def print_report(report: dict) -> int:
    """Print the suite report; return process exit code."""
    if report is None:
        print("FAIL: no report received from harness.")
        return 1
    if "error" in report and "suites" not in report:
        print(f"FAIL: invalid harness payload — {report.get('error')}")
        if "raw" in report:
            print(report["raw"][:500])
        return 1

    suites = report.get("suites", [])
    pass_count = report.get("pass", 0)
    fail_count = report.get("fail", 0)
    version = report.get("version")

    print(f"Bundle version: {version}")
    print(f"Total: {len(suites)} | pass: {pass_count} | fail: {fail_count}")
    print()
    for s in suites:
        marker = "OK  " if s["ok"] else "FAIL"
        line = f"  [{marker}] {s['name']}"
        if not s["ok"] and s.get("detail"):
            line += f"\n         -> {s['detail']}"
        print(line)
    print()
    if fail_count == 0:
        print("All headless checks passed.")
        return 0
    print(f"FAILED: {fail_count} check(s) failed.")
    return 1


# --------------------------------------------------------------------------- #
# Main                                                                         #
# --------------------------------------------------------------------------- #

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle",  type=Path, default=DEFAULT_BUNDLE,
                        help=f"Path to staged npm bundle (default: {DEFAULT_BUNDLE.name}).")
    parser.add_argument("--samples", type=Path, default=DEFAULT_SAMPLES,
                        help="Path to .mmpform samples (default: editor/samples).")
    parser.add_argument("--chrome",  type=str,  default=None,
                        help="Path to Chrome / Edge binary (default: auto-detect).")
    parser.add_argument("--port",    type=int,  default=0,
                        help="HTTP port (default: 0, kernel-assigned).")
    parser.add_argument("--timeout", type=int,  default=60,
                        help="Seconds to wait for harness report (default: 60).")
    parser.add_argument("--keep-alive", action="store_true",
                        help="Leave server running after the report so you can hit the URL in a real browser.")
    args = parser.parse_args()

    bundle = args.bundle.resolve()
    samples = args.samples.resolve()

    pkg = load_bundle_package_json(bundle)
    importmap = build_importmap(pkg)
    sample_names = collect_samples(samples)

    print(f"Bundle  : {bundle}")
    print(f"Samples : {samples} ({len(sample_names)} file(s))")
    print(f"Package : {pkg['name']}@{pkg['version']}")
    print()

    chrome = find_chrome(args.chrome)
    print(f"Chrome  : {chrome}")

    harness = (
        HARNESS_HTML
        .replace("__IMPORTMAP_JSON__", json.dumps(importmap, indent=2))
        .replace("__SAMPLES_JSON__",   json.dumps(sample_names))
        .replace("__PKG_NAME__",       pkg["name"])
    )

    state = HarnessServerState(harness, bundle, samples)
    handler = make_handler(state)

    port = find_free_port(args.port)
    server = ThreadingServer(("127.0.0.1", port), handler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()

    url = f"http://127.0.0.1:{port}/"
    print(f"Server  : {url}")
    print()

    user_data_dir = Path(tempfile.mkdtemp(prefix="fbdsl-headless-"))
    chrome_args = [
        chrome,
        "--headless=new",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-background-networking",
        "--no-first-run",
        "--no-default-browser-check",
        f"--user-data-dir={user_data_dir}",
        url,
    ]

    print("Launching headless Chrome...")
    chrome_proc = subprocess.Popen(
        chrome_args,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    deadline = time.monotonic() + args.timeout
    try:
        while time.monotonic() < deadline:
            if state.report_event.wait(timeout=0.5):
                break
            if chrome_proc.poll() is not None and not state.report_event.is_set():
                # Browser died before posting — give the server a beat to flush
                # in case the POST is mid-flight, then bail.
                state.report_event.wait(timeout=2)
                break
        if not state.report_event.is_set():
            print(f"FAIL: harness did not POST a report within {args.timeout}s.")
    finally:
        if chrome_proc.poll() is None:
            chrome_proc.terminate()
            try:
                chrome_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                chrome_proc.kill()
        if not args.keep_alive:
            server.shutdown()
        shutil.rmtree(user_data_dir, ignore_errors=True)

    exit_code = print_report(state.report)

    if args.keep_alive:
        print()
        print(f"--keep-alive: server still up at {url} — Ctrl+C to stop.")
        try:
            server_thread.join()
        except KeyboardInterrupt:
            server.shutdown()
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
