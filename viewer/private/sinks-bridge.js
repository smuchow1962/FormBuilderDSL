// ============================================================================
// PRIVATE FEATURES (NOT FOR OPEN-SOURCE RELEASE)
//
// Wires the FormBuilderDSL viewer to the Herald.Sinks project layout.
// Three buttons in the topbar:
//
//   📂 Open Sink — pick a Herald.Sinks.<Name>/ directory from a searchable
//                  Vuetify dialog. The dialog scans the user-picked
//                  Herald.Sinks/src/ root once (handle persisted via
//                  IndexedDB so subsequent reloads skip the picker) and
//                  lists every sub-directory that ships a CAPABILITY.yaml.
//                  Sinks that already ship configuration.mmpform get a
//                  green "has form" chip; the rest get a "no form" chip
//                  and load a boilerplate template instead.
//
//   📤 Export    — writes the current source as configuration.mmpform plus
//                  a CAPABILITY.yaml update INTO the directory the user
//                  just imported from (no second prompt). When no sink is
//                  active, falls back to a save-picker.
//
//   📥 Import    — legacy single-directory picker, kept for ad-hoc loads
//                  of a directory the dialog hasn't seen.
//
// A purple chip on the topbar shows which sink is currently being edited.
//
// Removal:  delete viewer/private/, then strip the bracketed BEGIN/END
//           PRIVATE FEATURES blocks from viewer.js and viewer.css.
// ============================================================================

const Vue     = window.Vue;
const Vuetify = window.Vuetify;

const components = (function () {
    if (!Vuetify) return {};
    if (Vuetify.components && Object.keys(Vuetify.components).length > 0) return Vuetify.components;
    return Object.fromEntries(
        Object.entries(Vuetify).filter(([k, v]) =>
            typeof v === 'object' && v !== null && k.startsWith('V'))
    );
})();
const directives = Vuetify?.directives ?? {};

function C(name) { return components[name] ?? name; }

const IDB_DB    = 'formbuilder-dsl';
const IDB_STORE = 'handles';
const IDB_KEY   = 'sinks-root';

// Currently-edited sink — { dirName, displayName, dirHandle }
let currentSink = null;
let currentChipEl = null;
let opts = null;

let dialogApp   = null;
let dialogState = null;
let toastState  = null;
let toastTimer  = 0;

// ---------------------------------------------------------------
// Public init — called from viewer.js
// ---------------------------------------------------------------

export function initSinksBridge(callerOpts) {
    opts = callerOpts;
    if (!('showDirectoryPicker' in window)) {
        console.info('[sinks-bridge] showDirectoryPicker unavailable; private features disabled.');
        return;
    }
    if (!Vue || !Vuetify || Object.keys(components).length === 0) {
        console.warn('[sinks-bridge] Vue / Vuetify not ready; private features disabled.');
        return;
    }
    addOpenSinkButton();
    addCurrentSinkChip();
    addImportButton();
    addExportButton();
    ensureDialog();   // mounts the Vue app eagerly so toasts can fire
}

// Pop a Vuetify snackbar at the bottom-right. Mirrors setStatus() but
// surfaces the message visibly so Export / Import don't feel silent.
function toast(message, color) {
    if (!toastState) return;
    toastState.message.value = message;
    toastState.color.value   = color || 'info';
    toastState.visible.value = true;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastState.visible.value = false; }, 3500);
}

// ---------------------------------------------------------------
// Topbar buttons
// ---------------------------------------------------------------

function topToolbar() {
    return document.querySelector('header.topbar .toolbar');
}

function addOpenSinkButton() {
    const tb = topToolbar();
    if (!tb) return;
    const sep = document.createElement('span');
    sep.className = 'sep';
    tb.insertBefore(sep, tb.querySelector('#filename'));

    const btn = document.createElement('button');
    btn.id = 'btn-open-sink';
    btn.className = 'private-feature';
    btn.textContent = 'Open Sink';
    btn.title = 'Private: pick a Herald.Sinks.* project to edit';
    tb.insertBefore(btn, tb.querySelector('#filename'));

    btn.addEventListener('click', openSinkDialog);
}

function addImportButton() {
    const tb = topToolbar();
    if (!tb) return;
    const btn = document.createElement('button');
    btn.id = 'btn-import-sinks';
    btn.className = 'private-feature';
    btn.textContent = 'Import…';
    btn.title = 'Private: load configuration.mmpform from any directory';
    tb.insertBefore(btn, tb.querySelector('#filename'));
    btn.addEventListener('click', importLooseDirectory);
}

function addExportButton() {
    const toolbar = document.querySelector('[data-tab="schema"] .pane-toolbar');
    if (!toolbar) return;
    const btn = document.createElement('button');
    btn.id = 'btn-export-sinks';
    btn.className = 'private-feature';
    btn.textContent = 'Export to Sink';
    btn.title = 'Private: write configuration.mmpform + update CAPABILITY.yaml';
    toolbar.appendChild(btn);
    btn.addEventListener('click', exportToCurrentOrPick);
}

function addCurrentSinkChip() {
    const tb = topToolbar();
    if (!tb) return;
    const chip = document.createElement('span');
    chip.id = 'current-sink-chip';
    chip.className = 'private-feature current-sink-chip';
    chip.style.display = 'none';
    tb.insertBefore(chip, tb.querySelector('#filename'));
    currentChipEl = chip;
}

function setCurrentSink(sink) {
    currentSink = sink;
    if (!currentChipEl) return;
    if (!sink) {
        currentChipEl.style.display = 'none';
        currentChipEl.textContent = '';
    } else {
        currentChipEl.style.display = '';
        currentChipEl.textContent = `📍 ${sink.dirName}`;
        currentChipEl.title = `Editing ${sink.displayName} — Export writes back here`;
    }
}

// ---------------------------------------------------------------
// IndexedDB persistence for the picked Herald.Sinks/src/ root
// ---------------------------------------------------------------

function idbOpen() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
        req.onsuccess       = () => resolve(req.result);
        req.onerror         = () => reject(req.error);
    });
}

async function idbGet(key) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
        const r = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
        r.onsuccess = () => resolve(r.result);
        r.onerror   = () => reject(r.error);
    });
}

async function idbSet(key, value) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
        const r = db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).put(value, key);
        r.onsuccess = () => resolve();
        r.onerror   = () => reject(r.error);
    });
}

async function getOrPickRoot() {
    const stored = await idbGet(IDB_KEY).catch(() => null);
    if (stored) {
        const perm = await stored.queryPermission?.({ mode: 'readwrite' });
        if (perm === 'granted') return stored;
        const req = await stored.requestPermission?.({ mode: 'readwrite' });
        if (req === 'granted') return stored;
        // Fall through and re-pick.
    }
    const fresh = await window.showDirectoryPicker({
        mode: 'readwrite',
        id: 'herald-sinks-root',
        startIn: 'documents'
    });
    await idbSet(IDB_KEY, fresh).catch(() => { /* non-fatal */ });
    return fresh;
}

// ---------------------------------------------------------------
// Sink discovery
// ---------------------------------------------------------------

async function scanSinks(rootHandle) {
    const found = [];
    for await (const [name, handle] of rootHandle.entries()) {
        if (handle.kind !== 'directory') continue;
        if (!name.startsWith('Herald.Sinks.')) continue;

        let yamlText = null;
        try {
            const yh = await handle.getFileHandle('CAPABILITY.yaml');
            const yf = await yh.getFile();
            yamlText = await yf.text();
        } catch { continue; }   // not a sink directory we can read

        let hasForm = false;
        try { await handle.getFileHandle('configuration.mmpform'); hasForm = true; } catch { /* fine */ }

        const displayName = parseSimpleYamlField(yamlText, 'name') || name;
        const purpose     = parseSimpleYamlField(yamlText, 'purpose') || '';
        const purposeFirst = purpose.split('\n').map(s => s.trim()).filter(Boolean)[0] || '';

        found.push({
            dirName: name,
            displayName,
            purpose: purposeFirst,
            hasForm,
            dirHandle: handle
        });
    }
    found.sort((a, b) => a.dirName.localeCompare(b.dirName));
    return found;
}

// Parse `name: value` or `name: > / |` block from YAML in a permissive way.
// Just enough to surface a label and one-liner in the picker; we don't need
// a full YAML parser on the client.
function parseSimpleYamlField(yaml, field) {
    const re = new RegExp(`^${field}:\\s*(?<head>>?\\|?[^\\n]*)\\n(?<body>(?:\\s+[^\\n]*\\n)*)`, 'm');
    const m = yaml.match(re);
    if (!m) return null;
    const head = (m.groups.head || '').replace(/^[>|]\s*/, '').trim();
    const body = (m.groups.body || '').split('\n').map(s => s.trim()).filter(Boolean).join(' ');
    return [head, body].filter(Boolean).join(' ');
}

// ---------------------------------------------------------------
// Vuetify picker dialog
// ---------------------------------------------------------------

function ensureDialog() {
    if (dialogApp) return;

    const mount = document.createElement('div');
    mount.id = 'sinks-dialog-mount';
    document.body.appendChild(mount);

    const { createApp, h, ref, computed } = Vue;
    const { createVuetify } = Vuetify;

    dialogState = {
        visible: ref(false),
        sinks:   ref([]),
        search:  ref(''),
        onPick:  null
    };
    toastState = {
        visible: ref(false),
        message: ref(''),
        color:   ref('info')
    };

    const App = {
        setup() {
            const filtered = computed(() => {
                const q = (dialogState.search.value || '').toLowerCase();
                if (!q) return dialogState.sinks.value;
                return dialogState.sinks.value.filter(s =>
                    s.dirName.toLowerCase().includes(q) ||
                    (s.displayName || '').toLowerCase().includes(q) ||
                    (s.purpose || '').toLowerCase().includes(q)
                );
            });
            return { filtered };
        },
        render() {
            const toastNode = h(C('VSnackbar'), {
                modelValue:    toastState.visible.value,
                'onUpdate:modelValue': (v) => { toastState.visible.value = v; },
                color:         toastState.color.value,
                timeout:       3500,
                location:      'bottom right',
                variant:       'elevated',
                closeOnContentClick: true,
                class:         'sinks-bridge-toast'
            }, () => toastState.message.value);

            const dialogNode = h(C('VDialog'), {
                modelValue:   dialogState.visible.value,
                'onUpdate:modelValue': (v) => { dialogState.visible.value = v; if (!v) dialogState.onPick?.(null); },
                maxWidth:     720,
                scrollable:   true,
                persistent:   false
            }, () => h(C('VCard'), { class: 'sink-picker-card' }, () => [
                h(C('VCardTitle'), null, () => 'Open Sink Project'),
                h(C('VCardSubtitle'), null, () =>
                    'Pick a Herald.Sinks.<Name>/ directory. Loads its configuration.mmpform if present, otherwise a boilerplate.'
                ),
                h(C('VCardText'), { style: 'min-height:60vh; max-height:60vh; overflow:auto;' }, () => [
                    h(C('VTextField'), {
                        modelValue: dialogState.search.value,
                        'onUpdate:modelValue': (v) => { dialogState.search.value = v; },
                        label:           'Search by name or purpose',
                        density:         'compact',
                        hideDetails:     true,
                        prependInnerIcon:'mdi-magnify',
                        autofocus:       true,
                        clearable:       true,
                        class:           'sink-picker-search'
                    }),
                    this.filtered.length === 0
                        ? h('div', { class: 'sink-picker-empty' }, 'No sinks match your filter.')
                        : h(C('VList'), { density: 'compact', class: 'sink-picker-list' }, () =>
                            this.filtered.map(s => h(C('VListItem'), {
                                key: s.dirName,
                                title:    s.dirName,
                                subtitle: s.purpose || '(no purpose declared)',
                                onClick:  () => { dialogState.visible.value = false; dialogState.onPick?.(s); }
                            }, {
                                append: () => h(C('VChip'), {
                                    size:    'x-small',
                                    color:   s.hasForm ? 'success' : 'grey',
                                    variant: 'tonal'
                                }, () => s.hasForm ? 'has form' : 'no form')
                            }))
                        )
                ]),
                h(C('VCardActions'), null, () => [
                    h(C('VBtn'), {
                        variant: 'text',
                        onClick: () => { dialogState.visible.value = false; dialogState.onPick?.(null); }
                    }, () => 'Cancel')
                ])
            ]));

            return h('div', { class: 'sinks-bridge-overlay' }, [dialogNode, toastNode]);
        }
    };

    dialogApp = createApp(App);
    const vuetify = createVuetify({
        components,
        directives,
        theme: { defaultTheme: 'dark' }
    });
    // Manual registration to match render-vue.js's belt+suspenders pattern.
    for (const [n, c] of Object.entries(components)) {
        if (c) try { dialogApp.component(n, c); } catch { /* skip */ }
    }
    dialogApp.use(vuetify);
    dialogApp.mount(mount);
}

function showPicker(sinks) {
    return new Promise((resolve) => {
        ensureDialog();
        dialogState.sinks.value  = sinks;
        dialogState.search.value = '';
        dialogState.onPick       = (s) => resolve(s);
        dialogState.visible.value = true;
    });
}

// ---------------------------------------------------------------
// Open Sink flow
// ---------------------------------------------------------------

async function openSinkDialog() {
    try {
        const root = await getOrPickRoot();
        const sinks = await scanSinks(root);
        if (sinks.length === 0) {
            opts.setStatus(`No Herald.Sinks.* directories under ${root.name}`, 'err');
            return;
        }
        const picked = await showPicker(sinks);
        if (!picked) return;
        await loadFromSink(picked);
    } catch (e) {
        if (e?.name !== 'AbortError') opts.setStatus(`Open Sink failed: ${e.message}`, 'err');
    }
}

async function loadFromSink(sink) {
    let text;
    let usedBoilerplate = false;
    try {
        const handle = await sink.dirHandle.getFileHandle('configuration.mmpform');
        const file   = await handle.getFile();
        text = await file.text();
        opts.setStatus(`Loaded configuration.mmpform from ${sink.dirName}`, 'ok');
    } catch {
        text = boilerplateFor(sink);
        usedBoilerplate = true;
        opts.setStatus(`No configuration.mmpform in ${sink.dirName} — loaded boilerplate template`, 'warn');
    }
    setCurrentSink(sink);
    opts.setSourceText(text, `${sink.dirName}/configuration.mmpform  (Herald.Sinks)`);
    toast(
        usedBoilerplate ? `Loaded boilerplate for ${sink.dirName}` : `Loaded ${sink.dirName}`,
        usedBoilerplate ? 'warning' : 'success'
    );
}

function boilerplateFor(sink) {
    return `# Boilerplate configuration form for ${sink.dirName}.
# ${sink.purpose || 'No purpose declared in CAPABILITY.yaml.'}
#
# Edit this file to define the configuration form for this sink.
# Even if the sink takes no parameters, leave this file in place
# and use the label below for operator notes.

columns: 12

[container("${sink.displayName || sink.dirName}", tooltip="Configuration for ${sink.dirName}")]

  - [label(12,style=note)] (No configuration parameters yet — add controls below or replace this label with notes for the operator.)
`;
}

// ---------------------------------------------------------------
// Loose import (legacy / one-off directory)
// ---------------------------------------------------------------

async function importLooseDirectory() {
    try {
        const dir = await window.showDirectoryPicker({
            mode: 'read',
            id:   'herald-sinks-bridge-loose',
            startIn: 'documents'
        });
        const handle = await dir.getFileHandle('configuration.mmpform').catch(() => null);
        if (!handle) {
            opts.setStatus(`No configuration.mmpform in ${dir.name}`, 'err');
            toast(`No configuration.mmpform in ${dir.name}`, 'error');
            return;
        }
        const file = await handle.getFile();
        const text = await file.text();
        // Loose import doesn't track current sink — Export will re-prompt.
        setCurrentSink(null);
        opts.setSourceText(text, `${dir.name}/configuration.mmpform`);
        opts.setStatus(`Imported configuration.mmpform from ${dir.name}`, 'ok');
        toast(`Imported from ${dir.name}`, 'success');
    } catch (e) {
        if (e?.name !== 'AbortError') {
            opts.setStatus(`Import failed: ${e.message}`, 'err');
            toast(`Import failed: ${e.message}`, 'error');
        }
    }
}

// ---------------------------------------------------------------
// Export — to current sink if active, else save-picker
// ---------------------------------------------------------------

async function exportToCurrentOrPick() {
    const ast    = opts.getAst();
    const schema = opts.getSchema();
    if (!ast || !schema) {
        opts.setStatus('No parsed form to export — Process the form first.', 'err');
        toast('Process the form first — nothing to export.', 'error');
        return;
    }
    try {
        const dir = currentSink?.dirHandle ?? await window.showDirectoryPicker({
            mode: 'readwrite',
            id:   'herald-sinks-bridge',
            startIn: 'documents'
        });
        await writeFile(dir, 'configuration.mmpform', opts.getSourceText());

        const yamlBefore = await readOrEmpty(dir, 'CAPABILITY.yaml');
        const yamlAfter  = updateCapabilitiesYaml(yamlBefore, schema);
        await writeFile(dir, 'CAPABILITY.yaml', yamlAfter);

        const fields = schema.fields.length;
        const summary = `Exported to ${dir.name} (${fields} field${fields === 1 ? '' : 's'} → CAPABILITY.yaml + configuration.mmpform)`;
        opts.setStatus(summary, 'ok');
        toast(`✔ Exported to ${dir.name} (${fields} field${fields === 1 ? '' : 's'})`, 'success');
    } catch (e) {
        if (e?.name !== 'AbortError') {
            opts.setStatus(`Export failed: ${e.message}`, 'err');
            toast(`Export failed: ${e.message}`, 'error');
        }
    }
}

// ---------------------------------------------------------------
// CAPABILITY.yaml mutation
// ---------------------------------------------------------------

// Rebuild the manifest's autogen block. Three problems we have to handle
// cleanly so a re-export never produces a duplicate root key:
//   1. Stale autogen blocks from older viewer versions (sometimes nested
//      because the marker regex used to miss its own marker text).
//   2. Orphan formProperties / formFunctions emitted before the marker
//      pattern stabilized.
//   3. A user-placed formSchema declaration that lives outside the
//      autogen block — typically near the top of the manifest with a
//      comment block explaining the v2 wiring. We must preserve that.
function updateCapabilitiesYaml(existing, schema) {
    const withoutBlock   = stripAutogenBlock(existing);
    const userFormSchema = /^formSchema\s*:/m.test(withoutBlock);
    const cleaned        = stripBlocks(withoutBlock, ['formProperties', 'formFunctions']);

    const lines = cleaned.split('\n');
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    if (lines.length > 0) lines.push('');
    lines.push('# ----- Auto-generated by FormBuilderDSL viewer -----');
    if (!userFormSchema) {
        lines.push('formSchema: configuration.mmpform');
    }
    lines.push('formProperties:');
    for (const f of schema.fields) {
        lines.push(`  - name: ${yamlKey(f.path)}`);
        lines.push(`    type: ${f.type?.jsType ?? 'unknown'}`);
        lines.push(`    default: ${yamlValue(parseDef(f.type?.defaultValue))}`);
    }
    if (schema.functions.length > 0) {
        lines.push('formFunctions:');
        for (const fn of schema.functions) {
            lines.push(`  - name: ${fn.name}`);
            lines.push(`    returns: ${fn.inferredReturns}`);
        }
    }
    lines.push('# ----- end FormBuilderDSL block -----');
    return lines.join('\n') + '\n';
}

// Drop every block bounded by `# ----- Auto-generated by FormBuilderDSL viewer -----`
// and `# ----- end FormBuilderDSL block -----`, inclusive. Multiple stale
// start markers are absorbed because we stay in-block until the next end
// marker; a missing end marker strips to EOF. Trims a single blank line
// above each removed block so repeat exports don't accumulate gaps.
function stripAutogenBlock(yaml) {
    if (!yaml) return '';
    const startRe = /^# -+ Auto-generated by FormBuilderDSL viewer -+\s*$/;
    const endRe   = /^# -+ end FormBuilderDSL block -+\s*$/;
    const lines   = yaml.split('\n');
    const out     = [];
    let inBlock   = false;
    for (const line of lines) {
        if (!inBlock && startRe.test(line)) {
            while (out.length && out[out.length - 1].trim() === '') out.pop();
            inBlock = true;
            continue;
        }
        if (inBlock) {
            if (endRe.test(line)) inBlock = false;
            continue;
        }
        out.push(line);
    }
    return out.join('\n');
}

function stripBlocks(yaml, keys) {
    if (!yaml) return '';
    const lines = yaml.split('\n');
    const out = [];
    let skipping = false;
    for (const line of lines) {
        if (/^# -+ (Auto-generated by FormBuilderDSL viewer|end FormBuilderDSL block) -+\s*$/.test(line)) continue;
        const topKey = line.match(/^(?<key>[A-Za-z_][A-Za-z0-9_]*)\s*:/);
        if (topKey && keys.includes(topKey.groups.key)) { skipping = true; continue; }
        if (skipping) {
            if (/^\s+/.test(line) || line.trim() === '') continue;
            skipping = false;
        }
        out.push(line);
    }
    return out.join('\n');
}

function yamlKey(s)   { return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) ? s : JSON.stringify(s); }
function yamlValue(v) {
    if (v == null) return 'null';
    if (typeof v === 'string')  return JSON.stringify(v);
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v))       return v.length === 0 ? '[]' : JSON.stringify(v);
    if (typeof v === 'object')  return JSON.stringify(v);
    return String(v);
}

function parseDef(s) {
    if (s == null) return null;
    if (s === "''")             return '';
    if (s === '0' || s === '0.0') return 0;
    if (s === 'false')          return false;
    if (s === 'true')           return true;
    if (s === 'null')           return null;
    if (s === '[]')             return [];
    if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
    return null;
}

async function writeFile(dir, filename, content) {
    const handle = await dir.getFileHandle(filename, { create: true });
    const w = await handle.createWritable();
    await w.write(content);
    await w.close();
}

async function readOrEmpty(dir, filename) {
    try {
        const handle = await dir.getFileHandle(filename);
        const file   = await handle.getFile();
        return await file.text();
    } catch {
        return '';
    }
}
