# tools/

Helpers for FormBuilderDSL maintainers. The publish pipeline (stage,
test, publish) is Python; the manifest-folder smoke check is a Node
ESM tool because it exercises the parser's public JS API directly.

## stage-npm.py

Assembles a publish-ready `npm-bundle/` directory from the source
tree. Refreshes `src/version-generated.js`, copies the public files
(`src/`, `types/`, `docs/`, `README.md`, `LICENSE`), and rewrites
`package.json` for the scoped publish — sets the scoped name, marks
`publishConfig.access: public`, strips the dev-only scripts +
`devDependencies`.

```bash
python tools/stage-npm.py                       # @mmpworks/formbuilder-dsl
python tools/stage-npm.py --org otherorg        # @otherorg/formbuilder-dsl
python tools/stage-npm.py --name fb-dsl         # @mmpworks/fb-dsl
```

## npm-test.py

Verifies the staged bundle is install-clean. Runs `npm pack --dry-run`
to show what would ship, runs `npm pack` to produce the actual tarball,
and installs the tarball into a fresh tempdir, then loads it via a
`node -e` smoke that lists the public exports. Catches missing files,
broken `exports`, and any field npm rejects at install time.

```bash
python tools/npm-test.py
python tools/npm-test.py --keep-tarball         # leave the .tgz behind
```

## npm-headless-test.py

Loads the staged bundle into a real headless Chrome the way a browser
consumer would, then runs three suites against it: the seven entry
points listed in `package.json:exports` resolve and expose the names
the README documents, the verbatim README "Quick start" example
parses, and every `editor/samples/*.mmpform` parses + processes
clean. No new dependencies — uses the Chrome already on the machine.

```bash
python tools/npm-headless-test.py
python tools/npm-headless-test.py --keep-alive       # leave the harness URL up for browser debug
python tools/npm-headless-test.py --chrome "C:/path/to/chrome.exe"
```

## screenshot-viewer.py

Captures a PNG of the viewer with a chosen `.mmpform` sample preloaded.
Spawns a local HTTP server rooted at the repo, encodes the sample as a
share-hash URL (the same encoding the viewer's "Share" button produces),
and launches headless Chrome with `--screenshot --virtual-time-budget`
so promises and Vue/Vuetify mount complete before capture. Output lands
at `docs/assets/screenshots/viewer-full-example.png` by default.

```bash
python tools/screenshot-viewer.py
python tools/screenshot-viewer.py --sample simple-label.mmpform
python tools/screenshot-viewer.py --output docs/assets/screenshots/custom.png
python tools/screenshot-viewer.py --width 1920 --height 1080
```

## npm-publish.py

Publishes the staged bundle. Reads a granular access token from disk
(default `E:\dev\access-tokens\npm-mmpworks.txt`), drops a temporary
`.npmrc` with the token into the bundle dir, runs `npm publish
--access public`, then removes the `.npmrc`.

The token must have publish permission on the target organization AND
bypass-2FA enabled — `npm publish` does not prompt for OTP when the
token carries 2FA bypass.

```bash
python tools/npm-publish.py --dry-run           # registry contact only
python tools/npm-publish.py                     # publish for real
python tools/npm-publish.py --token-file path/to/token.txt
```

## smoke-parse.mjs

Parses every `.mmpform` in a target directory through the public
`TextFormBuilder` and reports per-file tooltip counts. Use it from
any consumer that ships a manifest folder (Core's pipeline manifests,
Sinks' per-sink forms, etc.) to confirm an edit didn't break the
grammar before the bytes reach the dashboard.

```bash
node tools/smoke-parse.mjs ../Core/manifests/pipeline
node tools/smoke-parse.mjs ../Herald.Sinks/SignalFx/manifests
```

Exits non-zero on any parse failure, so it slots cleanly into a
pre-commit hook or CI step. Probes `result.payload.tooltips` (the
post-rewrite tooltip map); `_rawTooltips` is a parser scratch field
deleted before the model is returned.

## Typical workflow

```bash
python tools/stage-npm.py
python tools/npm-test.py
python tools/npm-headless-test.py
python tools/npm-publish.py --dry-run
python tools/npm-publish.py
```
