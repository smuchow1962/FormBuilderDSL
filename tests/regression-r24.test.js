// Regression tests for round-24 — a11y deep-pass + form-state undo.
//
// Coverage map:
//   A1   render-vue.js drops the external <label class="fb-field-label"> path.
//   A2   render-vue.js drops the SELF_LABELED set + role="group" wrapper aria.
//   A3   Every single-input case passes labeledProps (which carries label + a11y).
//   A4   Compound controls (daterange, fileSize, color, directoryBrowser) use renderFieldset.
//   A5   renderFieldset emits <fieldset> + <legend> with aria-required / aria-describedby.
//   A6   <details> explain block carries the explainId so aria-describedby resolves.
//   A7   ids are deterministic per (binding|contentRef, line).
//   A8   viewer.css ships .fb-fieldset and .fb-legend rules.
//   A9   id forwarded to the Vuetify component so its label-for points at the input.
//
//   U1   createFormHistory seeds with the initial snapshot; canUndo/canRedo false at start.
//   U2   snapshot() pushes when state differs and reports true; pushes nothing when state matches.
//   U3   undo() returns the prior snapshot and toggles canRedo.
//   U4   redo() re-applies the dropped snapshot.
//   U5   New snapshot after an undo truncates the redo branch.
//   U6   MAX_HISTORY caps the stack at 32; oldest gets dropped.
//   U7   reset() drops every entry and re-seeds against a fresh state.
//   U8   restoreInto overwrites scalars in place.
//   U9   restoreInto deletes keys absent from the snapshot.
//   U10  restoreInto adds keys present only in the snapshot.
//   U11  restoreInto preserves nested object identity (the reactive proxy stays).
//   U12  restoreInto length-aligns arrays.
//
//   W1   viewer.js imports createFormHistory + restoreInto.
//   W2   renderPreview wires onDataChange into mountVueRenderer.
//   W3   Ctrl+Z / Ctrl+Y handlers are gated to els.vueMount.contains(target).
//   W4   render-vue.js wires the onDataChange watchEffect with first-tick gating.
//   W5   index.html ships the three undo buttons + edits-badge span.
//   W6   viewer.css ships the .form-edits-badge rules.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
    createFormHistory,
    restoreInto,
    cloneForHistory,
    mergePreserveExisting,
    MAX_HISTORY
} from '../viewer/form-history.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot  = join(__dirname, '..');
const readDoc = (relPath) => readFileSync(join(repoRoot, relPath), 'utf8');

// ─── A1 / A2: external label and SELF_LABELED gone ──────────────────────

test('A1 render-vue.js no longer renders the external <label class="fb-field-label">', () => {
    const text = readDoc('viewer/render-vue.js');
    assert.equal(text.includes("'fb-field-label'"), false,
        "external fb-field-label render path should be gone");
    assert.equal(text.includes('class: \'fb-field-label\''), false,
        "external fb-field-label render path should be gone");
});

test('A2 render-vue.js drops SELF_LABELED + the wrapper role="group" aria', () => {
    const text = readDoc('viewer/render-vue.js');
    assert.equal(text.includes('SELF_LABELED'), false,
        "SELF_LABELED set is no longer needed once labels move into Vuetify");
    assert.equal(text.includes("role: labelId ? 'group' : undefined"), false,
        "wrapper should not carry role='group' once Vuetify owns the label-input wiring");
    assert.equal(text.includes("'aria-labelledby': labelId"), false,
        "wrapper should not carry aria-labelledby once Vuetify owns the label-input wiring");
});

// ─── A3: every Vuetify single-input case spreads labeledProps ─────────────

test('A3 every Vuetify single-input case spreads labeledProps somewhere in its props', () => {
    const text = readDoc('viewer/render-vue.js');
    // Each single-input case must spread labeledProps so label +
    // a11y reach the Vuetify component. We don't pin first-position
    // — a future refactor that adds another prop before the spread
    // is fine as long as labeledProps is in the bag.
    const cases = ['VTextField', 'VTextarea', 'VSlider', 'VCheckbox', 'VSwitch',
        'VSelect', 'VCombobox', 'VRadioGroup', 'VFileInput'];
    for (const comp of cases) {
        // Slice from the first h(C('VFoo')...) call to the next
        // case label or end of switch, then look for ...labeledProps
        // anywhere in the slice.
        const callIdx = text.indexOf(`h(C('${comp}')`);
        assert.notEqual(callIdx, -1, `${comp} must be referenced somewhere in the renderer`);
        // Scan the next 800 chars for the labeledProps spread (covers
        // multi-line option blocks comfortably).
        const slice = text.slice(callIdx, callIdx + 800);
        assert.match(slice, /\.\.\.labeledProps/,
            `${comp} must spread labeledProps to receive label + a11y`);
    }
});

// ─── A4 + A5: compound controls + renderFieldset ─────────────────────────

test('A4 compound controls use renderFieldset', () => {
    const text = readDoc('viewer/render-vue.js');
    // Each compound case calls renderFieldset to build the fieldset/legend wrap.
    const compounds = ['daterange', 'fileSize', 'directoryBrowser', 'color'];
    for (const c of compounds) {
        // Match: case 'X':  ... renderFieldset(  somewhere in the same case body
        const idx = text.indexOf(`case '${c}'`);
        assert.notEqual(idx, -1, `case '${c}' missing`);
        const next = text.indexOf("case '", idx + 1);
        const slice = next === -1 ? text.slice(idx) : text.slice(idx, next);
        assert.ok(slice.includes('renderFieldset('),
            `compound case '${c}' should wrap its body in renderFieldset`);
    }
});

test('A5 renderFieldset emits <fieldset> + <legend> with aria forwarded', () => {
    const text = readDoc('viewer/render-vue.js');
    const fnIdx = text.indexOf('function renderFieldset(');
    assert.notEqual(fnIdx, -1, 'renderFieldset helper must exist');
    const fnSlice = text.slice(fnIdx, fnIdx + 1000);
    assert.match(fnSlice, /h\('fieldset'/, 'renderFieldset should emit a <fieldset>');
    assert.match(fnSlice, /h\('legend'/,   'renderFieldset should emit a <legend>');
    assert.ok(fnSlice.includes("'aria-required':    a11y['aria-required']"),
        'fieldset must forward aria-required from the a11y bundle');
    assert.ok(fnSlice.includes("'aria-describedby': a11y['aria-describedby']"),
        'fieldset must forward aria-describedby from the a11y bundle');
});

// ─── A6: <details> explain block carries explainId ───────────────────────

test('A6 explain block targets the inner body div with explainId (not the outer <details>)', () => {
    const text = readDoc('viewer/render-vue.js');
    // The <details> wrapper carries no id; the inner .fb-explain-body
    // div carries explainId so screen readers read the description text
    // whether the disclosure is open or collapsed (NVDA on Chromium
    // otherwise reads "Show details, button, collapsed" only).
    assert.match(text,
        /h\('details', \{ class: 'fb-explain' \}/,
        '<details> wrapper should NOT carry id (the body div does)');
    assert.match(text,
        /h\('div', \{ class: 'fb-explain-body', id: explainId \}/,
        'the body div must declare id: explainId so aria-describedby resolves to readable content');
});

// ─── A7: deterministic id per (binding|contentRef, line) ────────────────

test('A7 inputId / explainId are deterministic per (binding|contentRef, line)', () => {
    const text = readDoc('viewer/render-vue.js');
    // The id pair derives from the same stableId base.
    assert.match(text, /const stableId\s+= ctl\.binding \?\? ctl\.contentRef/);
    assert.match(text, /const inputId\s+= `fb-input-\$\{stableId\}-\$\{ctl\.loc\?\.line \?\? 0\}`/);
    assert.match(text, /const explainId = `fb-explain-\$\{stableId\}-\$\{ctl\.loc\?\.line \?\? 0\}`/);
});

// ─── A8: CSS rules for fieldset / legend ────────────────────────────────

test('A8 viewer.css ships .fb-fieldset and .fb-legend rules', () => {
    const css = readDoc('viewer/viewer.css');
    assert.match(css, /\.fb-fieldset\s*\{/, '.fb-fieldset rule should be defined');
    assert.match(css, /\.fb-legend\s*\{/,   '.fb-legend rule should be defined');
    // The fieldset rule must strip the default browser fieldset border so the
    // group reads as one card without a heavy second outline.
    const fbIdx = css.indexOf('.fb-fieldset');
    const fbBlock = css.slice(fbIdx, fbIdx + 200);
    assert.match(fbBlock, /border:\s*0/, 'fieldset rule should strip the default browser border');
});

// ─── A9: id forwarded to compound sub-inputs ─────────────────────────────

test('A9 compound sub-inputs receive their own derived id', () => {
    const text = readDoc('viewer/render-vue.js');
    // Each compound sub-input pulls a derived id from a11y.id so its
    // internal label-for points at the right input. Spot-check four:
    // start/end (daterange), amount/unit (fileSize), path
    // (directoryBrowser), color (color).
    assert.match(text, /id: `\$\{a11y\.id\}-start`/);
    assert.match(text, /id: `\$\{a11y\.id\}-end`/);
    assert.match(text, /id: `\$\{a11y\.id\}-amount`/);
    assert.match(text, /id: `\$\{a11y\.id\}-unit`/);
    assert.match(text, /id: `\$\{a11y\.id\}-path`/);
    assert.match(text, /id: `\$\{a11y\.id\}-color`/);
});

// ─── U1 / U2: createFormHistory seeds + dedup ────────────────────────────

test('U1 createFormHistory seeds; canUndo/canRedo false at start', () => {
    const h = createFormHistory({ a: 1 });
    const info = h.info();
    assert.equal(info.canUndo, false);
    assert.equal(info.canRedo, false);
    assert.equal(info.editsAhead, 0);
    assert.equal(info.length, 1);
});

test('U2 snapshot() pushes only when state differs', () => {
    const h = createFormHistory({ a: 1 });
    assert.equal(h.snapshot({ a: 1 }), false, 'identical state should be a no-op');
    assert.equal(h.snapshot({ a: 2 }), true,  'different state should push');
    assert.equal(h.info().editsAhead, 1);
    assert.equal(h.info().canUndo, true);
});

// ─── U3 / U4: undo / redo ────────────────────────────────────────────────

test('U3 undo() returns the prior snapshot and toggles canRedo', () => {
    const h = createFormHistory({ a: 1 });
    h.snapshot({ a: 2 });
    const prev = h.undo();
    assert.deepEqual(prev, { a: 1 });
    assert.equal(h.info().canUndo, false);
    assert.equal(h.info().canRedo, true);
});

test('U4 redo() re-applies the dropped snapshot', () => {
    const h = createFormHistory({ a: 1 });
    h.snapshot({ a: 2 });
    h.undo();
    const back = h.redo();
    assert.deepEqual(back, { a: 2 });
    assert.equal(h.info().canUndo, true);
    assert.equal(h.info().canRedo, false);
});

// ─── U5: new snapshot after undo truncates redo branch ───────────────────

test('U5 new snapshot after an undo drops the redo branch', () => {
    const h = createFormHistory({ a: 1 });
    h.snapshot({ a: 2 });
    h.snapshot({ a: 3 });
    h.undo();                                   // back to {a:2}
    h.snapshot({ a: 99 });                      // new branch
    assert.equal(h.info().canRedo, false, 'old redo branch should be gone');
    assert.equal(h.redo(), null);
});

// ─── U6: MAX_HISTORY cap ────────────────────────────────────────────────

test('U6 MAX_HISTORY caps the stack; seed at index 0 stays pinned', () => {
    const h = createFormHistory({ n: 0 });
    for (let i = 1; i <= MAX_HISTORY + 5; i++) {
        h.snapshot({ n: i });
    }
    assert.equal(h.info().length, MAX_HISTORY,
        'stack should be capped at MAX_HISTORY entries');
    assert.equal(h.info().cursor, MAX_HISTORY - 1);
    // The seed (post-Process state) must survive the cap so
    // seekToSeed always returns the right thing and the badge stays
    // honest. We verify by walking back to index 0 via undo() and
    // confirming we land on the seed value.
    while (h.info().canUndo) h.undo();
    const back = h.seekToSeed();   // O(1) jump and confirms the seed
    assert.deepEqual(back, { n: 0 },
        'seed must be pinned at index 0 across cap firings');
});

// ─── U7: reset() ─────────────────────────────────────────────────────────

test('U7 reset() drops the stack and re-seeds against a fresh state', () => {
    const h = createFormHistory({ a: 1 });
    h.snapshot({ a: 2 });
    h.snapshot({ a: 3 });
    h.reset({ a: 99 });
    assert.equal(h.info().canUndo, false);
    assert.equal(h.info().canRedo, false);
    assert.equal(h.info().length, 1);
});

// ─── U8 / U9 / U10 / U11: restoreInto behaviour ─────────────────────────

test('U8 restoreInto overwrites scalars in place', () => {
    const target   = { a: 1, b: 'x' };
    const snapshot = { a: 5, b: 'y' };
    restoreInto(target, snapshot);
    assert.deepEqual(target, { a: 5, b: 'y' });
});

test('U9 restoreInto deletes keys absent from the snapshot', () => {
    const target   = { a: 1, b: 2, c: 3 };
    const snapshot = { a: 1 };
    restoreInto(target, snapshot);
    assert.deepEqual(target, { a: 1 });
    assert.equal('b' in target, false);
    assert.equal('c' in target, false);
});

test('U10 restoreInto adds keys present only in the snapshot', () => {
    const target   = { a: 1 };
    const snapshot = { a: 1, b: 2 };
    restoreInto(target, snapshot);
    assert.deepEqual(target, { a: 1, b: 2 });
});

test('U11 restoreInto preserves nested object identity', () => {
    const target   = { nested: { x: 1, y: 2 } };
    const innerRef = target.nested;
    const snapshot = { nested: { x: 10, z: 3 } };
    restoreInto(target, snapshot);
    assert.equal(target.nested, innerRef, 'nested object identity must be preserved');
    assert.deepEqual(target.nested, { x: 10, z: 3 });
});

test('U12 restoreInto length-aligns arrays', () => {
    const target   = { items: [{ a: 1 }, { a: 2 }, { a: 3 }] };
    const arrRef   = target.items;
    const snapshot = { items: [{ a: 10 }] };
    restoreInto(target, snapshot);
    assert.equal(target.items, arrRef, 'array identity must be preserved');
    assert.equal(target.items.length, 1);
    assert.deepEqual(target.items, [{ a: 10 }]);
});

// ─── W1 / W2 / W3: viewer.js wiring ──────────────────────────────────────

test('W1 viewer.js imports createFormHistory + restoreInto + mergePreserveExisting from form-history.js', () => {
    const text = readDoc('viewer/viewer.js');
    assert.match(text,
        /import \{ createFormHistory, restoreInto, mergePreserveExisting \} from '\.\/form-history\.js';/);
});

test('W2 renderPreview wires onDataChange into mountVueRenderer', () => {
    const text = readDoc('viewer/viewer.js');
    assert.ok(text.includes('onDataChange:'),
        'mountVueRenderer call should pass an onDataChange callback');
    assert.ok(text.includes('state.formHistory.snapshot(data)'),
        'onDataChange should push into the history');
});

test('W3 Ctrl+Z / Ctrl+Y handlers are gated by isInsideRenderedForm + isFormDataBoundInput', () => {
    const text = readDoc('viewer/viewer.js');
    // The gate uses two helpers: one walks the rendered-form DOM
    // (including teleported overlays) and one filters out non-data
    // inputs (e.g. the listManager search field).
    assert.ok(text.includes('isInsideRenderedForm(e.target)'),
        'undo/redo shortcut must use isInsideRenderedForm so dialog overlays count');
    assert.ok(text.includes('isFormDataBoundInput(e.target)'),
        'undo/redo shortcut must filter to data-bound inputs only');
    assert.ok(text.includes('undoFormEdit()'));
    assert.ok(text.includes('redoFormEdit()'));
});

// ─── W4: render-vue.js onDataChange watchEffect ──────────────────────────

test('W4 render-vue.js wires onDataChange via watch deep (no per-tick JSON.stringify)', () => {
    const text = readDoc('viewer/render-vue.js');
    assert.ok(text.includes("typeof opts.onDataChange === 'function'"),
        'render-vue should accept the onDataChange callback');
    // The watcher is `watch(data, fn, { deep: true, flush: 'post' })`
    // — no JSON.stringify per tick, no primed-flag gate (watch
    // doesn't fire on register the way watchEffect does).
    assert.match(text, /watch\(data, \(\) => \{/,
        'should use watch (not watchEffect) for onDataChange tracking');
    assert.match(text, /\{\s*deep:\s*true,\s*flush:\s*'post'\s*\}/,
        "watch must use { deep: true, flush: 'post' }");
    // Debounce so a typing burst becomes one host-side call.
    assert.ok(text.includes('opts.dataChangeDebounceMs ?? 350'),
        'debounce must be present (default 350ms)');
    // Stop the watcher on unmount so it doesn't leak across re-mounts.
    assert.ok(text.includes('if (stop) stop()'),
        'unmount cleanup must call the watcher stop function');
    // NEGATIVE: onDataChange must NOT be wired through a watchEffect
    // that JSON.stringify(data)s per tick. Other watchEffect uses
    // (compute= and dataInspectorEl) are unrelated to onDataChange.
    assert.equal(text.match(/watchEffect\([\s\S]{0,300}JSON\.stringify\(data\)[\s\S]{0,300}opts\.onDataChange/g), null,
        'onDataChange must not run through a per-tick JSON.stringify watchEffect');
});

// ─── W5: HTML carries the new buttons + badge ────────────────────────────

test('W5 index.html ships the undo / redo / reset buttons + edits badge', () => {
    const html = readDoc('viewer/index.html');
    assert.ok(html.includes('id="btn-form-undo"'),  'btn-form-undo must exist');
    assert.ok(html.includes('id="btn-form-redo"'),  'btn-form-redo must exist');
    assert.ok(html.includes('id="btn-form-reset"'), 'btn-form-reset must exist');
    assert.ok(html.includes('id="form-edits-badge"'), 'form-edits-badge must exist');
    // Each button is when-vue gated (the form-state stack only matters
    // for the Vue renderer; the ASCII renderer is read-only).
    assert.match(html, /id="btn-form-undo"\s+class="when-vue"/);
});

// ─── W6: CSS for the edits badge ─────────────────────────────────────────

test('W6 viewer.css ships .form-edits-badge rules', () => {
    const css = readDoc('viewer/viewer.css');
    assert.match(css, /\.form-edits-badge\s*\{/);
    // Hidden by default; .show toggles it on.
    assert.match(css, /\.form-edits-badge\.show\s*\{[^}]*display:\s*inline-block/);
});

// ─── Round-25 fixes (C1, C2, C3, M1, M3, M4) ────────────────────────────

// F1 (C2): debounce timer cleared on unmount
test('F1 (C2) onDataChange watchEffect registers an onUnmounted handler that clears the timer', () => {
    const text = readDoc('viewer/render-vue.js');
    // onUnmounted must be pulled off Vue's namespace alongside the
    // other reactivity helpers.
    assert.match(text, /\bonUnmounted\b/, 'onUnmounted must be imported from Vue');
    // The timer-clear branch must guard the unmount path so a re-mount
    // after fast typing doesn't see the stale debounce fire into the
    // new history.
    assert.ok(text.includes('if (onUnmounted) onUnmounted(() => {'),
        'onUnmounted hook must clear the in-flight debounce timer');
    assert.ok(text.includes('if (timer) { clearTimeout(timer); timer = 0; }'),
        'unmount handler must clear the timer and zero it');
});

// F2 (C3 + m9 + m10): dialog has aria-labelledby + sanitised titleId; default body teleport
test('F2 (C3 + m9 + m10) VDialog has aria-labelledby with a sanitised titleId; no attach risk', () => {
    const text = readDoc('viewer/render-vue.js');
    // Title id is sanitised so a dotted arrayBinding (e.g. groups.users)
    // doesn't produce a CSS-selector-hostile id.
    assert.match(text,
        /const titleId = `fb-lm-dialog-title-\$\{rawBinding\.replace\(\/\[\^a-zA-Z0-9_-\]\/g, '_'\)\}`/,
        'titleId must sanitise non-id characters from the arrayBinding');
    assert.ok(text.includes("'aria-labelledby': titleId"),
        'VDialog must reference the title id via aria-labelledby');
    assert.ok(text.includes("h(C('VCardTitle'), { class: 'fb-lm-dialog-title', id: titleId }"),
        'VCardTitle must carry the matching id');
    // The earlier `attach: '#vue-app-mount'` had a known overlay-
    // positioning risk under overflow:auto containers. The viewer
    // gate now walks .v-overlay-container / .v-dialog ancestors
    // instead, so the dialog can use Vuetify's default body teleport.
    // Strip block comments before the negative grep so the historical
    // mention in the comment block doesn't trip the assertion.
    const codeOnly = text.replace(/\/\/[^\n]*/g, '');
    assert.equal(codeOnly.includes("attach: '#vue-app-mount'"), false,
        "VDialog should NOT use attach='#vue-app-mount' — host gate handles teleported overlays instead");
});

// F3 (C1): cloneForHistory + scrubInternalKeys; __pk is stripped on snapshot
test('F3 (C1) cloneForHistory scrubs the parser non-enumerable __pk marker', () => {
    // Parser-shaped value: __pk attached as non-enumerable on a
    // plain object that ALSO carries enumerable fields. After
    // cloneForHistory the clone must have the enumerable fields
    // and must NOT have __pk in any descriptor flavour.
    const original = { name: 'red', value: '#ff0000' };
    Object.defineProperty(original, '__pk', {
        value: 'name',
        enumerable: false,
        configurable: true,
        writable: false
    });
    const cloned = cloneForHistory(original);
    assert.equal(cloned.name, 'red');
    assert.equal(cloned.value, '#ff0000');
    assert.equal('__pk' in cloned, false,
        '__pk must be scrubbed from the clone (structuredClone leaks it as enumerable)');
});

test('F3 (C1) snapshot strips __pk so an Undo round-trip does not leak it into JSON', () => {
    const item = { name: 'admin' };
    Object.defineProperty(item, '__pk', { value: 'name', enumerable: false, configurable: true });
    const seed = { items: [item, { name: 'guest' }] };

    const h = createFormHistory(seed);
    h.snapshot({ items: [item, { name: 'guest' }, { name: 'editor' }] });
    const back = h.undo();

    // The seed restored from the stack must not surface __pk as an
    // enumerable own property — so JSON output stays clean.
    assert.equal('__pk' in back.items[0], false,
        '__pk must not survive a snapshot round-trip as an enumerable property');
    assert.equal(JSON.stringify(back).includes('__pk'), false,
        'JSON output of the restored snapshot must not contain __pk');
});

test('F3 (C1) scrub recurses into nested objects and arrays', () => {
    const inner = { name: 'x' };
    Object.defineProperty(inner, '__pk', { value: 'name', enumerable: false, configurable: true });
    const state = { groups: { a: [inner] } };
    const cloned = cloneForHistory(state);
    assert.equal('__pk' in cloned.groups.a[0], false,
        'scrub must reach nested __pk markers');
});

// F4 (M1): subA11y bundle defined and spread into compound sub-inputs
test('F4 (M1) subA11y bundle is defined and forwards aria-describedby to compound sub-inputs', () => {
    const text = readDoc('viewer/render-vue.js');
    // Bundle definition.
    assert.match(text,
        /const subA11y = \{\s*'aria-describedby': a11y\['aria-describedby'\]/,
        'subA11y must be defined and pull aria-describedby off the parent a11y bundle');
    // Each compound sub-input spreads it. Expected spreads:
    //   daterange (2: Start + End)
    //   fileSize (2: Amount + Unit)
    //   directoryBrowser (2: path field + Browse button)
    //   color (1: VTextField; the plain <button> null swatch uses
    //          an explicit declaration covered by the next test)
    // Total: 7. Use >= so a future compound that adds more
    // spreads doesn't fail the test.
    const compoundSubInputCount = (text.match(/\.\.\.subA11y/g) ?? []).length;
    assert.ok(compoundSubInputCount >= 7,
        `expected at least 7 ...subA11y spreads across compound sub-inputs, got ${compoundSubInputCount}`);
});

test('F4 (M1) the color null swatch carries aria-describedby explicitly', () => {
    const text = readDoc('viewer/render-vue.js');
    // The null-swatch button isn't a Vuetify component (it's a
    // plain <button>), so it can't be a spread target — the prop is
    // declared inline. Make sure the explicit forwarding is present.
    assert.match(text,
        /'aria-describedby': subA11y\['aria-describedby'\]/,
        'color null swatch must declare aria-describedby explicitly');
});

// F5 (M3): explainId on body div, not on details (covered by updated A6 above; this test pins the negative)
test('F5 (M3) the <details> wrapper does NOT carry an id', () => {
    const text = readDoc('viewer/render-vue.js');
    assert.equal(text.includes("h('details', { class: 'fb-explain', id: explainId }"), false,
        'the <details> wrapper must not own the id (M3 fix moved it to the body div)');
});

// F6 (M4): seekToSeed exists; reset truncates redo; resetForm calls seekToSeed
test('F6 (M4) seekToSeed jumps cursor to seed in O(1) and truncates the redo branch', () => {
    const h = createFormHistory({ a: 0 });
    for (let i = 1; i <= 5; i++) h.snapshot({ a: i });
    assert.equal(h.info().editsAhead, 5);

    const seed = h.seekToSeed();
    assert.deepEqual(seed, { a: 0 });
    const info = h.info();
    assert.equal(info.cursor, 0);
    assert.equal(info.length, 1, 'redo branch must be truncated');
    assert.equal(info.canUndo, false);
    assert.equal(info.canRedo, false, 'Reset must NOT be undoable via Redo');
});

test('F6 (M4) seekToSeed after a reset returns the freshly-seeded snapshot', () => {
    // After reset(newSeed), length is 1 and seekToSeed returns the
    // new seed. (Production code never empties the stack; the
    // empty-stack early return at form-history.js:80 is defensive
    // only and isn't reachable from the public API.)
    const h = createFormHistory({ a: 0 });
    h.reset({ a: 1 });
    const back = h.seekToSeed();
    assert.deepEqual(back, { a: 1 });
});

test('F6 (M4) viewer.js resetForm calls seekToSeed instead of looping undo()', () => {
    const text = readDoc('viewer/viewer.js');
    assert.ok(text.includes('state.formHistory.seekToSeed()'),
        'resetForm must call seekToSeed (O(1) seed jump that truncates redo)');
    // Negative: the previous loop-through-undo() implementation must be gone.
    assert.equal(text.includes('while (state.formHistory.info().canUndo)'), false,
        'the loop-undo() reset implementation must be replaced');
});

// ─── Round-26 fixes (C-1, C-2, M-1, M-2, M-3, M-4) ───────────────────────

// G1 (C-1): undo + debounced re-snapshot does NOT destroy the redo branch
test('G1 (C-1) snapshot dedups against cursor first; undo + restore round-trip preserves the redo branch', () => {
    const h = createFormHistory({ a: 1 });
    h.snapshot({ a: 2 });
    h.snapshot({ a: 3 });
    // After undo, the host calls restoreInto(activeFormData, snap)
    // and then the renderer's debounced onDataChange fires 350ms
    // later, calling snapshot(activeFormData) where activeFormData
    // now equals stack[cursor]. With the round-25 ordering this
    // would silently truncate the redo branch.
    const undone = h.undo();
    assert.deepEqual(undone, { a: 2 });
    assert.equal(h.info().canRedo, true, 'redo should be available right after undo');

    // Simulate the debounce-driven re-snapshot of the same state.
    const result = h.snapshot({ a: 2 });
    assert.equal(result, false, 'restore-and-resnap of the same state must be a no-op');
    assert.equal(h.info().canRedo, true,
        'redo branch must survive a restore-and-resnap round-trip');
    assert.deepEqual(h.redo(), { a: 3 }, 'redo must still walk forward to the post-undo state');
});

// G2 (C-2): seed survives the cap
test('G2 (C-2) seed at index 0 is pinned across cap firings (covered by U6 too)', () => {
    const h = createFormHistory({ post: 'process' });
    for (let i = 0; i < MAX_HISTORY * 2; i++) {
        h.snapshot({ post: 'process', edit: i });
    }
    // The seed should be reachable via seekToSeed regardless of how
    // many edits have rolled the cap.
    const seed = h.seekToSeed();
    assert.deepEqual(seed, { post: 'process' },
        'seed must survive any number of cap-triggered drops');
});

// G3 (M-1): scrub does real work when given an enumerable __pk
test('G3 (M-1) scrub strips an enumerable __pk on the source (defence-in-depth case)', () => {
    // Source carries __pk as ENUMERABLE — structuredClone WOULD copy
    // it through. The scrub catches it. Without the scrub, an enum-
    // erable __pk on a consumer-supplied option-source value would
    // leak into snapshots.
    const item = { name: 'admin', __pk: 'name' };       // enumerable, would survive structuredClone
    const cloned = cloneForHistory(item);
    assert.equal('__pk' in cloned, false,
        'enumerable __pk must be scrubbed (the structuredClone-only path leaves it in)');
    assert.equal(cloned.name, 'admin');
});

// G4 (M-2): file-marker preprocessing
test('G4 (M-2) cloneForHistory replaces File leaves with markers so dedup distinguishes picks', () => {
    // Simulate a File via a stand-in object. The real File constructor
    // is browser-only; the cloneForHistory File branch uses
    // `value instanceof File`, which we verify guards correctly when
    // File isn't defined. Then we test the structural shape against
    // the markFileLeaves helper indirectly by checking that two
    // different "files" produce different snapshots.
    const stateA = { upload: { __filePlaceholder: 'a' } };
    const stateB = { upload: { __filePlaceholder: 'b' } };

    const h = createFormHistory(stateA);
    const pushed = h.snapshot(stateB);
    assert.equal(pushed, true,
        'two distinct upload values must dedup as different');

    // Now confirm the marker shape is JSON-serialisable. A File-like
    // marker is { __file: true, name, size, type, lastModified }.
    // Since we can't instantiate a real File in node-test, just
    // verify the marker constants are present in the source.
    const text = readDoc('viewer/form-history.js');
    assert.match(text, /__file: true,\s*name: value\.name/);
    assert.match(text, /__fileList: true/);
    assert.match(text, /__blob: true/);
});

// G5 (M-3): Ctrl+Z gate hoisted above the INPUT/TEXTAREA check
test('G5 (M-3) Ctrl+Z fires on focused buttons inside the rendered form', () => {
    const text = readDoc('viewer/viewer.js');
    // The form-history branch must precede the INPUT/TEXTAREA gate.
    const formHistoryIdx = text.indexOf('state.formHistory && isInsideRenderedForm(e.target)');
    const tagGateIdx = text.indexOf("if (tag === 'INPUT' || tag === 'TEXTAREA') return;");
    assert.notEqual(formHistoryIdx, -1, 'form-history branch must exist');
    assert.notEqual(tagGateIdx, -1, 'tag-gate must exist');
    assert.ok(formHistoryIdx < tagGateIdx,
        'form-history branch must precede the INPUT/TEXTAREA tag gate so Ctrl+Z works on focused buttons');
});

// G6 (M-4 partial): isFormDataBoundInput excludes non-data inputs
test('G6 (M-4) isFormDataBoundInput excludes the listManager search field', () => {
    const text = readDoc('viewer/viewer.js');
    // Helper exists.
    assert.match(text, /function isFormDataBoundInput\(/,
        'isFormDataBoundInput helper must exist');
    // Marker check uses the fb-input- id prefix — every data-bound
    // input the renderer emits carries it; the search field doesn't.
    assert.match(text, /id\.startsWith\('fb-input-'\)/);
    assert.match(text, /el\.closest\?\.\('\[id\^="fb-input-"\]'\)/,
        'helper must walk up to a fb-input-* ancestor for nested input wrappers');
});

// G7 (lead-comment fix): structuredClone behaviour stated correctly
test('G7 (M-1 docs) form-history.js comment correctly states structuredClone drops non-enumerable', () => {
    const text = readDoc('viewer/form-history.js');
    // The "structuredClone copies non-enumerable as enumerable" claim
    // must be gone. Replace with the truth: structuredClone iterates
    // own enumerable string-keyed properties.
    assert.equal(text.includes('structuredClone copies own properties via\n// [[OwnPropertyKeys]]'), false,
        'the misleading [[OwnPropertyKeys]] claim must be gone');
    assert.match(text,
        /structuredClone iterates own \*enumerable\* string-/,
        'comment must accurately state structuredClone iterates enumerable own keys');
});

// ─── Round-27 fixes (m1, m2, m4, m5, m7, m8, m9, m10, d1) ────────────────

// H1 (m7): mergePreserveExisting walks both shapes and preserves identity
test('H1 (m7) mergePreserveExisting preserves keys present in target; skips keys only in snapshot', () => {
    const target   = { keep: 'default', new: 'fresh-default' };
    const snapshot = { keep: 'user-edit', removed: 'gone' };
    mergePreserveExisting(target, snapshot);
    // 'keep' inherits the user's edit.
    assert.equal(target.keep, 'user-edit');
    // 'new' (only in target) keeps its default — the new schema added it.
    assert.equal(target.new, 'fresh-default');
    // 'removed' (only in snapshot) does NOT appear — the new schema removed it.
    assert.equal('removed' in target, false);
});

test('H1 (m7) mergePreserveExisting length-aligns arrays (user-managed contents persist)', () => {
    const target   = { items: [{ a: 'default' }] };
    const snapshot = { items: [{ a: 'user1' }, { a: 'user2' }, { a: 'user3' }] };
    mergePreserveExisting(target, snapshot);
    assert.equal(target.items.length, 3, 'array length must match the snapshot');
    assert.equal(target.items[0].a, 'user1');
    assert.equal(target.items[2].a, 'user3');
});

test('H1 (m7) mergePreserveExisting truncates target arrays longer than the snapshot', () => {
    const target   = { items: [{ a: 1 }, { a: 2 }, { a: 3 }] };
    const arrRef   = target.items;
    const snapshot = { items: [{ a: 10 }] };
    mergePreserveExisting(target, snapshot);
    assert.equal(target.items, arrRef, 'array identity preserved');
    assert.equal(target.items.length, 1);
    assert.equal(target.items[0].a, 10);
});

test('H1 (m7) viewer.js renderPreview reads + clears preserveFormDataOnNextProcess', () => {
    const text = readDoc('viewer/viewer.js');
    // The flag is set by the live-preview path and read+cleared by
    // renderPreview before the new mount.
    assert.match(text, /state\.preserveFormDataOnNextProcess = true/,
        'live-preview path must set the preserve flag');
    assert.match(text, /const preserveData = state\.preserveFormDataOnNextProcess/,
        'renderPreview must read the preserve flag');
    assert.match(text, /state\.preserveFormDataOnNextProcess = false/,
        'renderPreview must clear the preserve flag after reading');
    assert.match(text, /mergePreserveExisting\(mounted\.data, carryOver,/,
        'merge must apply when carry-over snapshot is present');
});

// H2 (m1): noref- fallback for ids
test('H2 (m1) stableId fallback uses noref- prefix instead of Math.random', () => {
    const text = readDoc('viewer/render-vue.js');
    assert.match(text,
        /const stableId\s+= ctl\.binding \?\? ctl\.contentRef \?\? `noref-\$\{ctl\.loc\?\.line \?\? 0\}`/,
        'stableId fallback must be deterministic (noref-<line>) so re-renders produce the same id');
    assert.equal(text.includes("Math.random().toString(36)"), false,
        'random fallback must be removed (defeats the "stable across renders" promise)');
});

// H3 (m2): fileSize unit pick preserved on empty amount
test('H3 (m2) fileSize recombine preserves the unit when amount is empty', () => {
    const text = readDoc('viewer/render-vue.js');
    // recombine has a branch that stores the unit alone when amount
    // is empty + unit differs from defaultUnit.
    assert.match(text, /const amountEmpty = \(a == null \|\| a === '' \|\| Number\.isNaN\(a\)\)/,
        'recombine must compute amountEmpty');
    assert.match(text, /if \(amountEmpty && u === defaultUnit\) \{[\s\S]+?setDeep\(data, ctl\.binding, ''\)/,
        'recombine must collapse to empty when both amount empty and unit defaults');
    assert.match(text, /\} else if \(amountEmpty\) \{[\s\S]+?setDeep\(data, ctl\.binding, u\)/,
        'recombine must store the unit alone when only amount is empty');
});

test('H3 (m2) parseSizeString accepts a unit-only binding (e.g. "Gb")', () => {
    const text = readDoc('viewer/render-vue.js');
    // The regex's num group is now optional so "Gb" alone parses.
    assert.match(text,
        /\/\^\(\?<num>-\?\\d\+\(\?:\\\.\\d\+\)\?\)\?\\s\*\(\?<unit>\[A-Za-z\]\+\)\?\\s\*\$\//,
        'parseSizeString num group must be optional so unit-only strings parse');
    // Output: when num is missing, amount is ''.
    assert.match(text,
        /const amt = m\.groups\.num != null \? parseFloat\(m\.groups\.num\) : ''/,
        'amount must be empty string when num group is missing');
});

// H4 (m4): no toast on undo/redo
test('H4 (m4) undoFormEdit and redoFormEdit do NOT call setStatus', () => {
    const text = readDoc('viewer/viewer.js');
    // Find the undoFormEdit body and confirm setStatus is not called.
    const fnIdx = text.indexOf('function undoFormEdit()');
    assert.notEqual(fnIdx, -1);
    const next = text.indexOf('function redoFormEdit()', fnIdx + 1);
    const slice = text.slice(fnIdx, next);
    assert.equal(slice.includes('setStatus('), false,
        'undoFormEdit should not pop a toast on every Ctrl+Z');

    // Same for redoFormEdit.
    const fnIdx2 = text.indexOf('function redoFormEdit()');
    const next2 = text.indexOf('function resetForm()', fnIdx2 + 1);
    const slice2 = text.slice(fnIdx2, next2);
    assert.equal(slice2.includes('setStatus('), false,
        'redoFormEdit should not pop a toast on every Ctrl+Y');
});

test('H4 (m4) resetForm DOES still call setStatus (one-shot, not per-keystroke)', () => {
    const text = readDoc('viewer/viewer.js');
    const fnIdx = text.indexOf('function resetForm()');
    assert.notEqual(fnIdx, -1);
    // Walk to the function's matching closing brace by depth count.
    let depth = 0, p = fnIdx, started = false;
    for (; p < text.length; p++) {
        if (text[p] === '{') { depth++; started = true; }
        else if (text[p] === '}') { depth--; if (started && depth === 0) { p++; break; } }
    }
    const slice = text.slice(fnIdx, p);
    assert.match(slice, /setStatus\('Form reset to post-process state'/,
        'resetForm should still toast — Reset is a deliberate one-shot');
});

// H5 (m5): directoryBrowser uses CustomEvent instead of alert()
test('H5 (m5) directoryBrowser uses fb-renderer-status CustomEvent instead of alert()', () => {
    const text = readDoc('viewer/render-vue.js');
    const dirIdx = text.indexOf("case 'directoryBrowser'");
    const dirEnd = text.indexOf("case 'color'", dirIdx);
    const dirBlock = text.slice(dirIdx, dirEnd);
    // Strip line comments before the negative grep so the historical
    // mention of alert() in the explanatory comment doesn't trip the
    // assertion.
    const codeOnly = dirBlock.replace(/\/\/[^\n]*/g, '');
    assert.equal(codeOnly.includes('alert('), false,
        'directoryBrowser must NOT use alert() — host gets the message via CustomEvent');
    assert.match(dirBlock, /new CustomEvent\('fb-renderer-status'/,
        'directoryBrowser must dispatch fb-renderer-status for the host to surface');
});

test('H5 (m5) viewer.js listens for fb-renderer-status and forwards to setStatus', () => {
    const text = readDoc('viewer/viewer.js');
    assert.match(text, /window\.addEventListener\('fb-renderer-status'/,
        'viewer must listen for the renderer status event');
    assert.match(text, /setStatus\(detail\.message \?\? '\(no message\)', detail\.kind \?\? 'warn'\)/,
        'listener must forward the message + kind to setStatus');
});

// H6 (m9): titleId sanitised
test('H6 (m9) dialog titleId is selector-safe (sanitises dotted bindings)', () => {
    const text = readDoc('viewer/render-vue.js');
    assert.match(text,
        /rawBinding\.replace\(\/\[\^a-zA-Z0-9_-\]\/g, '_'\)/,
        'titleId must replace non-id-safe characters with _');
});

// H7 (m10): isInsideRenderedForm walks teleported dialog overlays
test('H7 (m10) isInsideRenderedForm walks .v-dialog ancestors so dialog Ctrl+Z works', () => {
    const text = readDoc('viewer/viewer.js');
    const fnIdx = text.indexOf('function isInsideRenderedForm(');
    assert.notEqual(fnIdx, -1, 'isInsideRenderedForm helper must exist');
    const slice = text.slice(fnIdx, fnIdx + 400);
    assert.match(slice, /els\.vueMount\?\.contains\(el\)/,
        'helper must check the gated tree first');
    // Selector is narrow on purpose — see J3 for the negative pin
    // (the broader .v-overlay-container would also match unrelated
    // teleports like menus / tooltips / future snackbars).
    assert.match(slice, /el\.closest\?\.\('\.v-dialog'\)/,
        'helper must walk up to a .v-dialog so dialog-internal Ctrl+Z is reached');
});

// H8 (d1): viewer/README.md documents the new feature surface
test('H8 (d1) viewer/README.md documents the form-history feature', () => {
    const text = readDoc('viewer/README.md');
    assert.match(text, /Form-state undo \/ redo/,
        'README must add a section for the undo/redo feature');
    assert.match(text, /↶ Undo/, 'README must mention the toolbar buttons');
    assert.match(text, /Ctrl\+Y/, 'README keyboard table must include Ctrl+Y');
    assert.match(text, /onDataChange/,
        'README embed example must list onDataChange option');
    assert.match(text, /dataChangeDebounceMs/,
        'README embed example must list dataChangeDebounceMs option');
    assert.match(text, /fb-renderer-status/,
        'README must document the fb-renderer-status custom event');
    assert.match(text, /Live preview \+ form data/,
        'README must explain the live-preview + carry-over interaction');
});

// ─── Round-28 fixes (C-2, M-1, M-2, m-1, m-3, m-6, m-8, d-1..d-4) ────────

// J1 (C-2): mergePreserveExisting honours opts.skipBindings
test('J1 (C-2) mergePreserveExisting skips bindings the host marks as compute-owned', () => {
    const target   = { name: 'fresh-default', total: 0 };
    const snapshot = { name: 'user-edit',     total: 999 };
    mergePreserveExisting(target, snapshot, { skipBindings: new Set(['total']) });
    assert.equal(target.name, 'user-edit', 'non-skipped keys still merge');
    assert.equal(target.total, 0,
        'skipped keys keep the new seed (renderer watchEffect will compute the right value)');
});

test('J1 (C-2) mergePreserveExisting threads skipBindings into nested paths', () => {
    const target   = { meta: { computed: 0, label: 'fresh' } };
    const snapshot = { meta: { computed: 999, label: 'user' } };
    mergePreserveExisting(target, snapshot, { skipBindings: new Set(['meta.computed']) });
    assert.equal(target.meta.computed, 0, 'nested skipped key keeps the new seed');
    assert.equal(target.meta.label, 'user',  'sibling at the same depth still merges');
});

test('J1 (C-2) viewer.js collects compute bindings and threads them into the merge', () => {
    const text = readDoc('viewer/viewer.js');
    assert.match(text, /function collectComputeBindings\(ast\)/,
        'viewer must define a collectComputeBindings helper');
    assert.match(text, /n\.compute\?\.kind === 'function'/,
        'helper must filter on compute.kind === "function"');
    assert.match(text, /mergePreserveExisting\(mounted\.data, carryOver, \{ skipBindings \}\)/,
        'merge call must pass the skip-set');
});

// J2 (M-1): mergePreserveExisting drops type-flipped values
test('J2 (M-1) mergePreserveExisting keeps target seed when types flip (object vs primitive)', () => {
    // textfield -> daterange flip: target seeded {start,end}, snapshot
    // had a string from the textfield era.
    const target   = { trip: { start: null, end: null } };
    const snapshot = { trip: '2026-01-01' };
    mergePreserveExisting(target, snapshot);
    assert.deepEqual(target.trip, { start: null, end: null },
        'object target must NOT inherit a string snapshot value');
});

test('J2 (M-1) mergePreserveExisting keeps target seed when target is primitive and snapshot is object', () => {
    // daterange -> textfield flip: target seeded '', snapshot had {start,end}.
    const target   = { trip: '' };
    const snapshot = { trip: { start: '2026-01-01', end: '2026-02-01' } };
    mergePreserveExisting(target, snapshot);
    assert.equal(target.trip, '',
        'primitive target must NOT inherit an object snapshot value');
});

test('J2 (M-1) mergePreserveExisting null is treated as a compatible primitive', () => {
    // null is a "no value yet" marker; it should be assignable into
    // either a primitive or an object slot without being treated as
    // a type flip.
    const target   = { a: 'default' };
    const snapshot = { a: null };
    mergePreserveExisting(target, snapshot);
    assert.equal(target.a, null, 'null assignment must succeed across primitive/null');
});

test('J2 (M-1) mergePreserveExisting array vs non-array IS a type flip', () => {
    const target   = { items: ['a', 'b'] };
    const snapshot = { items: { 0: 'x', 1: 'y' } };
    mergePreserveExisting(target, snapshot);
    assert.deepEqual(target.items, ['a', 'b'],
        'array target must NOT inherit a plain-object snapshot value');
});

// J3 (M-2): isInsideRenderedForm narrowed to .v-dialog
test('J3 (M-2) isInsideRenderedForm gate is narrowed from .v-overlay-container to .v-dialog only', () => {
    const text = readDoc('viewer/viewer.js');
    const fnIdx = text.indexOf('function isInsideRenderedForm(');
    assert.notEqual(fnIdx, -1);
    const slice = text.slice(fnIdx, fnIdx + 400);
    // Must walk .v-dialog only (NOT the broader .v-overlay-container).
    assert.match(slice, /el\.closest\?\.\('\.v-dialog'\)/,
        'gate selector must be .v-dialog (narrow)');
    assert.equal(slice.includes('.v-overlay-container'), false,
        'gate selector must NOT include .v-overlay-container (would catch unrelated teleports)');
});

// J4 (m-3): parseSizeString warns on unknown unit
test('J4 (m-3) parseSizeString console.warn on unknown unit (capped dedup)', () => {
    const text = readDoc('viewer/render-vue.js');
    assert.match(text,
        /console\.warn\(`parseSizeString: unknown unit \$\{JSON\.stringify\(u\)\}; falling back to \$\{JSON\.stringify\(defaultUnit\)\}`\)/,
        'parseSizeString must warn once per unknown unit');
    assert.match(text, /_unknownUnitWarned\.size >= 64/,
        'warned-set must cap at 64 entries');
});

// J5 (m-6): recombine guards against undefined unit
test('J5 (m-6) fileSize recombine falls back to defaultUnit when nextUnit is undefined', () => {
    const text = readDoc('viewer/render-vue.js');
    assert.match(text, /const u = nextUnit \?\? defaultUnit/,
        'recombine must guard against undefined unit reaching the template literal');
});

// J6 (m-8): directoryBrowser forwards non-AbortError to the host
test('J6 (m-8) directoryBrowser dispatches fb-renderer-status on non-AbortError failures', () => {
    const text = readDoc('viewer/render-vue.js');
    const dirIdx = text.indexOf("case 'directoryBrowser'");
    const dirEnd = text.indexOf("case 'color'", dirIdx);
    const dirBlock = text.slice(dirIdx, dirEnd);
    // The error path: AbortError returns early, every other error
    // both warns and dispatches fb-renderer-status.
    assert.match(dirBlock, /if \(e\?\.name === 'AbortError'\) return/,
        'AbortError must early-return (user cancelled, not an error)');
    assert.match(dirBlock,
        /Directory picker failed: \$\{e\?\.message \?\? e\}/,
        'non-AbortError must surface to the host with the failure detail');
    // The detail.kind must be 'err' (not 'warn') for real failures.
    const errEvent = dirBlock.match(/new CustomEvent\('fb-renderer-status', \{[\s\S]+?kind: 'err'/);
    assert.ok(errEvent, 'real failures must dispatch with kind: "err"');
});

// J7 (m-1 / m-7): viewer.js comment aligns with implementation
test('J7 (m-1, m-7) leading comment on the keydown handler matches the implementation', () => {
    const text = readDoc('viewer/viewer.js');
    // The comment must NOT claim Ctrl+Z fires on focused buttons.
    assert.equal(text.includes('Fire when focus is anywhere inside the rendered form (input, button, drag handle'), false,
        'stale "fires on focused buttons" comment must be replaced with the actual contract');
    // The comment must call out the data-bound input requirement.
    assert.match(text, /Fires when focus is on \(or inside\) a\s*\/\/ data-bound input the renderer emits/,
        'comment must state that form-undo requires a data-bound input id');
});

// J8 (d-1, d-2, d-3, d-4): README docs catchup
test('J8 (d-1) README explains undo/redo are silent vs reset toasts', () => {
    const text = readDoc('viewer/README.md');
    assert.match(text, /Undo and Redo are intentionally toast-free/,
        'README must explain why undo/redo do not toast');
});

test('J8 (d-2) README documents the unit-only fileSize binding shape', () => {
    const text = readDoc('viewer/README.md');
    assert.match(text, /fileSize binding shapes/,
        'README must add a section about the fileSize binding shapes');
    assert.match(text, /a unit alone/,
        'README must call out the unit-only shape');
});

test('J8 (d-3) README documents that watch does not fire on register', () => {
    const text = readDoc('viewer/README.md');
    assert.match(text, /watch.*does NOT fire on register/i,
        'README must pin the watch register-fire semantics for consumers');
});

test('J8 (d-4) README embed example shows mergePreserveExisting + skipBindings', () => {
    const text = readDoc('viewer/README.md');
    assert.match(text, /mergePreserveExisting\(mounted\.data, carryOver/,
        'README embed must show the merge call');
    assert.match(text, /skipBindings: collectComputeBindings/,
        'README embed must show the compute-skip-set wiring');
});
