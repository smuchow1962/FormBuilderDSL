#!/usr/bin/env python
"""Stage FormBuilderDSL into a publish-ready npm-bundle/ directory.

Reads the source tree at the FormBuilderDSL repo root and assembles a
minimal staged copy under npm-bundle/. The staged copy contains exactly
what consumers need:

  - src/                     (the JS modules consumers `import`)
  - types/                   (the TypeScript declarations)
  - docs/                    (operator-facing docs that ride along)
  - README.md, LICENSE       (npm renders these on the package page)
  - package.json             (rewritten — see "Transformations")

Transformations applied to package.json:
  - `name` rewritten to `@{org}/{name}` (default org: mmpworks)
  - `publishConfig.access` set to "public" so the first scoped publish
    doesn't get rejected as "private package on free org"
  - Lifecycle + dev scripts (pretest, prepack, test, lint, docs:png)
    stripped — they reference scripts/ files that aren't in the bundle
  - `devDependencies` stripped — consumers never need them

Before copying src/, `node scripts/sync-version.mjs` runs in the
source tree so src/version-generated.js matches package.json's version.

Usage (from repo root):
    python tools/stage-npm.py
    python tools/stage-npm.py --org mmpworks
    python tools/stage-npm.py --org mmpworks --name formbuilder-dsl
    python tools/stage-npm.py --target some/other/dir
"""

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

# Files / directories copied verbatim from the source tree into the bundle.
# Note: `docs/` lives in the source repo for GitHub readers + maintainers,
# but does not ship in the npm tarball. The README links out to GitHub for
# every doc the user might want. `assets/` ships small README assets (the
# wireframe SVG) so the rendered README has working images without
# needing a cross-origin fetch from raw.githubusercontent.com.
COPY_DIRS = ("src", "types", "assets")
COPY_FILES = ("README.md", "LICENSE")

# Paths (relative to the source root) excluded from the staged bundle even
# when their parent directory is in COPY_DIRS. Empty for now — kept as a
# hook for future per-file exclusions.
EXCLUDE_PATHS: tuple[str, ...] = ()

# package.json keys stripped from the bundle (lifecycle + dev-only).
STRIP_SCRIPTS = (
    "pretest",
    "prepack",
    "test",
    "test:unit",
    "test:smoke",
    "test:properties",
    "lint",
    "docs:png",
)


def run_sync_version(source: Path) -> None:
    """Refresh src/version-generated.js so the bundle ships the right version."""
    script = source / "scripts" / "sync-version.mjs"
    if not script.exists():
        print(f"  sync-version.mjs not found at {script}; skipping version refresh.")
        return
    result = subprocess.run(
        ["node", str(script)],
        cwd=str(source),
        capture_output=True,
        text=True,
        shell=False,
    )
    if result.returncode != 0:
        print("  sync-version.mjs failed:")
        print(result.stdout)
        print(result.stderr)
        sys.exit(1)
    print(f"  sync-version: {result.stdout.strip()}")


def transform_package_json(source_pkg: dict, org: str, name: str) -> dict:
    """Return a copy of source_pkg with publish-time edits applied."""
    pkg = json.loads(json.dumps(source_pkg))  # deep-copy via round-trip

    pkg["name"] = f"@{org}/{name}"

    pkg.setdefault("publishConfig", {})["access"] = "public"

    if isinstance(pkg.get("scripts"), dict):
        pkg["scripts"] = {
            k: v for k, v in pkg["scripts"].items() if k not in STRIP_SCRIPTS
        }
        if not pkg["scripts"]:
            del pkg["scripts"]

    pkg.pop("devDependencies", None)

    return pkg


def stage(source: Path, target: Path, org: str, name: str) -> None:
    print(f"Source : {source}")
    print(f"Target : {target}")
    print(f"Scope  : @{org}/{name}")
    print()

    print("Refreshing version-generated.js in source...")
    run_sync_version(source)

    if target.exists():
        print(f"Wiping existing {target}...")
        shutil.rmtree(target)
    target.mkdir(parents=True)

    excluded = set(EXCLUDE_PATHS)

    def _ignore(directory: str, names: list[str]) -> list[str]:
        # Translate (directory, names) into rel-paths and drop any in EXCLUDE_PATHS.
        rel_dir = Path(directory).resolve().relative_to(source)
        return [n for n in names if str((rel_dir / n).as_posix()) in excluded]

    print("Copying directories:")
    for d in COPY_DIRS:
        src = source / d
        if not src.exists():
            print(f"  {d:15s} (missing in source — skipped)")
            continue
        dst = target / d
        shutil.copytree(src, dst, ignore=_ignore)
        print(f"  {d:15s} -> {dst.relative_to(target.parent)}")

    if excluded:
        print(f"  (excluded {len(excluded)} internal/unreferenced path"
              f"{'s' if len(excluded) != 1 else ''})")

    print("Copying files:")
    for f in COPY_FILES:
        src = source / f
        if not src.exists():
            print(f"  {f:15s} (missing in source — skipped)")
            continue
        dst = target / f
        shutil.copy2(src, dst)
        print(f"  {f:15s} -> {dst.relative_to(target.parent)}")

    print("Rewriting package.json...")
    source_pkg_path = source / "package.json"
    source_pkg = json.loads(source_pkg_path.read_text(encoding="utf-8"))
    staged_pkg = transform_package_json(source_pkg, org, name)
    target_pkg_path = target / "package.json"
    target_pkg_path.write_text(
        json.dumps(staged_pkg, indent=2) + "\n", encoding="utf-8"
    )
    print(f"  package.json   -> {target_pkg_path.relative_to(target.parent)}")
    print(f"     name:    {staged_pkg['name']}")
    print(f"     version: {staged_pkg['version']}")
    print(f"     access:  {staged_pkg['publishConfig']['access']}")

    print()
    print("Stage complete. Next: python tools/npm-test.py")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--org",
        default="mmpworks",
        help="npm organization scope (default: mmpworks).",
    )
    parser.add_argument(
        "--name",
        default="formbuilder-dsl",
        help="Unscoped package name (default: formbuilder-dsl).",
    )
    parser.add_argument(
        "--target",
        type=Path,
        default=REPO_ROOT / "npm-bundle",
        help="Output directory for the staged bundle (default: npm-bundle).",
    )
    parser.add_argument(
        "--source",
        type=Path,
        default=REPO_ROOT,
        help="Source FormBuilderDSL repo root (default: parent of tools/).",
    )
    args = parser.parse_args()

    source = args.source.resolve()
    target = args.target.resolve()

    if not (source / "package.json").exists():
        print(f"error: no package.json at {source}", file=sys.stderr)
        return 2

    stage(source, target, args.org, args.name)
    return 0


if __name__ == "__main__":
    sys.exit(main())
