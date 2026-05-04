// FormBuilder DSL viewer — vanilla JS controller for the page.

import {
    TextFormBuilder, ERR, errorName,
    renderFormPreview,
    inferDataSchema, scaffoldDataObject, scaffoldDataClass, scaffoldTypeScript, scaffoldJsonSchema,
    renderPropertiesBlock,
    defaultControlSpec,
    walkAst
} from '../src/index.js';
import { mountVueRenderer, teardown as teardownVue } from './render-vue.js';
import { createFormHistory, restoreInto, mergePreserveExisting } from './form-history.js';
import { arePropertiesSemanticallyEqual } from './properties-sync.js';
import './default-functions.js';   // populates window.formFunctions with demo defaults

// Hand the package's defaultControlSpec to the Ace mode loaded
// before this module ran (mmpform-mode.js executes synchronously
// at script load and registers the mode factory; the factory's
// constructor reads this global at instantiation time, which is
// when initEditor() calls editor.session.setMode below). The
// editor highlights every control type in the spec — including
// custom controls registered via builder.registerControl — without
// a hand-edited keyword list.
globalThis.__formBuilderDefaultSpec = defaultControlSpec;

// Feature flags read from the URL query string. The ?show=1 flag
// reveals optional UI surfaces (the "private features" bridge to
// internal sink tooling) that are hidden by default. Without the
// flag, the viewer is the public reference renderer; the buttons,
// status chips, and CSS classes for the private features stay
// invisible and the bridge module is never imported. Reading the
// flag once at module load means a refresh is needed to flip it,
// which is correct — the page-shell decides what to show before
// any rendering happens.
const FLAGS = (() => {
    const q = new URLSearchParams(location.search);
    return { show: q.get('show') === '1', debug: q.get('debug') === '1' };
})();
document.body.classList.toggle('show-private', FLAGS.show);
document.body.classList.toggle('viewer-debug', FLAGS.debug);
// Expose the debug flag on the global so render-vue.js can read it
// without re-parsing the URL. Module-load coupling between the two
// files; documenting the channel rather than threading the flag
// through every imported function.
globalThis.__FB_VIEWER_DEBUG__ = FLAGS.debug;

// ---------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------

const $ = sel => document.querySelector(sel);

const els = {
    src:                $('#src'),                 // Ace mount target — see initEditor()
    btnOpen:            $('#btn-open'),
    btnSave:            $('#btn-save'),
    btnProcess:         $('#btn-process'),
    btnCopy:            $('#btn-copy'),
    btnSaveSchema:      $('#btn-save-schema'),
    btnRerender:        $('#btn-rerender'),
    btnFormUndo:        $('#btn-form-undo'),
    btnFormRedo:        $('#btn-form-redo'),
    btnFormReset:       $('#btn-form-reset'),
    formEditsBadge:     $('#form-edits-badge'),
    btnCopyData:        $('#btn-copy-data'),
    btnSchemaUnfoldAll: $('#btn-schema-unfold-all'),
    schemaFoldAll:      $('#schema-fold-all'),
    optWrap:            $('#opt-wrap'),
    optAutoSyncProps:   $('#opt-autosync-props'),
    optLivePreview:     $('#opt-live-preview'),
    btnShare:           $('#btn-share'),
    filename:           $('#filename'),
    toast:              $('#toast'),
    previewAscii:       $('#preview-ascii'),
    vueMount:           $('#vue-mount'),
    previewError:       $('#preview-error'),
    previewErrorTitle:  $('#preview-error-title'),
    previewErrorBody:   $('#preview-error-body'),
    liveData:           $('#live-data'),
    schemaMount:        $('#schema-editor'),       // Ace mount target for the Object View
    schemaFormat:       $('#schema-format'),
    schemaName:         $('#schema-name'),
    fwSelect:           $('#fw-select'),
    vueTheme:           $('#vue-theme'),
    previewWidth:       $('#preview-width'),
    splitter:           $('#splitter'),
    leftPanel:          $('#left'),
    statusText:         $('#status'),
    counts:             $('#counts'),
    cursorPos:          $('#cursor-pos'),
    srcCursorPos:       $('#src-cursor-pos'),
    schemaCursorPos:    $('#schema-cursor-pos'),
    body:               document.body
};

// Ace editor instance — set by initEditor(). Use editor.getValue() /
// editor.setValue() everywhere the source text was previously read or
// written. Ace handles line numbers, gutter, undo/redo, multi-line
// indent (Tab / Shift+Tab), word wrap, search/replace, and multi-cursor
// out of the box, so a lot of hand-rolled logic from the textarea era
// (rehighlight overlay, manual gutter, custom Tab handler, scroll sync)
// goes away with the swap.
let editor = null;

// Read-only Ace editor for the Object View tab. Initialised by
// initSchemaEditor(). Same theme as the source editor; the mode
// changes per the format selector so JSON / JS / TS each get their
// own syntax highlighting and code-folding behaviour. The editor is
// read-only; the user can scroll, search (Ctrl+F), and collapse
// chunks via the gutter chevrons, but the text itself is the
// processor's output and editing it has no meaning.
let schemaEditor = null;

// Toolbar visibility tracks the framework choice so width/theme controls
// only appear when they're meaningful for the active renderer.
function applyFrameworkToolbarVisibility() {
    const fw = els.fwSelect.value;
    document.querySelectorAll('.when-ascii').forEach(el => el.style.display = fw === 'ascii' ? '' : 'none');
    document.querySelectorAll('.when-vue').forEach(el => el.style.display = fw === 'vuetify' ? '' : 'none');
}

function applyFrameworkPaneVisibility() {
    const fw = els.fwSelect.value;
    els.previewAscii.style.display = fw === 'ascii'   ? '' : 'none';
    els.vueMount.style.display     = fw === 'vuetify' ? '' : 'none';
}

// ---------------------------------------------------------------
// State
// ---------------------------------------------------------------

const state = {
    fileHandle: null,            // FileSystemFileHandle when supported, else null
    suggestedName: 'form.mmpform',
    lastAst: null,
    lastSchema: null,
    // Undo/redo state for the rendered form's reactive data. The
    // history is rebuilt on every Process pass (the freshly-mounted
    // app exposes a new reactive root, so the previous stack would
    // point at a torn-down object). The activeFormData ref is the
    // exact reactive object the Vue app is bound to — restoring a
    // snapshot mutates it in-place via restoreInto so Vue's
    // reactivity tracking picks every change up.
    formHistory: null,
    activeFormData: null,
    // Set true by the live-preview path right before calling process();
    // read + cleared by renderPreview after the new mount installs its
    // reactive root. When set, the new mount inherits the user's
    // current edits via mergePreserveExisting so a keystroke in the
    // source pane doesn't reset the rendered form. The flag also
    // tells the history-seed path to use the merged state as the
    // seed (so undo from a live-preview tick walks back to the
    // pre-edit state, not the all-defaults state).
    preserveFormDataOnNextProcess: false
};

// ---------------------------------------------------------------
// Editor (Ace)
// ---------------------------------------------------------------

function initEditor() {
    if (typeof window.ace === 'undefined') {
        setStatus('Ace failed to load from CDN — editor disabled.', 'err');
        return;
    }
    // Tell Ace where to lazy-load language modes from. The src-min-noconflict
    // build loaded at the top of index.html doesn't include json /
    // javascript / typescript modes; setting basePath lets Ace fetch
    // them on demand the first time setMode references one.
    window.ace.config.set(
        'basePath',
        'https://cdn.jsdelivr.net/npm/ace-builds@1.43/src-min-noconflict'
    );
    editor = window.ace.edit(els.src, {
        // mmpform mode lives in viewer/mmpform-mode.js — registered with
        // Ace at script-load time, so referring to it by id is enough.
        mode:        'ace/mode/mmpform',
        theme:       'ace/theme/one_dark',
        showGutter:  true,
        showPrintMargin: false,
        wrap:        false,
        tabSize:     4,
        useSoftTabs: true,
        fontSize:    '13px',
        showLineNumbers: true,
        highlightActiveLine: true
    });

    // Process command — bound at the editor level so Ctrl+Enter fires
    // even when focus is in the editor (Ace consumes most key events,
    // so a document-level handler would never see them).
    editor.commands.addCommand({
        name:    'process',
        bindKey: { win: 'Ctrl-Enter', mac: 'Cmd-Enter' },
        exec:    () => process()
    });
    editor.commands.addCommand({
        name:    'save',
        bindKey: { win: 'Ctrl-S', mac: 'Cmd-S' },
        exec:    () => saveFile()
    });
    editor.commands.addCommand({
        name:    'open',
        bindKey: { win: 'Ctrl-O', mac: 'Cmd-O' },
        exec:    () => openFile()
    });

    // Live cursor position in the status bar. Updates on cursor
    // movement and when the editor gains focus, so the indicator
    // tracks whichever editor the user is actually working in.
    editor.session.selection.on('changeCursor', () => updateCursorPos(editor, 'Source'));
    editor.on('focus', () => updateCursorPos(editor, 'Source'));

    // Live-preview: re-Process on edit when the toolbar toggle is on.
    // Debounced so the parser doesn't run on every individual
    // keystroke. The default is OFF — re-parsing on every keystroke
    // would mask perf regressions, and the explicit Process button
    // matches the package's "honest costs" contract. Users who want
    // the live experience opt in once.
    let _liveTimer = 0;
    editor.session.on('change', () => {
        if (!els.optLivePreview?.checked) return;
        if (_liveTimer) clearTimeout(_liveTimer);
        _liveTimer = setTimeout(() => {
            _liveTimer = 0;
            // Re-entrancy guard: if process() rewrote the source
            // (auto-sync of __properties), the resulting change
            // event lands here. Setting a flag the inner call
            // would normally test is overkill — instead, suppress
            // the auto-sync rewrite during live preview so the
            // change-event loop is closed by silence. The user can
            // still click Process to get the rewrite.
            //
            // Also flag preserveFormData so the new mount inherits
            // the user's current edits where the new schema still
            // holds the binding. Without this, every keystroke in
            // the source pane would reset the rendered form to
            // post-process defaults — surprising for the user and
            // it makes the form-history feature useless under live
            // preview (each re-mount would also reset history).
            const wasAuto = els.optAutoSyncProps?.checked;
            if (els.optAutoSyncProps) els.optAutoSyncProps.checked = false;
            state.preserveFormDataOnNextProcess = true;
            try { process(); }
            finally { if (els.optAutoSyncProps) els.optAutoSyncProps.checked = wasAuto; }
        }, 300);
    });
}

function getSourceText() {
    return editor ? editor.getValue() : '';
}

function setSourceText(text) {
    if (!editor) return;
    editor.setValue(text ?? '', -1);   // -1 places cursor at start
}

// ---------------------------------------------------------------
// Object View editor (read-only Ace, mode switches per format)
// ---------------------------------------------------------------

// Map the Format selector value to (Ace mode id, file extension).
// The extension is what the Save dialog suggests; the mode id is
// what Ace uses to highlight + offer code folding.
const SCHEMA_MODES = Object.freeze({
    class:  { mode: 'ace/mode/javascript', ext: '.js'   },
    object: { mode: 'ace/mode/javascript', ext: '.js'   },
    ts:     { mode: 'ace/mode/typescript', ext: '.ts'   },
    raw:    { mode: 'ace/mode/json',       ext: '.json' },
    'vue-sfc':   { mode: 'ace/mode/html',       ext: '.vue' },
    'react-jsx': { mode: 'ace/mode/javascript', ext: '.jsx' },
    'json-schema': { mode: 'ace/mode/json',     ext: '.schema.json' }
});

function initSchemaEditor() {
    if (typeof window.ace === 'undefined' || !els.schemaMount) return;
    schemaEditor = window.ace.edit(els.schemaMount, {
        // Same dark theme as the source editor for a consistent feel.
        theme:               'ace/theme/one_dark',
        showGutter:          true,
        showPrintMargin:     false,
        showLineNumbers:     true,
        highlightActiveLine: false,
        // Code folding lives in the gutter; chevrons collapse `{...}`
        // and `[...]` chunks for JSON / JS / TS source.
        showFoldWidgets:     true,
        useSoftTabs:         true,
        tabSize:             2,
        fontSize:            '12.5px',
        readOnly:            true,
        wrap:                false
    });
    schemaEditor.setValue('(parse to infer)', -1);

    // Live cursor position — same wiring as the source editor. The
    // indicator's label tracks whichever editor most recently gained
    // focus so the operator sees which surface owns the readout.
    schemaEditor.session.selection.on('changeCursor', () => updateCursorPos(schemaEditor, 'Object View'));
    schemaEditor.on('focus', () => updateCursorPos(schemaEditor, 'Object View'));
}

// Render the cursor's row + column from `ed` into the per-pane
// indicator (in the Source pane header or the Object View pane
// toolbar) AND the legacy footer indicator. Ace's getCursorPosition
// returns 0-indexed values; we display 1-indexed (matching every
// editor's convention). The per-pane indicator drops the editor
// label because it visibly belongs to the editor it describes; the
// footer indicator keeps the label so the operator can tell which
// editor it most recently reflected.
function updateCursorPos(ed, label) {
    if (!ed) return;
    let posText = '';
    let footerText = '';
    try {
        const pos = ed.getCursorPosition();
        posText    = `Ln ${pos.row + 1}, Col ${pos.column + 1}`;
        footerText = `${label}  ${posText}`;
    } catch { /* getCursorPosition can throw mid-init; leave the indicators blank */ }

    const paneEl = ed === schemaEditor ? els.schemaCursorPos : els.srcCursorPos;
    if (paneEl)         paneEl.textContent       = posText;
    if (els.cursorPos)  els.cursorPos.textContent = footerText;
}

function getSchemaText() {
    return schemaEditor ? schemaEditor.getValue() : '';
}

// Editor row-markers for parse failures. Each marker highlights the
// failing line via Ace's session.addMarker(). Cleared at the start
// of every Process pass so a successful re-parse drops the previous
// marker. The `_errorMarkers` Set tracks marker IDs so we can
// remove them surgically without disturbing user-added markers (Ace
// doesn't currently let us, but the API takes IDs so we keep ours).
const _errorMarkers = new Set();
function clearErrorMarkers() {
    if (!editor) return;
    for (const id of _errorMarkers) editor.session.removeMarker(id);
    _errorMarkers.clear();
}
function applyErrorMarkersFromMessages(messages) {
    if (!editor || !window.ace) return;
    const Range = window.ace.require('ace/range').Range;
    if (!Range) return;
    const seen = new Set();
    for (const msg of messages) {
        // ParseError.toMessage() produces "line N, col M: text" when
        // location is known. Pull every such mention so multi-line
        // diagnostics each get their own marker.
        const m = /line (?<line>\d+)(?:, col (?<col>\d+))?/.exec(msg);
        if (!m) continue;
        const line = parseInt(m.groups.line, 10) - 1;
        if (line < 0 || seen.has(line)) continue;
        seen.add(line);
        const range = new Range(line, 0, line, Number.MAX_SAFE_INTEGER);
        const id = editor.session.addMarker(range, 'fb-parse-error-row', 'fullLine', false);
        _errorMarkers.add(id);
    }
}

function setSchemaText(text, formatKey) {
    if (!schemaEditor) return;
    const target = SCHEMA_MODES[formatKey];
    if (target) schemaEditor.session.setMode(target.mode);
    // Use session.setValue + clearSelection so the cursor doesn't
    // jump and the read-only banner doesn't briefly highlight.
    schemaEditor.session.setValue(text ?? '');
    schemaEditor.clearSelection();
    schemaEditor.session.setScrollTop(0);
}

// ---------------------------------------------------------------
// Wrap toggle
// ---------------------------------------------------------------

els.optWrap.addEventListener('change', () => {
    // Wrap mode lives on the Ace session; the body class flip the
    // textarea-era code did is no longer needed (the .wrap CSS rule
    // is a no-op per viewer.css:118).
    if (editor) editor.session.setUseWrapMode(els.optWrap.checked);
});

// Live-preview toggle — re-Process on every flip so the rendered
// preview reflects the current source the moment the operator
// changes mode. Without this, the preview would still show whatever
// the previous explicit Process produced (which may be stale if the
// operator typed since the last Process). preserveFormDataOnNextProcess
// is set so the user's in-flight edits to the rendered form survive
// the toggle — the same protection the per-keystroke live-preview
// path uses, applied here because flipping the mode is also a moment
// where losing the form data would surprise the user.
if (els.optLivePreview) {
    els.optLivePreview.addEventListener('change', () => {
        state.preserveFormDataOnNextProcess = true;
        process();
    });
}

// ---------------------------------------------------------------
// Splitter drag
// ---------------------------------------------------------------

(() => {
    const root = $('#root');
    // Bind move + up listeners only while dragging. Without this,
    // every mousemove on the page would fire the listener and skip
    // through the early-return — cheap per call, but unnecessary
    // work for the lifetime of the page.
    const onMove = (e) => {
        const rect = root.getBoundingClientRect();
        const pct  = ((e.clientX - rect.left) / rect.width) * 100;
        const clamped = Math.max(15, Math.min(85, pct));
        els.leftPanel.style.flexBasis = `${clamped}%`;
    };
    const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
    };
    els.splitter.addEventListener('mousedown', (e) => {
        e.preventDefault();
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup',   onUp);
    });
})();

// ---------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------

document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        const target = tab.dataset.tab;
        document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
        document.querySelectorAll('.tab-pane').forEach(p => {
            p.classList.toggle('active', p.dataset.tab === target);
        });
    });
});

// ---------------------------------------------------------------
// Open / Save (.mmpform)
// ---------------------------------------------------------------

const HAS_FS = typeof window.showOpenFilePicker === 'function';

els.btnOpen.addEventListener('click', openFile);
els.btnSave.addEventListener('click', saveFile);

async function openFile() {
    try {
        if (HAS_FS) {
            const [handle] = await window.showOpenFilePicker({
                types: [{
                    description: 'FormBuilder DSL',
                    accept: { 'text/plain': ['.mmpform'] }
                }],
                multiple: false
            });
            const file = await handle.getFile();
            const text = await file.text();
            state.fileHandle    = handle;
            state.suggestedName = file.name;
            setEditorText(text, file.name);
            setStatus(`Loaded ${file.name}`, 'ok');
        } else {
            // Fallback: hidden <input type=file>
            const input = document.createElement('input');
            input.type   = 'file';
            input.accept = '.mmpform,text/plain';
            input.onchange = async () => {
                const f = input.files?.[0];
                if (!f) return;
                const text = await f.text();
                state.fileHandle = null;
                state.suggestedName = f.name;
                setEditorText(text, f.name + '  (no in-place save)');
                setStatus(`Loaded ${f.name} (browser fallback — Save will download)`, 'warn');
            };
            input.click();
        }
    } catch (e) {
        if (e.name !== 'AbortError') setStatus(`Open failed: ${e.message}`, 'err');
    }
}

async function saveFile() {
    const text = getSourceText();
    try {
        if (HAS_FS && state.fileHandle) {
            const writable = await state.fileHandle.createWritable();
            await writable.write(text);
            await writable.close();
            setStatus(`Saved ${state.suggestedName}`, 'ok');
            return;
        }
        if (HAS_FS) {
            // No handle yet — ask for save location
            const handle = await window.showSaveFilePicker({
                suggestedName: state.suggestedName,
                types: [{ description: 'FormBuilder DSL', accept: { 'text/plain': ['.mmpform'] } }]
            });
            state.fileHandle = handle;
            state.suggestedName = handle.name;
            const writable = await handle.createWritable();
            await writable.write(text);
            await writable.close();
            els.filename.textContent = handle.name;
            setStatus(`Saved ${handle.name}`, 'ok');
            return;
        }
        // Fallback: download
        downloadBlob(text, state.suggestedName, 'text/plain');
        setStatus(`Downloaded ${state.suggestedName} (browser fallback)`, 'warn');
    } catch (e) {
        if (e.name !== 'AbortError') setStatus(`Save failed: ${e.message}`, 'err');
    }
}

function setEditorText(text, filenameLabel) {
    setSourceText(text);
    els.filename.textContent = filenameLabel ?? '(no file)';
    process();
}

// ---------------------------------------------------------------
// Process: parse + render preview + infer schema
// ---------------------------------------------------------------

els.btnProcess.addEventListener('click', process);
els.fwSelect.addEventListener('change', () => {
    applyFrameworkToolbarVisibility();
    applyFrameworkPaneVisibility();
    renderPreview();
});
els.vueTheme.addEventListener('change', renderPreview);
els.previewWidth.addEventListener('change', renderPreview);
els.btnRerender.addEventListener('click', renderPreview);
els.schemaFormat.addEventListener('change', renderSchema);
els.schemaName.addEventListener('input',  renderSchema);

// process() may rewrite the source pane via syncPropertiesBlockToSource()
// near the bottom of this function. Do NOT bind process() to a
// session.on('change') handler without a re-entrancy guard — the
// rewrite would fire process() again, and a partially-rendered AST
// could throw on the second pass. Today nothing listens for the
// value-change event, so the recursion is closed by silence.
function process() {
    const text = getSourceText();
    const result = new TextFormBuilder({ schemaText: text }).process();
    clearErrorMarkers();
    // Clear the preview-pane error banner up-front. The failure path
    // re-populates it; the success path leaves it hidden. Doing the
    // clear here (rather than inside the success branch) means a
    // success after a Vue-render failure also clears that previous
    // banner, since both failure surfaces route through the same
    // showPreviewError sink.
    hidePreviewError();
    if (result.error !== ERR.OK) {
        state.lastAst = null;
        state.lastSchema = null;
        // Drop form-history state too. The orphaned activeFormData
        // pointer would otherwise carry into the next successful
        // mount — and the leftover preserveFormDataOnNextProcess flag
        // (set by the live-preview wrapper BEFORE this tick fired,
        // never cleared because the early return below skips the
        // reader in renderPreview) would hand the recovery a stale
        // snapshot. Clearing all three together makes the recovery
        // start fresh, matching the user's expectation that fixing
        // a parse error returns the form to a clean re-mount.
        state.activeFormData = null;
        state.formHistory = null;
        state.preserveFormDataOnNextProcess = false;
        refreshFormHistoryUi();
        // Surface the parse failure in the framework-agnostic banner
        // so the operator sees the diagnostics regardless of which
        // renderer was selected. The two underlying preview surfaces
        // (ASCII <pre> and Vue mount) are blanked back to their
        // placeholders so a stale rendered form doesn't sit under the
        // banner pretending the source still produces it.
        showPreviewError(
            `Parse failed (${errorName(result.error)})`,
            result.messages.join('\n')
        );
        els.previewAscii.textContent = '(parse failed — see banner above)';
        teardownVue();
        els.vueMount.textContent = '';
        // Highlight the failing row in the editor. ParseError messages
        // formatted by toMessage() lead with `line N, col M:` when
        // location info is known; pull the first such mention to mark
        // the row so the author sees where to look without reading
        // every diagnostic.
        applyErrorMarkersFromMessages(result.messages);
        // Object View carries the same diagnostics so the user can
        // copy/search them without flipping back to the source pane.
        setSchemaText(
            `// Parse failed (${errorName(result.error)})\n\n` +
            result.messages.map(m => `// ${m}`).join('\n'),
            'class'
        );
        setStatus(`${errorName(result.error)} — ${result.messages[0] ?? ''}`, 'err');
        els.counts.textContent = '';
        return;
    }
    state.lastAst    = result.payload;
    state.lastSchema = inferDataSchema(result.payload);
    // Reflect the freshly-collected __properties dictionary back into
    // the Source panel so the user can see exactly what the processor
    // recorded — matches the contract that Process is the writer of
    // record for that block. The toolbar toggle lets a user opt out
    // when they want to hand-edit the block (auto-sync would
    // otherwise overwrite the manual edits on every Process).
    if (els.optAutoSyncProps?.checked !== false) {
        syncPropertiesBlockToSource(result.payload.__properties);
    }
    renderPreview();
    renderSchema();
    const fields = state.lastSchema.fields.length;
    const fns    = state.lastSchema.functions.length;
    const props  = Object.keys(result.payload.__properties ?? {}).length;
    els.counts.textContent =
        `${fields} field${fields === 1 ? '' : 's'} · ${fns} function${fns === 1 ? '' : 's'} · ${props} propert${props === 1 ? 'y' : 'ies'}`;
    setStatus('OK', 'ok');
}

// Replace any existing `__properties = [...]` block in the source with
// the canonical text the processor just produced — and if the source
// doesn't have one yet, insert it after the `columns: N` declaration.
//
// The Ace cursor and scroll position are restored after the swap so the
// click on Process doesn't yank the user's view away from where they
// were editing.
function syncPropertiesBlockToSource(properties) {
    if (!editor || properties == null) return;

    const original = editor.getValue();

    // Skip the rewrite when the source's existing block already
    // parses, in isolation, to the same dictionary the canonical
    // block would. The canonical text might still differ (the parser
    // canonicalises numeric-string defaults like "30" → 30 for an
    // int property), but the user's typed form is the source of
    // truth they care about — rewriting it would read as their edit
    // being silently reverted on every Process pass. The gate is
    // defensive: any malformed block, parse error, or genuine
    // semantic difference falls through to the canonical rewrite.
    if (arePropertiesSemanticallyEqual(original, properties)) return;

    const block   = renderPropertiesBlock(properties);
    const updated = spliceProperties(original, block);
    if (updated === original) return;

    const cursor = editor.getCursorPosition();
    const scroll = { top: editor.session.getScrollTop(), left: editor.session.getScrollLeft() };
    editor.session.setValue(updated);
    editor.moveCursorToPosition(cursor);
    editor.session.setScrollTop(scroll.top);
    editor.session.setScrollLeft(scroll.left);
    editor.clearSelection();
}

// Pure text transform: strip any existing `__properties = [...]` block
// from the source, then insert `block` after the `columns: N` line. If
// no `columns:` line is found, prepend the block. Surrounding blank
// lines are normalised so the inserted block always sits with one
// blank line above and below.
function spliceProperties(source, block) {
    // Eat the existing block plus any blank lines on either side so the
    // splice point doesn't accumulate extra newlines on repeated runs.
    // The strip walks bracket-aware so a `]` inside a string default
    // doesn't end the block early; matches `__properties = [ ... ]`
    // on a single line as well as the canonical multi-line form.
    const stripped = stripExistingPropertiesBlock(source);

    const columnsMatch = stripped.match(/^\s*columns\s*:\s*\d+\s*$/m);
    if (columnsMatch) {
        const idx  = stripped.indexOf(columnsMatch[0]) + columnsMatch[0].length;
        // Trim any whitespace the columns regex pulled into its match
        // so the splice point sits flush against the declaration, then
        // re-establish a single blank line on each side of the block.
        const head = stripped.slice(0, idx).replace(/\s+$/, '');
        const tail = stripped.slice(idx).replace(/^\s*/, '');
        return `${head}\n\n${block}\n\n${tail}`;
    }
    return `${block}\n\n${stripped.replace(/^\s*/, '')}`;
}

// Bracket-aware strip of an existing `__properties = [ ... ]` block.
// Walks the source looking for the keyword at column 0 of any line,
// then advances past the `=` and the opening `[` while counting
// nesting and skipping through string literals so a `]` inside a
// quoted default does not close the block early. Returns the source
// with the block + surrounding blank lines collapsed to one blank
// line so repeated splices do not stack newlines.
//
// The walker handles three shapes:
//   - canonical multi-line `__properties = [\n  "name" = {...},\n]`
//   - single-line `__properties = ["name" = {...}]`
//   - empty `__properties = []`
function stripExistingPropertiesBlock(source) {
    const kw = '__properties';
    let kwIdx = -1;
    // Find the keyword at the start of a (possibly indented) line.
    for (let i = 0; i < source.length; i++) {
        if (i > 0 && source[i - 1] !== '\n') continue;
        if (source.slice(i, i + kw.length) !== kw) continue;
        const after = source[i + kw.length];
        if (after !== ' ' && after !== '\t' && after !== '=') continue;
        kwIdx = i;
        break;
    }
    if (kwIdx === -1) return source;

    // Walk past whitespace, then `=`, then whitespace, then `[`.
    let p = kwIdx + kw.length;
    while (p < source.length && (source[p] === ' ' || source[p] === '\t')) p++;
    if (source[p] !== '=') return source;        // malformed; leave alone
    p++;
    while (p < source.length && (source[p] === ' ' || source[p] === '\t' || source[p] === '\n')) p++;
    if (source[p] !== '[') return source;
    p++;

    // Bracket-counting walk to the matching `]`. String literals
    // (single or double quoted, with the same backslash-escape rule
    // the outer DSL grammar uses) are skipped wholesale.
    let depth = 1;
    while (p < source.length && depth > 0) {
        const c = source[p];
        if (c === '"' || c === "'") {
            const quote = c;
            p++;
            while (p < source.length && source[p] !== quote) {
                if (source[p] === '\\' && p + 1 < source.length) { p += 2; continue; }
                p++;
            }
            p++;                                  // skip the closing quote
            continue;
        }
        if (c === '[') depth++;
        else if (c === ']') depth--;
        p++;
    }
    if (depth !== 0) return source;              // unbalanced; leave alone
    // Eat any trailing comment / whitespace on the closing line so
    // the splice point doesn't leave a half-line behind.
    while (p < source.length && source[p] !== '\n' && source[p] !== '\r') p++;

    // Trim surrounding blank lines so repeated splices don't stack.
    let start = kwIdx;
    while (start > 0 && (source[start - 1] === '\n' || source[start - 1] === ' ' || source[start - 1] === '\t' || source[start - 1] === '\r')) start--;
    let end = p;
    while (end < source.length && (source[end] === '\n' || source[end] === '\r' || source[end] === ' ' || source[end] === '\t')) end++;

    return source.slice(0, start) + '\n\n' + source.slice(end);
}

function renderPreview() {
    if (!state.lastAst) return;
    const fw = els.fwSelect.value;

    if (fw === 'ascii') {
        const width = parseInt(els.previewWidth.value, 10) || 128;
        els.previewAscii.textContent = renderFormPreview(state.lastAst, { width });
        teardownVue();
        return;
    }

    if (fw === 'vuetify') {
        // Capture the user's current data state BEFORE the re-mount
        // when the preserve flag is set (live-preview path). The
        // capture happens here, not in the live-preview handler,
        // because the mount happens inside this function — keeping
        // the capture local avoids leaking the snapshot through
        // module-level state.
        const preserveData = state.preserveFormDataOnNextProcess;
        state.preserveFormDataOnNextProcess = false;
        const carryOver = (preserveData && state.activeFormData)
            ? structuredClone(state.activeFormData)
            : null;

        try {
            const mounted = mountVueRenderer(els.vueMount, state.lastAst, state.lastSchema, {
                theme: els.vueTheme.value,
                // Hand the renderer the Live Data tab's <pre> so its
                // watch can pretty-print the form's reactive state
                // into it on every change.
                dataInspectorEl: els.liveData,
                // Each debounced reactive change pushes a snapshot
                // into the undo history.
                onDataChange: (data) => {
                    if (!state.formHistory) return;
                    if (state.formHistory.snapshot(data)) refreshFormHistoryUi();
                }
            });
            if (mounted?.data) {
                // If the live-preview path carried over the user's
                // edits, merge them into the new reactive root so
                // bindings the new schema still holds keep the user's
                // values. Bindings the new schema removed disappear;
                // bindings the new schema added keep their fresh
                // defaults. The merge runs BEFORE the new history is
                // seeded so the seed reflects the merged state — undo
                // from here walks back to the post-merge seed, not
                // the all-defaults state.
                //
                // BOTH the skip-set collection and the merge call
                // run inside their own try blocks. A throw out of
                // either one would otherwise propagate to the outer
                // catch (which paints a "Vue render failed" pre over
                // the just-mounted form), and the user's symptom is
                // "the form never comes back after a parse error
                // recovery" — that's the failure mode this guards.
                if (carryOver) {
                    // Skip-set: compute={@fn} bindings own their own
                    // value via the renderer's watchEffect. The merge
                    // would otherwise plant the snapshot's stale
                    // computed value and the watchEffect wouldn't
                    // re-fire until a dep changed — wrong number
                    // sitting in the UI.
                    let skipBindings;
                    try { skipBindings = collectComputeBindings(state.lastAst); }
                    catch (e) {
                        console.warn('[viewer] collectComputeBindings threw:', e);
                        skipBindings = new Set();
                    }
                    try { mergePreserveExisting(mounted.data, carryOver, { skipBindings }); }
                    catch (e) { console.warn('[viewer] preserve-data merge threw:', e); }
                }
                state.activeFormData = mounted.data;
                state.formHistory = createFormHistory(mounted.data);
                refreshFormHistoryUi();
            } else {
                state.activeFormData = null;
                state.formHistory = null;
                refreshFormHistoryUi();
            }
        } catch (e) {
            // Route Vue render failures through the same banner the
            // parse-failure path uses so the operator has one place
            // to look for "why is the preview not rendering." The
            // mount is blanked so a half-built DOM from a partially
            // applied render doesn't sit under the banner.
            showPreviewError(
                'Vue render failed',
                `${e.message}\n\n${e.stack ?? ''}`
            );
            els.vueMount.textContent = '';
            setStatus(`Vue render failed: ${e.message}`, 'err');
            state.activeFormData = null;
            state.formHistory = null;
            refreshFormHistoryUi();
        }
    }
}

// ---------------------------------------------------------------
// Form-state undo / redo
// ---------------------------------------------------------------

function refreshFormHistoryUi() {
    const info = state.formHistory ? state.formHistory.info() : { canUndo: false, canRedo: false, editsAhead: 0 };
    if (els.btnFormUndo)  els.btnFormUndo.disabled  = !info.canUndo;
    if (els.btnFormRedo)  els.btnFormRedo.disabled  = !info.canRedo;
    if (els.btnFormReset) els.btnFormReset.disabled = !info.canUndo;
    if (els.formEditsBadge) {
        if (info.editsAhead > 0) {
            els.formEditsBadge.textContent = `${info.editsAhead} edit${info.editsAhead === 1 ? '' : 's'}`;
            els.formEditsBadge.classList.add('show');
        } else {
            els.formEditsBadge.textContent = '';
            els.formEditsBadge.classList.remove('show');
        }
    }
}

function applyHistorySnapshot(snapshot) {
    if (!state.activeFormData || snapshot == null) return;
    restoreInto(state.activeFormData, snapshot);
    refreshFormHistoryUi();
}

function undoFormEdit() {
    if (!state.formHistory) return;
    const snap = state.formHistory.undo();
    if (snap == null) return;
    applyHistorySnapshot(snap);
    // No toast — the badge update + the visible form change are
    // already enough signal. Repeated Ctrl+Z would otherwise pop a
    // fresh toast on every keystroke and clutter the chrome.
}

function redoFormEdit() {
    if (!state.formHistory) return;
    const snap = state.formHistory.redo();
    if (snap == null) return;
    applyHistorySnapshot(snap);
    // No toast — same reasoning as undoFormEdit.
}

function resetForm() {
    if (!state.formHistory) return;
    if (!state.formHistory.info().canUndo) return;
    // seekToSeed is an O(1) jump to the seed snapshot AND truncates
    // the redo branch so Reset is a hard reset (Ctrl+Y after Reset
    // does nothing — the pre-reset edits are gone, matching the
    // button's name). The previous "loop undo() back to zero"
    // implementation was O(N) deep clones for nothing and left the
    // redo branch intact, which let Redo walk forward through edits
    // the user just discarded.
    const snap = state.formHistory.seekToSeed();
    if (snap != null) {
        applyHistorySnapshot(snap);
        setStatus('Form reset to post-process state', 'ok');
    }
}

if (els.btnFormUndo)  els.btnFormUndo.addEventListener('click',  undoFormEdit);
if (els.btnFormRedo)  els.btnFormRedo.addEventListener('click',  redoFormEdit);
if (els.btnFormReset) els.btnFormReset.addEventListener('click', resetForm);

// The renderer dispatches `fb-renderer-status` for in-renderer events
// the host might want to surface (the directoryBrowser API-not-supported
// case is the present-day source). Forwarding into the existing toast
// keeps the host's status surface authoritative — no alert() pop-ups
// from inside the rendered form.
window.addEventListener('fb-renderer-status', (e) => {
    const detail = e.detail ?? {};
    setStatus(detail.message ?? '(no message)', detail.kind ?? 'warn');
});

function renderSchema() {
    if (!state.lastSchema) return;
    const fmt  = els.schemaFormat.value;
    const name = els.schemaName.value || 'FormData';
    let text;
    switch (fmt) {
        case 'class':       text = scaffoldDataClass(state.lastSchema, name);  break;
        case 'object':      text = scaffoldDataObject(state.lastSchema);       break;
        case 'ts':          text = scaffoldTypeScript(state.lastSchema, name); break;
        case 'raw':         text = JSON.stringify(state.lastSchema, null, 2);  break;
        case 'vue-sfc':     text = scaffoldVueSfc(state.lastSchema, name);     break;
        case 'react-jsx':   text = scaffoldReactJsx(state.lastSchema, name);   break;
        case 'json-schema': text = JSON.stringify(scaffoldJsonSchema(state.lastSchema, name), null, 2); break;
        default:            text = '(unknown format)';
    }
    setSchemaText(text, fmt);
    // Re-apply the user's "fold all" preference if it's on so a
    // freshly-rendered output starts collapsed instead of expanded.
    // The toggle wins over any per-region unfold the user did
    // before changing the format selector — that's the right
    // product behaviour (the toggle is the user's stated intent),
    // even though the read could be mistaken for "preserve user
    // selection." Re-renders that don't change the format leave
    // the user's selections alone (this branch only fires when
    // setSchemaText replaces the editor contents).
    if (els.schemaFoldAll && els.schemaFoldAll.checked) {
        applySchemaFoldAll(true);
    }
}

// ---------------------------------------------------------------
// Object-View scaffold output formats. Three additional formats sit
// alongside the package's built-in `scaffoldDataClass`,
// `scaffoldDataObject`, `scaffoldTypeScript`, and the raw JSON
// passthrough. They are starter stubs — copy/paste-ready code the
// consumer fills in. The viewer keeps these local rather than
// pushing them into the package because they are framework-shaped
// (Vue, React, JSON Schema) and the package itself stays
// framework-agnostic.

function scaffoldVueSfc(schema, name) {
    // Vue 3 single-file-component stub. Imports the package, parses
    // the inline `.mmpform` source, walks the AST with the package's
    // walkAst helper, and dispatches each control to a per-type
    // component map. The consumer fills in each component's body
    // (or replaces the whole map with Vuetify, PrimeVue, naive-ui,
    // or any other component library).
    const fields = schema.fields ?? [];
    const dataInit = fields.length === 0
        ? '{}'
        : '{\n' + fields.map(f => `    ${jsKey(f.path)}: ${f.type?.defaultValue ?? "''"}`).join(',\n') + '\n}';
    return `<!--
  ${name}.vue — Vue 3 starter generated by FormBuilderDSL.
  Replace the inline schemaText with your own .mmpform source.
  The CONTROL_COMPONENTS map at the top picks which Vue component
  renders each control type — swap in Vuetify, PrimeVue, naive-ui,
  or your own components. The walker dispatches by ctl.controlType.
-->
<script setup>
import { reactive, h } from 'vue';
import { TextFormBuilder, walkAst } from '@mmpworks/formbuilder-dsl';

// Map control types to Vue components. Each component receives:
//   props: { ctl, modelValue }     ctl is the AST node, modelValue is the bound value
//   emits: 'update:modelValue'      v-model handshake
const CONTROL_COMPONENTS = {
    textfield:   (ctl, value, update) => h('input', { type: 'text',     value, onInput: e => update(e.target.value) }),
    textarea:    (ctl, value, update) => h('textarea',                   { value, onInput: e => update(e.target.value) }),
    number:      (ctl, value, update) => h('input', { type: 'number',   value, onInput: e => update(Number(e.target.value)) }),
    check:       (ctl, value, update) => h('input', { type: 'checkbox', checked: value, onChange: e => update(e.target.checked) }),
    select:      (ctl, value, update) => h('select', { value, onChange: e => update(e.target.value) }, []),
    // ...add an arm per control type your form uses.
};

const schemaText = \`
columns: 10

[container({title})]

  // your form here
\`;

const result = new TextFormBuilder({ schemaText }).process();
const ast    = result.payload;
const data   = reactive(${dataInit});

// Build a flat list of (ctl, getter, setter) triples for the
// template's v-for loop. walkAst visits every node; we filter to
// controls that have a writeable binding.
const fields = [];
walkAst(ast, (n) => {
    if (n.nodeKind !== 'control' || !n.binding || n.binding.startsWith('@')) return;
    fields.push({
        ctl: n,
        path: n.binding,
        get: () => getDeep(data, n.binding),
        set: (v) => setDeep(data, n.binding, v)
    });
});

function getDeep(obj, path) {
    return path.split('.').reduce((o, k) => o?.[k], obj);
}
function setDeep(obj, path, value) {
    const parts = path.split('.');
    const last = parts.pop();
    let cur = obj;
    for (const k of parts) cur = cur[k] ?? (cur[k] = {});
    cur[last] = value;
}

function renderControl(field) {
    const renderer = CONTROL_COMPONENTS[field.ctl.controlType];
    if (!renderer) return h('span', null, \`(no renderer for \${field.ctl.controlType})\`);
    return renderer(field.ctl, field.get(), field.set);
}
</script>

<template>
    <div class="${name.toLowerCase()}-form">
        <h2>{{ ast?.root?.title?.[0]?.text ?? '${name}' }}</h2>
        <div v-for="f in fields" :key="f.path" class="field">
            <label>{{ f.ctl.label?.[0]?.text ?? f.path }}</label>
            <component :is="{ render: () => renderControl(f) }" />
        </div>
    </div>
</template>
`;
}

function scaffoldReactJsx(schema, name) {
    // React 18+ stub. Same per-control map shape as the Vue stub:
    // CONTROL_COMPONENTS dispatches by ctl.controlType. Walker
    // populates a flat fields array; component renders each field
    // via CONTROL_COMPONENTS lookup.
    const fields = schema.fields ?? [];
    const dataInit = fields.length === 0
        ? '{}'
        : '{\n' + fields.map(f => `    ${jsKey(f.path)}: ${f.type?.defaultValue ?? "''"}`).join(',\n') + '\n}';
    return `// ${name}.jsx — React 18+ starter generated by FormBuilderDSL.
// Replace the inline schemaText with your own .mmpform source.
// The CONTROL_COMPONENTS map picks which React component renders
// each control type — swap in MUI, Mantine, Chakra, or your own
// components. The walker dispatches by ctl.controlType.

import { useMemo, useReducer } from 'react';
import { TextFormBuilder, walkAst } from '@mmpworks/formbuilder-dsl';

const CONTROL_COMPONENTS = {
    textfield: ({ value, onChange }) =>
        <input type="text" value={value ?? ''} onChange={e => onChange(e.target.value)} />,
    textarea: ({ value, onChange }) =>
        <textarea value={value ?? ''} onChange={e => onChange(e.target.value)} />,
    number: ({ value, onChange }) =>
        <input type="number" value={value ?? 0} onChange={e => onChange(Number(e.target.value))} />,
    check: ({ value, onChange }) =>
        <input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} />,
    select: ({ value, onChange }) =>
        <select value={value ?? ''} onChange={e => onChange(e.target.value)} />,
    // ...add an arm per control type your form uses.
};

const schemaText = \`
columns: 10

[container({title})]

  // your form here
\`;

function getDeep(obj, path) {
    return path.split('.').reduce((o, k) => o?.[k], obj);
}
function setDeep(obj, path, value) {
    const parts = path.split('.');
    const last = parts.pop();
    let cur = obj;
    for (const k of parts) cur = cur[k] ?? (cur[k] = {});
    cur[last] = value;
}

export function ${name}() {
    const ast = useMemo(
        () => new TextFormBuilder({ schemaText }).process().payload,
        []
    );
    const [data, dispatch] = useReducer((state, { path, value }) => {
        const next = { ...state };
        setDeep(next, path, value);
        return next;
    }, ${dataInit});

    const fields = useMemo(() => {
        const list = [];
        walkAst(ast, (n) => {
            if (n.nodeKind !== 'control' || !n.binding || n.binding.startsWith('@')) return;
            list.push({ ctl: n, path: n.binding });
        });
        return list;
    }, [ast]);

    return (
        <div className="${name.toLowerCase()}-form">
            <h2>{ast?.root?.title?.[0]?.text ?? '${name}'}</h2>
            {fields.map(f => {
                const Component = CONTROL_COMPONENTS[f.ctl.controlType];
                if (!Component) return <span key={f.path}>(no renderer for {f.ctl.controlType})</span>;
                return (
                    <div key={f.path} className="field">
                        <label>{f.ctl.label?.[0]?.text ?? f.path}</label>
                        <Component
                            value={getDeep(data, f.path)}
                            onChange={v => dispatch({ path: f.path, value: v })}
                        />
                    </div>
                );
            })}
        </div>
    );
}
`;
}

// JSON Schema scaffolder lives in the package now (scaffoldJsonSchema
// at /infer-schema). The viewer just JSON.stringify's its output.

function jsKey(path) {
    // Object-literal key emitter. Bare identifiers stay bare; dotted
    // paths and any path with a bracket get quoted. Repeater paths
    // (`arr[].x`) stay quoted because of the brackets.
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(path)) return path;
    return JSON.stringify(path);
}

// Fold (or unfold) every collapsible region in the schema editor.
// Uses Ace's session.foldAll / session.unfold APIs; both are no-ops
// when the active mode has no fold rules (Ace's plain-text mode).
function applySchemaFoldAll(fold) {
    if (!schemaEditor) return;
    if (fold) {
        // foldAll(startRow, endRow, depth). Without args it folds
        // every region at the outermost depth, which is the behaviour
        // a "collapse everything" toggle should have.
        schemaEditor.session.foldAll();
    } else {
        schemaEditor.session.unfold();
    }
}

// ---------------------------------------------------------------
// Schema: copy + save
// ---------------------------------------------------------------

els.btnCopy.addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText(getSchemaText());
        setStatus('Schema copied to clipboard', 'ok');
    } catch (e) {
        setStatus(`Copy failed: ${e.message}`, 'err');
    }
});

// Fold-all toggle and Unfold-all button. Folding is per-session, so
// switching the format selector resets the editor's session and the
// fold state goes with it; the toggle re-applies on every render.
if (els.schemaFoldAll) {
    els.schemaFoldAll.addEventListener('change', () => {
        applySchemaFoldAll(els.schemaFoldAll.checked);
    });
}
if (els.btnSchemaUnfoldAll) {
    els.btnSchemaUnfoldAll.addEventListener('click', () => {
        if (els.schemaFoldAll) els.schemaFoldAll.checked = false;
        applySchemaFoldAll(false);
    });
}

if (els.btnCopyData) {
    els.btnCopyData.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(els.liveData.textContent);
            setStatus('Live data JSON copied to clipboard', 'ok');
        } catch (e) {
            setStatus(`Copy failed: ${e.message}`, 'err');
        }
    });
}

els.btnSaveSchema.addEventListener('click', async () => {
    const fmt  = els.schemaFormat.value;
    const name = els.schemaName.value || 'FormData';
    const ext  = SCHEMA_MODES[fmt]?.ext ?? '.js';
    const filename = `${name}${ext}`;
    const text = getSchemaText();
    try {
        if (HAS_FS) {
            const handle = await window.showSaveFilePicker({
                suggestedName: filename,
                types: [{
                    description: ext === '.ts' ? 'TypeScript' : ext === '.json' ? 'JSON' : 'JavaScript',
                    accept: { 'text/plain': [ext] }
                }]
            });
            const writable = await handle.createWritable();
            await writable.write(text);
            await writable.close();
            setStatus(`Saved ${handle.name}`, 'ok');
        } else {
            downloadBlob(text, filename, 'text/plain');
            setStatus(`Downloaded ${filename}`, 'ok');
        }
    } catch (e) {
        if (e.name !== 'AbortError') setStatus(`Save failed: ${e.message}`, 'err');
    }
});

function downloadBlob(text, filename, mime) {
    const blob = new Blob([text], { type: mime });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------

function setStatus(msg, kind = 'ok') {
    els.statusText.className = kind;
    els.statusText.textContent = msg;
    showToast(msg, kind);
}

// Preview-pane error banner. The banner lives inside the Render
// Preview tab pane, between the framework toolbar and the rendered
// output, and is framework-agnostic — the same parse failure or
// render-time exception reads the same whether the operator is
// looking at the Vuetify or the ASCII renderer. Hidden by default;
// showPreviewError pops it, hidePreviewError tucks it away. The
// banner is intentionally NOT painted on the Live Data or Object
// View tabs; those panes carry their own diagnostics surface (Live
// Data goes blank, Object View receives the messages as // comments
// via setSchemaText). Switching back to the Render Preview tab
// re-reveals the banner if the underlying error is still in play.
function showPreviewError(title, body) {
    if (!els.previewError) return;
    if (els.previewErrorTitle) els.previewErrorTitle.textContent = title ?? 'Error';
    if (els.previewErrorBody)  els.previewErrorBody.textContent  = body  ?? '';
    els.previewError.hidden = false;
}
function hidePreviewError() {
    if (!els.previewError) return;
    els.previewError.hidden = true;
    if (els.previewErrorTitle) els.previewErrorTitle.textContent = '';
    if (els.previewErrorBody)  els.previewErrorBody.textContent  = '';
}

// Corner-toast notification. Hidden by default; setStatus() pops it
// for ~3.5 seconds on every status change so Save / Open / Process
// outcomes are visible without watching the status bar. Re-firing
// while a toast is up swaps the message in place — the timer resets.
//
// Module-scope timer because there is one toast in this UI. If a
// future refactor adds a second status pane (e.g. a separate Vue-
// app status), promote the timer to a Map keyed by the toast
// element so two panes don't share state.
let _toastTimer = 0;
function showToast(msg, kind = 'ok') {
    const el = els.toast;
    if (!el) return;
    el.textContent = msg;
    el.className = `toast show toast-${kind}`;
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => {
        el.classList.remove('show');
    }, 3500);
}

// ---------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------

// Document-level keyboard shortcuts. Mirror the Ace command bindings so
// the same shortcuts work whether focus is in the editor or anywhere else
// on the page (toolbar buttons, schema pane, etc.). Skip the binding
// when focus is in a non-editor INPUT or TEXTAREA so the user typing
// Ctrl+S in the schema-name field does not accidentally save the
// source pane. Ace's editor mounts as a contenteditable div, not an
// INPUT, so the editor-side bindings still fire.
document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;

    // Form-edit undo / redo. Fires when focus is on (or inside) a
    // data-bound input the renderer emits — every such input carries
    // an id of the shape `fb-input-<binding>-<line>` (the second gate
    // tests for that). Inputs inside a teleported VDialog overlay
    // also count, so editing a list-item field in the listManager
    // dialog can be undone by Ctrl+Z.
    //
    // Focused elements that AREN'T data-bound inputs — the
    // listManager search field, the row Edit/Delete icon-buttons,
    // the drag handle — fall through to the browser's default. That
    // matches the user's expectation: Ctrl+Z on a button is a no-op,
    // Ctrl+Z while typing in a transient filter is the browser's
    // native text undo, not a form-data revert.
    if (state.formHistory && isInsideRenderedForm(e.target)
        && isFormDataBoundInput(e.target)) {
        if (e.key === 'z' && !e.shiftKey)                       { e.preventDefault(); undoFormEdit(); return; }
        if (e.key === 'y' || (e.key === 'z' && e.shiftKey))     { e.preventDefault(); redoFormEdit(); return; }
    }

    const tag = e.target?.tagName;
    // Source-pane / schema-pane shortcuts only fire OUTSIDE editable
    // elements so typing Ctrl+S in the schema-name field doesn't
    // accidentally save the source pane.
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === 's')        { e.preventDefault(); saveFile(); }
    else if (e.key === 'o')   { e.preventDefault(); openFile(); }
    else if (e.key === 'Enter'){ e.preventDefault(); process(); }
});

// Collect every binding the AST marks as compute={@fn}. Returns a
// Set of dotted binding paths for the live-preview merge to skip —
// the renderer owns those values via its watchEffect, and a stale
// snapshot would shadow the next computation result.
function collectComputeBindings(ast) {
    const out = new Set();
    if (!ast?.root) return out;
    walkAst(ast.root, (n) => {
        if (n.nodeKind === 'control'
            && n.compute?.kind === 'function'
            && n.binding
            && !n.binding.startsWith('@')) {
            out.add(n.binding);
        }
    });
    return out;
}

// True when `el` lives inside the rendered Vue form, including
// teleported overlays (Vuetify VDialog teleports its DOM to
// document.body by default). Walking the ancestor chain for
// .v-dialog catches the dialog case without requiring the renderer
// to use Vuetify's `attach` prop (which has known overlay-
// positioning issues under overflow:auto containers). The selector
// is intentionally narrow — VSelect / VCombobox dropdown menus
// teleport too, but typing into them happens at the inline trigger
// (which IS inside vueMount), so the menu's items don't need the
// form-undo gate.
function isInsideRenderedForm(el) {
    if (!el) return false;
    if (els.vueMount?.contains(el)) return true;
    return !!el.closest?.('.v-dialog');
}

// Identify a focused element as a data-bound input the form-history
// stack should react to. The renderer assigns ids of the shape
// `fb-input-<binding>-<line>` (or derived `-start` / `-end` /
// `-amount` / `-unit` / `-path` / `-color` for compound sub-inputs).
// Anything inside the rendered form that doesn't carry that id —
// the listManager search field, a Vuetify menu's filter input — is
// off-bounds for form-undo, so the browser's native text undo wins.
function isFormDataBoundInput(el) {
    if (!el) return false;
    const id = el.id || '';
    if (id.startsWith('fb-input-')) return true;
    // Some Vuetify components nest their actual <input> inside a
    // wrapper that carries the id we set. Walk up a couple of levels
    // looking for a fb-input-* ancestor before giving up.
    return !!el.closest?.('[id^="fb-input-"]');
}

// ---------------------------------------------------------------
// Initial load — try to fetch the bundled sample, else placeholder
// ---------------------------------------------------------------

applyFrameworkToolbarVisibility();
applyFrameworkPaneVisibility();
initEditor();
initSchemaEditor();

// Share-link encoder/decoder. Compresses the source text with the
// browser-native gzip CompressionStream + base64-url so the URL
// hash carries a "click to reproduce this form" payload. Decompresses
// the hash on load if present. No external library — runs against
// every modern browser that ships CompressionStream (Chromium 80+,
// Firefox 113+, Safari 16.4+).
async function encodeShareHash(text) {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
    const buf = await new Response(stream).arrayBuffer();
    return btoa(String.fromCharCode(...new Uint8Array(buf)))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function decodeShareHash(hash) {
    const b64 = hash.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64 + '='.repeat((4 - b64.length % 4) % 4)), c => c.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return await new Response(stream).text();
}

if (els.btnShare) {
    els.btnShare.addEventListener('click', async () => {
        try {
            const hash = await encodeShareHash(getSourceText());
            const url = `${location.origin}${location.pathname}#share=${hash}`;
            await navigator.clipboard.writeText(url);
            setStatus(`Share link copied (${url.length} chars)`, 'ok');
        } catch (e) {
            setStatus(`Share failed: ${e.message}`, 'err');
        }
    });
}

// Optional sinks bridge. Loaded only when the `?show=1` URL flag is
// present. Without the flag, the import never fires and the bridge
// module never reaches the network. With the flag, the bridge wires
// the topbar buttons (Open Sink / Import / Export-to-Sink) into the
// viewer's existing source-text and AST surfaces. The catch below
// swallows the case where viewer/private/ has been removed from a
// public deploy; the viewer still runs without the bridge.
if (FLAGS.show) {
    import('./private/sinks-bridge.js')
        .then(({ initSinksBridge }) => initSinksBridge({
            getAst:        () => state.lastAst,
            getSchema:     () => state.lastSchema,
            getSourceText: () => getSourceText(),
            setSourceText: (text, label) => setEditorText(text, label),
            setStatus
        }))
        .catch(() => { /* private dir absent — viewer runs without the bridge */ });
}

(async () => {
    // Share-link hash takes precedence over the bundled sample.
    // The hash carries `#share=<base64-gzip-source>` produced by
    // the Share button. Decoding lives behind the same browser
    // capability check as encoding (CompressionStream / DecompressionStream).
    try {
        const hashMatch = location.hash.match(/^#share=(?<payload>.+)$/);
        if (hashMatch) {
            const text = await decodeShareHash(hashMatch.groups.payload);
            setEditorText(text, '(shared link)');
            setStatus('Loaded from share link', 'ok');
            return;
        }
    } catch (e) {
        setStatus(`Share link decode failed: ${e.message}`, 'err');
        // Fall through to bundled sample.
    }

    try {
        const res = await fetch('../editor/samples/sink-text-file.mmpform');
        if (res.ok) {
            const text = await res.text();
            setEditorText(text, 'sink-text-file.mmpform  (bundled sample)');
            return;
        }
    } catch { /* fall through */ }

    setEditorText(
`columns: 12

[container({title},{description})]

  - [textfield(8,{userName})] User Name
  - [number(4,{age},min=0,max=150)] Age
  - [check(4,{active})] Active
`,
        '(starter)');
})();
