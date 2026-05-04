#!/usr/bin/env python
"""Publish the staged FormBuilderDSL bundle to npm.

Reads a granular access token from disk (default:
E:\\dev\\access-tokens\\npm-mmpworks.txt), drops a temporary .npmrc into
the bundle directory with that token, runs `npm publish --access public`
from the bundle, and removes the .npmrc again on the way out.

The token must be a granular npm access token with publish permission
on the target organization AND with bypass-2FA enabled — `npm publish`
does not prompt for OTP when the token has 2FA bypass.

Use `--dry-run` to preview the publish without uploading. The default
is the same `npm publish --dry-run` invocation that npm itself runs in
verification mode: pack the tarball, contact the registry, but do not
actually push.

Usage (from repo root):
    python tools/npm-publish.py --dry-run
    python tools/npm-publish.py
    python tools/npm-publish.py --token-file path/to/token.txt
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_TOKEN_FILE = Path(r"E:\dev\access-tokens\npm-mmpworks.txt")
REGISTRY = "https://registry.npmjs.org/"


def npm(args: list[str], cwd: Path, env: dict[str, str] | None = None,
        capture: bool = False) -> subprocess.CompletedProcess:
    npm_bin = shutil.which("npm") or shutil.which("npm.cmd")
    if npm_bin is None:
        print("error: `npm` not found on PATH.", file=sys.stderr)
        sys.exit(2)
    full_env = {**os.environ, **(env or {})}
    return subprocess.run(
        [npm_bin, *args],
        cwd=str(cwd),
        env=full_env,
        capture_output=capture,
        text=True,
        shell=False,
    )


def read_token(path: Path) -> str:
    if not path.exists():
        print(f"error: token file not found at {path}", file=sys.stderr)
        sys.exit(2)
    token = path.read_text(encoding="utf-8").strip()
    if not token:
        print(f"error: token file at {path} is empty", file=sys.stderr)
        sys.exit(2)
    if any(c.isspace() for c in token):
        print(f"error: token file at {path} contains whitespace inside the token",
              file=sys.stderr)
        sys.exit(2)
    return token


def write_npmrc(bundle_dir: Path, token: str) -> Path:
    """Write a .npmrc inside the bundle dir wiring the registry to the token."""
    npmrc = bundle_dir / ".npmrc"
    body = (
        f"registry={REGISTRY}\n"
        f"//registry.npmjs.org/:_authToken={token}\n"
        f"always-auth=true\n"
    )
    npmrc.write_text(body, encoding="utf-8")
    # Best-effort tighten on POSIX; on Windows the API is a no-op for
    # most paths but the call is still safe.
    try:
        os.chmod(npmrc, 0o600)
    except OSError:
        pass
    return npmrc


def whoami(bundle_dir: Path) -> str | None:
    """Verify the registry accepts the token before we attempt to publish."""
    result = npm(
        ["whoami", "--registry", REGISTRY],
        bundle_dir,
        capture=True,
    )
    if result.returncode != 0:
        print("whoami failed:", file=sys.stderr)
        print(result.stdout)
        print(result.stderr, file=sys.stderr)
        return None
    return result.stdout.strip()


def publish(bundle_dir: Path, dry_run: bool) -> int:
    args = ["publish", "--access", "public"]
    if dry_run:
        args.append("--dry-run")
    print(f"=== npm {' '.join(args)} ===")
    result = npm(args, bundle_dir)
    return result.returncode


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--bundle-dir",
        type=Path,
        default=REPO_ROOT / "npm-bundle",
        help="Staged bundle directory (default: npm-bundle).",
    )
    parser.add_argument(
        "--token-file",
        type=Path,
        default=DEFAULT_TOKEN_FILE,
        help=f"Path to a file containing the npm access token "
             f"(default: {DEFAULT_TOKEN_FILE}).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Run `npm publish --dry-run` — registry contact + verification only.",
    )
    args = parser.parse_args()

    bundle_dir = args.bundle_dir.resolve()
    if not (bundle_dir / "package.json").exists():
        print(f"error: no staged package.json at {bundle_dir}", file=sys.stderr)
        print("       run `python tools/stage-npm.py` first.", file=sys.stderr)
        return 2

    pkg = json.loads((bundle_dir / "package.json").read_text(encoding="utf-8"))
    print(f"Bundle  : {bundle_dir}")
    print(f"Package : {pkg['name']}@{pkg['version']}")
    print(f"Token   : {args.token_file}")
    print(f"Dry-run : {args.dry_run}")
    print()

    token = read_token(args.token_file)
    npmrc_path = write_npmrc(bundle_dir, token)
    try:
        user = whoami(bundle_dir)
        if user is None:
            return 1
        print(f"Authenticated as: {user}")
        print()
        rc = publish(bundle_dir, args.dry_run)
        if rc != 0:
            print(f"\npublish failed with exit code {rc}", file=sys.stderr)
            return rc
        if args.dry_run:
            print("\nDry-run completed. Re-run without --dry-run to push for real.")
        else:
            print(f"\nPublished {pkg['name']}@{pkg['version']}.")
        return 0
    finally:
        # Always remove the .npmrc — keeps the token from sitting on disk
        # in a directory that might get tarred or re-staged.
        npmrc_path.unlink(missing_ok=True)


if __name__ == "__main__":
    sys.exit(main())
