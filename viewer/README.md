# FormBuilder DSL — Viewer

A vanilla-JS, no-build playground for editing `.mmpform` files. Two-panel split: an Ace source editor on the left, a tabbed Render Preview / Object View / Live Data on the right.

The viewer ships in the GitHub repo as the reference renderer for `@mmpworks/formbuilder-dsl`. It is NOT in the npm tarball.

## What it does

### Source pane
An Ace editor with a custom `mmpform` mode (`mmpform-mode.js`). Edit, toggle word wrap, and click **Process** (or press `Ctrl+Enter`) to re-parse. The editor handles its own gutter, line numbers, fold widgets, undo/redo, multi-line indent, search/replace, and multi-cursor.

### Render Preview tab
Pick a renderer from the Framework dropdown:
- **Vue 3 / Vuetify 3** (default) — mounts a real Vuetify form bound to a reactive data object built from the inferred schema. The form is interactive: typing into a `v-text-field` updates the in-memory model. Each control type maps to its natural Vuetify component (`v-text-field`, `v-textarea`, `v-checkbox`, `v-switch`, `v-select`, `v-combobox`, `v-radio-group`, `v-slider`, `v-file-input`, `v-expansion-panels`, etc.). Compound controls (file size, color with null swatch, daterange, directory browser) have considered defaults. Tooltips render through `v-tooltip`. Vue 3 + Vuetify 3 are loaded via CDN.
- **ASCII** — text preview at a configurable width.
- **Plain HTML** — placeholder, not yet implemented.

The Vue mount tears down on every Process so subscriptions don't leak across re-renders.

### Object View tab
A read-only Ace editor showing the data shape derived from the AST. Pick a format (JS Class / JS Object / TypeScript / Raw JSON / Vue SFC stub / React JSX stub / JSON Schema) and a name, then **Copy** to clipboard or **Save…** to the appropriate extension. The fold-all checkbox starts every render collapsed; the unfold-all button expands everything.

The seven formats split into two groups:
- **Schema-only** — JS Class, JS Object, TypeScript, Raw JSON, JSON Schema. Describe the data shape; copy into your validator or persistence layer.
- **Component stubs** — Vue SFC, React JSX. Starter components that import the package, parse an inline `.mmpform` source, and seed a reactive data object. Replace the inline source with your own and write the walker over `ast.root` that maps each control to a framework component.

### Live Data tab
A reactive JSON view of the form's bound data. Edit a field in the Render Preview, watch the JSON change. Useful for understanding what the consumer's data object will look like at runtime.

### Form-state undo / redo
Edits to the rendered form (only the Vuetify renderer) are tracked in an in-memory history. The toolbar shows three buttons (`↶ Undo`, `↷ Redo`, `Reset form`) plus an "N edits" badge that counts edits since the last Process pass. Keyboard: `Ctrl+Z` / `Ctrl+Y` walk the history when focus is inside the rendered form (anywhere — input, button, drag handle, or the listManager dialog overlay).

The history captures one snapshot per debounced burst of edits (default 350 ms). Snapshots are deep-cloned via `structuredClone`; `File`, `Blob`, and `FileList` values are pre-processed into JSON-stable markers so two distinct file picks dedup as different. The buffer caps at 32 entries; the oldest non-seed entry drops when the cap fires, so the seed (the post-Process state) stays pinned at index 0 forever.

`Reset form` jumps the cursor to the seed in O(1) and truncates the redo branch — the pre-reset edits are gone (Reset is not undoable via Redo). Reset toasts a confirmation; Undo and Redo are intentionally toast-free since the badge update plus the visible form change are already enough signal.

The listManager search field (a transient filter, not part of the form data) is excluded from the history shortcut so its native text undo still works. The renderer marks every data-bound input with an `id="fb-input-..."`; only those trigger form-undo. Focused buttons (the row Edit/Delete icons, the drag handle) don't carry that id, so Ctrl+Z on a button is a no-op — matching the user's expectation that buttons aren't undoable.

### Live preview + form data
With **Live preview** on, every keystroke in the source pane runs Process after a 300 ms pause. The new mount inherits the user's current edits via a structural merge — bindings the new schema still holds keep their values; bindings the new schema removed disappear; bindings the new schema added keep their fresh defaults. The form-history is reset on each re-process (the seed is the merged state), so undo from a live-preview tick walks back to the post-merge state, not all-defaults.

The merge has two shape rules worth knowing:
- **Type-flipped bindings keep the new seed.** A binding whose schema flipped from textfield (string) to daterange (object) — or any object↔primitive flip — discards the user's old value and shows the new shape's default. Planting the wrong-shape value would render as blank or worse.
- **Compute={@fn} bindings keep the new seed.** The renderer's watchEffect owns those values; the merge skips them so the next computation result doesn't get shadowed by a stale snapshot.

### fileSize binding shapes
The `fileSize` control's binding is a single string. The expected shape is `<amount><unit>` (e.g. `"1.5Mb"`), but the binding can also hold:
- the empty string `""` when both amount and unit are at their defaults,
- a unit alone (e.g. `"Gb"`) when the user picked a unit before entering an amount.

Consumer parsers should accept all three. A `parseFloat(binding)` returns `NaN` for the unit-only case — handle the `NaN` branch by treating the value as "not yet set."

### Open / Save
Modern browsers (Chrome / Edge / Brave) save back to the same handle via the File System Access API. Firefox / Safari fall back to download / upload.

### `__properties` round-trip
Process collects bindings, runs the package's `mergeProperties`, and writes the canonical `__properties` block back into the source. Cursor and scroll positions are preserved across the rewrite. The splice is bracket-aware so a `]` inside a string default does not chop the user's source. Toggle off **Auto-sync `__properties`** in the toolbar to opt out — useful when you're hand-editing the block and don't want Process to overwrite your edits.

### Share link
Click **Share** to copy a URL with the current source compressed into the hash (`#share=…`). Anyone opening that URL in a CompressionStream-capable browser (Chromium 80+, Firefox 113+, Safari 16.4+) gets the same source loaded into the editor on first paint.

### Editor row markers
When Process fails, the editor highlights every row that the parse-error messages reference. Markers clear at the start of every Process pass so a successful re-parse drops them automatically.

## Run it

The viewer uses ES module imports from `../src/`, so it needs a static HTTP server (browsers reject ESM under `file://`).

```bash
# from the FormBuilderDSL repo root
python -m http.server 8080
```

Open [http://localhost:8080/viewer/](http://localhost:8080/viewer/).

If you'd rather use Node:

```bash
npx http-server -p 8080
```

Or any other static server. The page itself is `viewer/index.html`.

## URL flags

| Flag | Effect |
|------|--------|
| `?show=1` | Reveals optional UI surfaces (the "private features" bridge to internal sink tooling). Off by default. See `viewer/private/README.md` for what they do. |
| `?debug=1` | Enables diagnostic console logging and the Vue mount banner. Useful for sorting out CDN / mount issues. Off by default — the steady-state mount goes straight to the form. |

The Share button also writes to the URL (`#share=…`), but that's a hash, not a query parameter. Loading a URL with both `?show=1#share=…` and a share hash works as expected — the flag and the hash are read independently.

Flags can combine: `?show=1&debug=1`.

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `Ctrl+O` | Open `.mmpform` file |
| `Ctrl+S` | Save the source |
| `Ctrl+Enter` | Process (parse + re-render) |
| `Ctrl+Z` | Undo a form edit (focus inside a `fb-input-*` field in the rendered form) |
| `Ctrl+Y` / `Ctrl+Shift+Z` | Redo a form edit (same gating as Ctrl+Z) |
| Editor | Standard Ace shortcuts (Ctrl+F, Ctrl+Z, multi-cursor with Alt-click, etc.) |

Document-level shortcuts skip when focus is in a non-editor `INPUT` or `TEXTAREA`, so typing `Ctrl+S` in the schema-name field does not save the source pane. The form-undo shortcut is gated to focused `fb-input-*` elements (the renderer marks every data-bound input) so typing in the listManager search field still hits the browser's native text undo.

## Files

```
viewer/
├── index.html              page structure (Ace, Vue 3, Vuetify 3 from CDN)
├── viewer.css              dark editor-style theme; `fb-` prefix for rendered classes
├── viewer.js               controller: parse, render, save, splitter, tabs, shortcuts, URL flags
├── render-vue.js           Vue/Vuetify renderer; per-control type mapping; ListManager component
├── mmpform-mode.js         Ace language mode for the .mmpform DSL
├── default-functions.js    sample {@fn} registry on window.formFunctions
├── private/                optional sinks-bridge UI; gated behind ?show=1
└── README.md               this file
```

The page imports `../src/index.js` for the parser, schema inferer, and preview renderer. No bundler step.

## Embedding the renderer in your own page

The viewer's Vue/Vuetify renderer is published as `mountVueRenderer(rootEl, ast, schema, opts)` from `viewer/render-vue.js`. A consumer who wants the same rendering experience inside their own app loads Vue 3 + Vuetify 3 from a CDN (or via their bundler) and calls the function:

```js
import { TextFormBuilder, inferDataSchema } from '@mmpworks/formbuilder-dsl';
import { mountVueRenderer, teardown } from './render-vue.js';   // copy this file from viewer/

const builder = new TextFormBuilder({ schemaText: yourMmpformSource });
const result = builder.process();
if (result.error !== 0) { /* show messages */ return; }

const ast    = result.payload;
const schema = inferDataSchema(ast);

const handle = mountVueRenderer(
    document.getElementById('your-mount-target'),
    ast,
    schema,
    {
        functions:            window.formFunctions,   // { name: (data) => value, ... }
        theme:                'dark',                 // 'dark' | 'light'
        dataInspectorEl:      null,                   // optional <pre> element for live JSON
        onDataChange:         (data) => { /* push into your own undo, autosave, etc. */ },
        dataChangeDebounceMs: 350                     // optional; default 350
    }
);

// Later: teardown() before mounting again, or before unmounting your component.
teardown();
```

`mountVueRenderer` returns `{ app, data }` so the consumer can read or watch the reactive `data` object directly. Calling `teardown()` (also exported) unmounts the Vue app and clears internal state — call it before re-mounting on a re-render.

The optional `onDataChange` callback fires after every reactive change to the form data, debounced (default 350 ms). The renderer uses Vue's `watch(data, ..., { deep: true, flush: 'post' })` under the hood, so the callback batches per render commit instead of per field change. `watch` does NOT fire on register — the first `onDataChange` call lands on the first user edit, not on the seed. The in-flight debounce is cleared on unmount so a fast-typing user who triggers a re-mount before the timer fires won't see a stale snapshot leak into the next mount.

The renderer dispatches a `fb-renderer-status` `CustomEvent` on `window` for in-renderer events the host might want to surface in its own status bar / toast (the present-day source is `directoryBrowser`'s "Directory picker not available in this browser" case). Listen for it if you want the messages — without a listener they still land in the console.

```js
window.addEventListener('fb-renderer-status', (e) => {
    showToast(e.detail?.message ?? '', e.detail?.kind ?? 'warn');
});
```

For an undo/redo stack on top of the reactive data, see `viewer/form-history.js`. It exports `createFormHistory(initial)`, `restoreInto(target, snapshot)`, `mergePreserveExisting(target, snapshot, opts)`, and `cloneForHistory(state)`. The viewer wires these into the toolbar buttons + keyboard shortcuts; the same module embeds in any host with a similar pattern.

For a "preserve user edits across schema changes" flow (the live-preview path the viewer uses), capture the reactive root before re-mounting and apply it via `mergePreserveExisting` after:

```js
const carryOver = structuredClone(currentReactiveData);
const mounted = mountVueRenderer(el, newAst, newSchema, opts);
mergePreserveExisting(mounted.data, carryOver, {
    skipBindings: collectComputeBindings(newAst)   // optional Set<string> of dotted paths to skip
});
```

`skipBindings` keeps the new mount's compute={@fn} values intact (the renderer's watchEffect owns those — the merge would otherwise plant stale snapshot values).

The `render-vue.js` file is self-contained except for its `import` of the package's public API. To embed it, copy the file into your project (or ship it from the same path) and adjust the import. No build step is required.

## Architecture notes

### State
Module-level state is small (`viewer.js:state` holds four fields). The Ace editor and Vue app handle their own state internally. Vue's reactive `data` object built from the inferred schema is the single source of truth for the rendered form's values.

### Process flow
Re-parses the entire source on every Process click; no keystroke debounce. The user controls when work happens. Matches the package's no-AST-caching contract — re-walking on every call is the documented design.

### Two-helpers-one-rule
The package's `safe-keys.isReservedObjectKey`, `placeholder.resolvePlaceholder`, `string-literal.readQuotedString`, `literal-types.defaultMatchesType`, and `infer-schema.resolveControlType` are all consulted via the public API or routed through it. The viewer's local `renderFragmentsAsText` (`render-vue.js`) is a deliberate non-extension because it leaves `{@fn}` placeholders empty so the schema preview reads as a static-shape view of "what fields will this form bind?" — letting the package's `renderFragments` resolve `{@fn}` against `window.formFunctions` would mix runtime-evaluated values into the preview and confuse the question it answers. The Live Data tab is the place to see resolved function output.

### CSS isolation
Form-builder rendered classes use the `fb-` prefix (`fb-form-page`, `fb-control-stack`, `fb-listmanager`, `fb-color-row`). Vuetify carries `v-` on its end. Host-page bleed is unlikely.

### Ace mode keyword set
`mmpform-mode.js` derives the control-type and parameter-name keyword sets from `defaultControlSpec` at mode-instantiation time. `viewer.js` stashes the package's `defaultControlSpec` on `window.__formBuilderDefaultSpec` before the editor mounts; the mode constructor reads that global to build its regex strings. A consumer extending the spec via `builder.registerControl` gets the new type highlighted with no edit to the mode file. The mode falls back to a hard-coded list for the v1.1.0 vocabulary if the global is missing (loading-order failure, lib not yet imported, etc.) — that path is a safety net, not the source of truth.

## Limits

- **File System Access API** is Chromium-only. Firefox / Safari users get download / upload behavior.
- **Plain HTML** preview renderer is a placeholder. ASCII and Vue/Vuetify both work.
- **Object-literal defaults** in `__properties` (rare) are parsed loosely; an apostrophe inside a value can mangle the JSON parse and fall back to an empty object.
- **`when=` expression cap** is independent of the source-input cap. A `when=` over 8 KB raises a parse error regardless of the source-input cap; see the package's [`expression-trust.md`](../docs/expression-trust.md) for the cap defaults and the trust model.
