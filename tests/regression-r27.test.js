// Regression tests for round-27 — preview-pane error banner +
// per-pane cursor indicators + live-preview toggle reparse.
//
// Coverage map:
//   E1   index.html ships #preview-error inside .tab-pane[data-tab="preview"]
//        between the .pane-toolbar and the render area, hidden by default.
//   E2   viewer.js wires showPreviewError / hidePreviewError helpers.
//   E3   viewer.js calls hidePreviewError() at the top of process() and
//        showPreviewError(...) on the parse-failure branch.
//   E4   viewer.js routes the renderPreview() Vue catch through showPreviewError.
//   E5   viewer.css ships .preview-error rules with the red stripe + flex-shrink: 0.
//   E6   The dead escapeHtml helper is gone (no consumers after E4).
//
//   C1   index.html ships #src-cursor-pos inside the Source .panel-title.
//   C2   index.html ships #schema-cursor-pos inside the Object View pane-toolbar.
//   C3   viewer.css ships a .pane-cursor-pos rule and the .panel-title is flex.
//   C4   viewer.js routes updateCursorPos to the editor's pane indicator
//        (Source vs. Object View) by editor identity.
//
//   T1   viewer.js attaches a 'change' listener on optLivePreview that
//        calls process() with the preserveFormDataOnNextProcess flag set.
//
//   S1   sample-files.test.js auto-discovers every .mmpform under
//        editor/samples/ and registers a per-file parse + infer-schema test.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot  = join(__dirname, '..');
const readDoc   = (relPath) => readFileSync(join(repoRoot, relPath), 'utf8');

// ─── E1..E6: preview-pane error banner ──────────────────────────────────

test('E1 index.html ships #preview-error inside the preview tab-pane, hidden by default', () => {
    const html = readDoc('viewer/index.html');
    // The element must exist.
    assert.ok(/id="preview-error"/.test(html),
        '#preview-error element is missing');
    // It must carry the [hidden] attribute so the banner starts collapsed.
    assert.ok(/<div\s+id="preview-error"[^>]*\bhidden\b[^>]*>/.test(html),
        '#preview-error must start hidden');
    // It must sit inside the preview tab-pane. Anchor to the pane
    // div (the tab button also carries data-tab="preview", so a bare
    // indexOf on the attribute would match the button and pull the
    // ordering check the wrong way).
    const paneIdx  = html.indexOf('<div class="tab-pane active" data-tab="preview">');
    const errorIdx = html.indexOf('id="preview-error"');
    const dataPaneIdx = html.indexOf('<div class="tab-pane" data-tab="data">');
    assert.ok(paneIdx >= 0 && errorIdx > paneIdx && errorIdx < dataPaneIdx,
        '#preview-error must live inside the Render Preview tab-pane');
    // It must sit AFTER the framework-toolbar (.pane-toolbar) and BEFORE
    // the rendered output (#preview-ascii / #vue-mount) so the banner
    // reads above where the form would have been.
    const toolbarIdx = html.indexOf('pane-toolbar', paneIdx);
    const asciiIdx   = html.indexOf('id="preview-ascii"');
    assert.ok(toolbarIdx < errorIdx && errorIdx < asciiIdx,
        '#preview-error must sit between .pane-toolbar and #preview-ascii');
});

test('E2 viewer.js exports the showPreviewError / hidePreviewError helpers', () => {
    const js = readDoc('viewer/viewer.js');
    assert.ok(/function showPreviewError\(/.test(js),
        'showPreviewError helper is missing');
    assert.ok(/function hidePreviewError\(/.test(js),
        'hidePreviewError helper is missing');
});

test('E3 process() clears the banner up-front and re-populates on parse failure', () => {
    const js = readDoc('viewer/viewer.js');
    // The clear must happen at the top of process(), so a successful
    // parse leaves the banner hidden; the re-populate must happen
    // inside the failure branch.
    assert.ok(/function process\(\)[\s\S]*?hidePreviewError\(\);[\s\S]*?if \(result\.error !== ERR\.OK\)/.test(js),
        'process() must call hidePreviewError() before the failure branch');
    assert.ok(/showPreviewError\(\s*[`'"]Parse failed/.test(js),
        'failure branch must call showPreviewError with a Parse-failed title');
});

test('E4 renderPreview() routes the Vue catch through showPreviewError', () => {
    const js = readDoc('viewer/viewer.js');
    assert.ok(/showPreviewError\(\s*['"]Vue render failed['"]/.test(js),
        'Vue render catch must call showPreviewError("Vue render failed", ...)');
    // The legacy raw-HTML injection must be gone — banner is now the
    // single sink for render failures.
    assert.equal(/els\.vueMount\.innerHTML\s*=\s*`<pre/.test(js), false,
        'old vueMount innerHTML "Vue render failed" injection must be gone');
});

test('E5 viewer.css ships .preview-error rules with red stripe + flex-shrink: 0', () => {
    const css = readDoc('viewer/viewer.css');
    assert.ok(/\.preview-error\s*\{[^}]*flex-shrink:\s*0/.test(css),
        '.preview-error must declare flex-shrink: 0 so the banner sits at natural height');
    assert.ok(/\.preview-error\s*\{[^}]*border-left:\s*3px\s+solid\s+#e06c75/i.test(css),
        '.preview-error must carry the red 3px solid border-left stripe');
    assert.ok(/\.preview-error-title\s*\{/.test(css), '.preview-error-title rule is missing');
    assert.ok(/\.preview-error-body\s*\{/.test(css),  '.preview-error-body rule is missing');
});

test('E6 dead escapeHtml helper is gone after the Vue catch refactor', () => {
    const js = readDoc('viewer/viewer.js');
    assert.equal(/function escapeHtml\(/.test(js), false,
        'escapeHtml had only one consumer; remove it once the Vue catch refactored');
});

// ─── C1..C4: per-pane cursor indicators ─────────────────────────────────

test('C1 Source panel-title carries #src-cursor-pos', () => {
    const html = readDoc('viewer/index.html');
    // Pull the Source panel section and check the indicator lives inside it.
    const sectionMatch = html.match(/<section id="left"[\s\S]*?<\/section>/);
    assert.ok(sectionMatch, '<section id="left"> not found');
    const section = sectionMatch[0];
    assert.ok(/<div class="panel-title">[\s\S]*?id="src-cursor-pos"[\s\S]*?<\/div>/.test(section),
        '#src-cursor-pos must live inside the Source .panel-title');
    assert.ok(/class="pane-cursor-pos"/.test(section),
        '#src-cursor-pos must carry the .pane-cursor-pos class');
});

test('C2 Object View pane-toolbar carries #schema-cursor-pos', () => {
    const html = readDoc('viewer/index.html');
    // Pull the schema tab-pane and check the indicator lives inside it.
    const paneMatch = html.match(/<div class="tab-pane" data-tab="schema">[\s\S]*?<div id="schema-editor"/);
    assert.ok(paneMatch, 'schema tab-pane block not found');
    assert.ok(/id="schema-cursor-pos"/.test(paneMatch[0]),
        '#schema-cursor-pos must live inside the Object View pane');
});

test('C3 viewer.css ships a flex .panel-title and the .pane-cursor-pos rule', () => {
    const css = readDoc('viewer/viewer.css');
    assert.ok(/\.panel-title\s*\{[^}]*display:\s*flex/.test(css),
        '.panel-title must be flex so the cursor indicator can be pushed right');
    assert.ok(/\.panel-title\s*\{[^}]*justify-content:\s*space-between/.test(css),
        '.panel-title must use space-between to push the indicator to the right edge');
    assert.ok(/\.pane-cursor-pos\s*\{/.test(css), '.pane-cursor-pos rule is missing');
});

test('C4 updateCursorPos routes to the per-pane indicator by editor identity', () => {
    const js = readDoc('viewer/viewer.js');
    // The indicator pick must dispatch on `ed === schemaEditor` so the
    // right pane element receives the readout. Coupling on editor
    // identity (rather than a passed-in element) keeps both call
    // sites — Source and Object View — sharing the same helper.
    assert.ok(/ed === schemaEditor\s*\?\s*els\.schemaCursorPos\s*:\s*els\.srcCursorPos/.test(js),
        'updateCursorPos must dispatch the indicator element by editor identity');
});

// ─── T1: live-preview toggle reparse ────────────────────────────────────

test('T1 optLivePreview change handler calls process() with preserveFormDataOnNextProcess', () => {
    const js = readDoc('viewer/viewer.js');
    // The handler must exist, set the preserve flag, and call process()
    // — in that order, so the flag is read by the new mount inside
    // renderPreview() rather than being cleared mid-tick.
    const handlerMatch = js.match(
        /els\.optLivePreview\.addEventListener\('change',\s*\(\)\s*=>\s*\{[\s\S]*?\}\);/
    );
    assert.ok(handlerMatch, 'optLivePreview change listener is missing');
    const body = handlerMatch[0];
    assert.ok(/preserveFormDataOnNextProcess\s*=\s*true/.test(body),
        'live-preview toggle must set preserveFormDataOnNextProcess before re-processing');
    assert.ok(/process\(\)/.test(body),
        'live-preview toggle handler must call process()');
    // Order check — preserve flag must be set BEFORE process() runs.
    const flagIdx    = body.indexOf('preserveFormDataOnNextProcess');
    const processIdx = body.indexOf('process()');
    assert.ok(flagIdx < processIdx,
        'preserve flag must be set before process() so the new mount inherits the user edits');
});

// ─── P1: auto-sync gate for the user-typed literal preservation ─────────

test('P1 viewer.js gates syncPropertiesBlockToSource on arePropertiesSemanticallyEqual', () => {
    const js = readDoc('viewer/viewer.js');
    // The import must come from the new helper module.
    assert.ok(/from\s+['"]\.\/properties-sync\.js['"]/.test(js),
        'viewer.js must import from ./properties-sync.js');
    assert.ok(/arePropertiesSemanticallyEqual/.test(js),
        'viewer.js must reference arePropertiesSemanticallyEqual');
    // The gate must be inside syncPropertiesBlockToSource and short-
    // circuit BEFORE the splice runs — otherwise the user's literal
    // form would still get rewritten.
    const fnMatch = js.match(/function syncPropertiesBlockToSource\([\s\S]*?\n\}/);
    assert.ok(fnMatch, 'syncPropertiesBlockToSource function not found');
    const body = fnMatch[0];
    const gateIdx   = body.indexOf('arePropertiesSemanticallyEqual');
    const spliceIdx = body.indexOf('spliceProperties');
    assert.ok(gateIdx >= 0 && spliceIdx >= 0 && gateIdx < spliceIdx,
        'arePropertiesSemanticallyEqual must run before spliceProperties');
});

// ─── S1: sample-files auto-discovery sanity ─────────────────────────────

test('S1 sample-files.test.js auto-discovers via readdirSync (no hand-maintained list)', () => {
    const js = readDoc('tests/sample-files.test.js');
    assert.ok(/readdirSync\(/.test(js),
        'sample tests must use readdirSync so new fixtures are picked up automatically');
    // No specific sample BASENAMES pinned in the test — the registry
    // is discovered, not hand-maintained. The extension itself
    // (`.mmpform` as an .endsWith filter) is fine; what we forbid is
    // a per-file name like `simple-label.mmpform`.
    const banned = /['"`][A-Za-z0-9_-]+\.mmpform['"`]/;
    assert.equal(banned.test(js), false,
        'sample tests must not pin individual *.mmpform filenames in the source');
});
