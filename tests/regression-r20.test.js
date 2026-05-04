// Regression tests for round-19 minor fixes (A-m1..A-m9 + B-m1) and
// the comment-jargon scrub.
//
// Coverage map:
//   A-m1   render-preview.js routes tooltipsMap reads through safeGet.
//   A-m2   tokenizer.scrubStackPath skips lines that don't start
//          with V8's `at ` prefix.
//   A-m3   FormModel type declares `_warnings` as an acknowledged-
//          internal ReadonlyArray<string>.
//   A-m4   parse-toplevel.js carries the hoist note for the typo
//          helper and replaces "Levenshtein-equivalent" with a
//          plain-spoken explanation.
//   A-m5   interpolate.js comments the lastIndex-reset invariant.
//   A-m6   tokenizer.js comments the upstream bracket-balance
//          guarantee from LineSplitter.
//   A-m7   parseOptionSource source.binding shim is documented as
//          a 1.x contract (kept forever in 1.x).
//   A-m8   text-form-builder.js __common shallow-copy depth note
//          calls out the future hazard.
//   A-m9   infer-schema.js fallback is annotated (already done in
//          a prior round).
//   B-m1   swapDelimiterQuotes un-escapes `\'` inside string content
//          (apostrophes inside values now round-trip through
//          JSON.parse).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
    TextFormBuilder,
    ERR,
    renderFormPreview
} from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot  = join(__dirname, '..');
const readDoc = (relPath) => readFileSync(join(repoRoot, relPath), 'utf8');

// ─── A-m1 render-preview routes through safeGet ──────────────────────────

test("A-m1 render-preview.js imports safeGet and uses it for tooltipsMap reads", () => {
    const text = readDoc('src/render-preview.js');
    assert.ok(text.includes("import { safeGet } from './safe-keys.js'"),
        'render-preview should import safeGet');
    assert.equal(text.includes('ctx.tooltipsMap[root.tooltipRef]'), false,
        'root tooltip read should route through safeGet');
    assert.equal(text.includes('ctx.tooltipsMap[c.tooltipRef]'), false,
        'container/control tooltip reads should route through safeGet');
    assert.ok(text.includes('safeGet(ctx.tooltipsMap'),
        'safeGet calls should be present');
});

test("A-m1 renderFormPreview with a parser-produced AST still produces a tooltip glyph", () => {
    // Sanity-check that the safeGet refactor didn't break the
    // parser-produced path. A control with a tooltipRef should
    // still get its ⓘ glyph in the preview.
    const result = new TextFormBuilder({
        schemaText: `columns: 10

tooltips = ["help" = "this helps"]

[container({t})]

  - [textfield(5,{x},tt="help")] X
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    const preview = renderFormPreview(result.payload);
    assert.ok(preview.includes('ⓘ'),
        `expected tooltip glyph in preview output, got:\n${preview}`);
});

test("A-m1 renderFormPreview with a hand-built AST that has __proto__ tooltipRef does not crash", () => {
    // The hand-built AST plants a reserved key in tooltipRef. Without
    // safeGet, the lookup would walk Object.prototype; with safeGet,
    // the lookup returns undefined and the glyph branch stays cold.
    const ast = {
        version: 1, columns: 10,
        optionSources: {}, tooltips: {}, colors: {}, namedText: {}, namedObjects: {},
        root: {
            nodeKind: 'container',
            collapsible: false,
            title: [], description: [], tooltipRef: '__proto__',
            label: [], headerControls: [],
            panels: null,
            rows: [],
            when: null, whenAst: null, minHeight: null, maxHeight: null,
            loc: { line: 1, col: 1, length: 0 },
            arrayBinding: null, itemMin: null, itemMax: null,
            search: false, filter: null, draggable: false,
            addLabel: null, commit: null, excludedRef: null
        }
    };
    // Should not throw.
    const out = renderFormPreview(ast);
    assert.ok(typeof out === 'string');
});

// ─── A-m2 scrubStackPath at-prefix early-out ─────────────────────────────

test("A-m2 scrubStackPath source has the at-prefix early-out", () => {
    const text = readDoc('src/parser/run-parse.js');
    assert.ok(text.match(/if\s*\(\s*!\/\^\\s\*at\\s\/\.test\(line\)\s*\)\s*return line/),
        'scrubStackPath should refuse to touch lines that do not start with V8\'s "at " prefix');
});

// ─── A-m3 _warnings declared on FormModel type ───────────────────────────

test("A-m3 FormModel type does NOT declare _warnings; warnings flow through result.messages", () => {
    // Direction reversed in round-21: the typed _warnings field
    // created a dual surface (typed + non-enumerable runtime stash
    // + result.messages), and JSON.stringify(payload) silently
    // dropped the field. The single source of truth is
    // result.messages on the TupleResponse envelope. The runtime
    // stash on the model stays as the internal channel between
    // parse() and runParse(), but it is not part of the public type.
    const text = readDoc('types/index.d.ts');
    assert.equal(text.includes('_warnings?:'), false,
        'FormModel should not declare _warnings on the public type');
    assert.ok(text.includes('result.messages'),
        'the FormModel doc-comment should name result.messages as the warnings surface');
});

// ─── A-m4 typo helper plain-spoken explanation + hoist note ──────────────

test("A-m4 nameLooksLikeBlockTypo no longer references 'Levenshtein-equivalent'", () => {
    const text = readDoc('src/parser/parse-toplevel.js');
    assert.equal(text.includes('Levenshtein-equivalent'), false,
        'jargon name should be replaced with a plain-spoken explanation');
    assert.ok(text.includes('edit away'),
        'should explain the rule in plain English (the "one edit away" phrasing)');
    assert.ok(text.includes('one character changed'),
        'should enumerate the kinds of edits in plain language');
    assert.ok(text.includes("typo-hint"),
        'should keep the hoist note');
});

// ─── A-m5 interpolate.js lastIndex invariant comment ─────────────────────

test("A-m5 interpolate.js comments the lastIndex-reset safe-state invariant", () => {
    const text = readDoc('src/interpolate.js');
    assert.ok(text.includes('safe-state restore'),
        'interpolate should call out the lastIndex reset as the load-bearing safe-state');
    assert.ok(text.includes('Do not throw inside the exec loop'),
        'should warn future contributors against throwing without resetting');
});

// ─── A-m6 _postProcessSquareBrackets bracket-balance comment ─────────────

test("A-m6 tokenizer.js _postProcessSquareBrackets names the upstream bracket-balance guarantee", () => {
    const text = readDoc('src/tokenizer.js');
    assert.ok(text.includes('Bracket-balance assumption'),
        'the post-process pass should call out the upstream guarantee');
    assert.ok(text.includes('LineSplitter'),
        'should name the upstream module that enforces balance');
});

// ─── A-m7 parseOptionSource source.binding 1.x commitment ────────────────

test("A-m7 parseOptionSource source.binding shim is documented as a 1.x contract", () => {
    const text = readDoc('src/parser/parse-toplevel.js');
    assert.ok(text.includes('versioned contract'),
        'the back-compat field should be documented as a versioned contract');
    assert.ok(text.includes('through 1.x'),
        'the shim should commit to 1.x lifetime');
});

// ─── A-m8 __common shallow-copy depth note ───────────────────────────────

test("A-m8 text-form-builder.js __common shallow copy carries a depth-dependency note", () => {
    const text = readDoc('src/text-form-builder.js');
    assert.ok(text.includes('Depth dependency'),
        '__common shallow copy should carry the depth-dependency note');
});

// ─── A-m9 infer-schema.js fallback annotated (verified earlier) ─────────

test("A-m9 infer-schema.js fallback comment names the hand-built-AST contract", () => {
    const text = readDoc('src/infer-schema.js');
    assert.ok(text.includes('hand-built'),
        'the fallback should explain it fires for hand-built ASTs');
});

// ─── Comment-jargon scrub: no Levenshtein anywhere in src/ ───────────────

test("comment-jargon: no 'Levenshtein' references remain in src/", () => {
    const expressionText  = readDoc('src/expression.js');
    const toplevelText    = readDoc('src/parser/parse-toplevel.js');
    const interpolateText = readDoc('src/interpolate.js');
    const tokenizerText   = readDoc('src/tokenizer.js');
    for (const [name, body] of [
        ['expression.js', expressionText],
        ['parse-toplevel.js', toplevelText],
        ['interpolate.js', interpolateText],
        ['tokenizer.js', tokenizerText]
    ]) {
        assert.equal(body.includes('Levenshtein'), false, `${name} should not mention Levenshtein`);
    }
});

test("comment-jargon: 'lexeme' replaced with plain language in tokenizer.js", () => {
    const text = readDoc('src/tokenizer.js');
    assert.equal(text.includes('lexeme'), false,
        'the term lexeme should be replaced with "matched substring"');
});

test("comment-jargon: 'O(n)' replaced with descriptive language in tokenizer.js", () => {
    const text = readDoc('src/tokenizer.js');
    assert.equal(text.includes('This is O(n)'), false,
        'the Big-O reference should be replaced with plain English');
});

// ─── B-m1 swapDelimiterQuotes un-escapes \' inside string content ────────

// The viewer code is browser-side; the function isn't easily callable
// from Node. Verify the source change landed by reading the file.

test("B-m1 swapDelimiterQuotes source carries the \\' un-escape branch", () => {
    const text = readDoc('viewer/render-vue.js');
    assert.ok(text.match(/if \(next === "'"\) \{ out \+= "'"; i \+= 2; continue/),
        'swapDelimiterQuotes should un-escape \\\' to \' inside string content');
    assert.ok(text.match(/if \(c === '"'\) \{ out \+= '\\\\"'; i\+\+; continue/),
        'swapDelimiterQuotes should escape bare " inside string content (now needed since the delimiter is ")');
});

test("B-m1 parseDefault comment names bare-keys as a known limit", () => {
    const text = readDoc('viewer/render-vue.js');
    assert.ok(text.includes('Known limit: bare object keys'),
        'parseDefault should call out bare-key support as a known limit');
});
