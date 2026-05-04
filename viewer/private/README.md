# Private features

Everything in this directory is **internal to Herald** and not part of the public FormBuilderDSL viewer. It can stay in the repo without affecting the public-facing experience.

## How the gating works

The viewer reads a single URL flag at boot:

- `http://localhost:8080/viewer/` — public viewer; the bridge module never imports, the topbar buttons never paint, the chip never shows. This is the default.
- `http://localhost:8080/viewer/?show=1` — private features active; the bridge imports, the buttons appear with their purple `private-feature` styling, the chip shows the active sink.

The flag is read once at module load (see `viewer.js`'s `FLAGS` constant). Refreshing flips it. The decision happens before any rendering, so a curious user opening DevTools on the public URL doesn't see hidden buttons in the DOM either — the bridge module is never fetched and the CSS rule `body:not(.show-private) .private-feature { display: none }` is the belt-and-suspenders backup.

No file deletion is needed for a public release. The private features are off by default everywhere.

## What's in here

`sinks-bridge.js` - wires three buttons in the topbar plus a "currently editing" chip:

| Element | Where | Action |
|---|---|---|
| 🔒 **Open Sink** | top toolbar | Pick a Herald.Sinks.* sub-directory from a Vuetify dialog with search filter. Loads `configuration.mmpform` if present, otherwise a boilerplate template. |
| 🔒 **Import…** | top toolbar | One-off import from any directory containing `configuration.mmpform`. Doesn't track the source for export. |
| 🔒 **Export to Sink** | Object View toolbar | Writes `configuration.mmpform` + updates `CAPABILITY.yaml`. If a sink is open, writes to its directory directly. Otherwise prompts for a directory. |
| 📍 **Editing chip** | top toolbar | Purple chip on the topbar showing the active sink's directory name. Hidden when no sink is open. |

### How the sink picker works

1. On the first **Open Sink** click, the browser prompts for a directory. The user picks `Modules/Herald.Sinks/src/` (or wherever sink projects live).
2. The handle is stored in IndexedDB so subsequent reloads skip the picker. The browser still asks once per session for permission.
3. The dialog scans every sub-directory matching `Herald.Sinks.*` and shows them in a searchable Vuetify list. Each entry has:
   - Directory name (`Herald.Sinks.File`)
   - First line of `purpose:` from the sink's `CAPABILITY.yaml`
   - A green "has form" chip if `configuration.mmpform` already exists, gray "no form" otherwise.
4. Clicking a sink loads its `.mmpform` into the editor. Sinks without one get a sensible boilerplate that includes a static label for operator notes.
5. The active sink is shown on the topbar so the user always knows where Export will write.

### Capability YAML mutation

The export rewrites only three blocks: `formSchema:`, `formProperties:`, `formFunctions:`. Every other YAML key is preserved untouched. The blocks are bracketed with `# ----- Auto-generated -----` markers so a sink author hand-editing other sections of `CAPABILITY.yaml` keeps their changes.

### Browser support

All features rely on the File System Access API (`showDirectoryPicker`, `getFileHandle`, `createWritable`) plus IndexedDB for handle persistence. That's Chromium-only (Chrome / Edge / Brave). On Firefox / Safari the bridge logs an info message and the buttons don't appear.
