#!/usr/bin/env python
"""Pack the staged FormBuilderDSL bundle and verify it installs cleanly.

Runs three checks against npm-bundle/:

  1. `npm pack --dry-run` — prints the file list npm would publish so an
     operator can sanity-check what's about to ship.
  2. `npm pack` — produces the actual tarball in the bundle directory.
  3. Install probe — creates a temp directory, runs `npm init -y` +
     `npm install <tarball>`, then a `node -e` smoke that imports the
     package and prints its public exports. Catches missing files,
     broken `exports`, dependency mistakes, and any package.json field
     npm rejects at install time.

Exits non-zero on any failure; clean (returncode 0) means the bundle
is publish-ready.

Usage (from repo root):
    python tools/npm-test.py
    python tools/npm-test.py --bundle-dir npm-bundle
    python tools/npm-test.py --keep-tarball
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


def npm(args: list[str], cwd: Path, capture: bool = False) -> subprocess.CompletedProcess:
    """Wrapper that finds npm reliably on Windows + Unix."""
    npm_bin = shutil.which("npm") or shutil.which("npm.cmd")
    if npm_bin is None:
        print("error: `npm` not found on PATH.", file=sys.stderr)
        sys.exit(2)
    return subprocess.run(
        [npm_bin, *args],
        cwd=str(cwd),
        capture_output=capture,
        text=True,
        shell=False,
    )


def node_eval(code: str, cwd: Path) -> subprocess.CompletedProcess:
    """Run a small node -e script."""
    return subprocess.run(
        ["node", "-e", code],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        shell=False,
    )


def dry_run(bundle_dir: Path) -> None:
    print("=== npm pack --dry-run ===")
    result = npm(["pack", "--dry-run"], bundle_dir)
    if result.returncode != 0:
        sys.exit(result.returncode)


def pack(bundle_dir: Path) -> Path:
    print("=== npm pack ===")
    before = set(bundle_dir.glob("*.tgz"))
    result = npm(["pack"], bundle_dir, capture=True)
    if result.returncode != 0:
        print(result.stdout)
        print(result.stderr, file=sys.stderr)
        sys.exit(result.returncode)
    after = set(bundle_dir.glob("*.tgz"))
    new = sorted(after - before)
    if not new:
        print("error: npm pack produced no .tgz file", file=sys.stderr)
        sys.exit(2)
    tarball = new[-1]
    print(f"  -> {tarball.name} ({tarball.stat().st_size:,} bytes)")
    return tarball


def install_probe(tarball: Path, package_name: str) -> None:
    print("=== install probe ===")
    with tempfile.TemporaryDirectory(prefix="fbdsl-probe-") as tmp:
        tmp_dir = Path(tmp)
        print(f"  tempdir: {tmp_dir}")

        init = npm(["init", "-y"], tmp_dir, capture=True)
        if init.returncode != 0:
            print(init.stderr, file=sys.stderr)
            sys.exit(init.returncode)

        # `npm init -y` writes a fresh package.json that defaults to CommonJS;
        # we want ESM so `node -e "import(...)"` works without warnings.
        pkg_json_path = tmp_dir / "package.json"
        pkg_json = json.loads(pkg_json_path.read_text(encoding="utf-8"))
        pkg_json["type"] = "module"
        pkg_json_path.write_text(json.dumps(pkg_json, indent=2), encoding="utf-8")

        install = npm(["install", str(tarball)], tmp_dir, capture=True)
        if install.returncode != 0:
            print(install.stdout)
            print(install.stderr, file=sys.stderr)
            sys.exit(install.returncode)
        print(f"  npm install {tarball.name}: ok")

        smoke = node_eval(
            f"import('{package_name}').then(m => "
            f"console.log('exports:', Object.keys(m).sort().join(', ')))",
            tmp_dir,
        )
        if smoke.returncode != 0:
            print("smoke test failed:", file=sys.stderr)
            print(smoke.stdout)
            print(smoke.stderr, file=sys.stderr)
            sys.exit(smoke.returncode)
        print(f"  {smoke.stdout.strip()}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--bundle-dir",
        type=Path,
        default=REPO_ROOT / "npm-bundle",
        help="Staged bundle directory (default: npm-bundle).",
    )
    parser.add_argument(
        "--keep-tarball",
        action="store_true",
        help="Leave the .tgz in the bundle dir after the test (default: delete).",
    )
    args = parser.parse_args()

    bundle_dir = args.bundle_dir.resolve()
    if not (bundle_dir / "package.json").exists():
        print(f"error: no staged package.json at {bundle_dir}", file=sys.stderr)
        print("       run `python tools/stage-npm.py` first.", file=sys.stderr)
        return 2

    pkg = json.loads((bundle_dir / "package.json").read_text(encoding="utf-8"))
    package_name = pkg["name"]
    print(f"Bundle  : {bundle_dir}")
    print(f"Package : {package_name}@{pkg['version']}")
    print()

    dry_run(bundle_dir)
    print()

    tarball = pack(bundle_dir)
    print()

    try:
        install_probe(tarball, package_name)
    finally:
        if not args.keep_tarball:
            tarball.unlink(missing_ok=True)
            print(f"\nremoved {tarball.name}")
        else:
            print(f"\nkept {tarball.name}")

    print("\nAll checks passed. Bundle is publish-ready.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
