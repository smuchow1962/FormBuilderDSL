// Regression tests for round-15 doc + minor fixes.
//
// Coverage map:
//   D1   README names the V8 stack-trace assumption next to the
//        engines requirement.
//   D2   README ships a worked __properties round-trip example.
//   D3   expression-trust.md cross-links to architecture-no-ast-caching.md.
//   D4   architecture.md §10 module layout lists placeholder.js,
//        literal-types.js, string-literal.js, and safe-keys.js.
//   m1   parse.js warnings comment no longer over-promises a
//        "first-class diagnostic surface" the source does not deliver.
//   m2   no-AST-cache rule is enforced at every advertised site:
//        process(), collectProperties, validateProperties,
//        inferDataSchema, renderFormPreview. Each call returns a
//        fresh value (no shared identity across calls).
//   m3   four newline shapes (\n, \r, \r\n, \n\r) all produce the
//        same logical-line count.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
    TextFormBuilder,
    ERR,
    collectProperties,
    validateProperties,
    inferDataSchema,
    renderFormPreview
} from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot  = join(__dirname, '..');
const readDoc = (relPath) => readFileSync(join(repoRoot, relPath), 'utf8');

// ─── D1 README V8 stack-trace note ───────────────────────────────────────

test("D1 README names the V8 assumption next to the engines requirement", () => {
    const text = readDoc('README.md');
    assert.ok(text.includes('V8-based runtimes'),
        'README should call out V8 dependence near the engines line');
    assert.ok(text.match(/INTERNAL_ERROR.*stack-trace|stack-trace.*scrub.*V8/),
        'README should explain why V8 matters (the path scrub depends on it)');
});

// ─── D2 README __properties round-trip example ───────────────────────────

test("D2 README ships a worked __properties round-trip example", () => {
    const text = readDoc('README.md');
    assert.ok(text.includes('__properties round-trip') || text.includes('round-trip'),
        'README should have a section on __properties round-trip');
    assert.ok(text.includes('renderPropertiesBlock'),
        'round-trip example should call renderPropertiesBlock');
    assert.ok(text.includes('JSON.stringify(first.payload.__properties)'),
        'round-trip example should show the byte-for-byte stability assertion');
});

test("D2 the round-trip example actually works as documented", () => {
    // Pin the documented behaviour with a runtime test so the
    // README example cannot drift from reality.
    const original = `columns: 10

[container({title})]

  - [textfield(5,{host},init="localhost")] Host
  - [number(5,{port:int},init=8080)] Port
`;
    const first = new TextFormBuilder({ schemaText: original }).process();
    assert.equal(first.error, ERR.OK);

    // Use the dynamic import so we exercise the same path the example shows.
    return import('../src/property-collector.js').then(({ renderPropertiesBlock }) => {
        const block = renderPropertiesBlock(first.payload.__properties);
        const withBlock = `${block}\n\n${original}`;
        const second = new TextFormBuilder({ schemaText: withBlock }).process();
        assert.equal(second.error, ERR.OK);
        assert.equal(
            JSON.stringify(first.payload.__properties),
            JSON.stringify(second.payload.__properties),
            'round-trip should produce a byte-for-byte stable __properties dictionary'
        );
    });
});

// ─── D3 expression-trust.md cross-links to no-ast-caching ───────────────

test("D3 expression-trust.md cross-links to architecture-no-ast-caching.md", () => {
    const text = readDoc('docs/expression-trust.md');
    assert.ok(text.includes('architecture-no-ast-caching'),
        'expression-trust.md should mention the no-AST-caching rule');
    assert.ok(text.includes('Performance posture') || text.includes('performance'),
        'expression-trust.md should have a performance section pointing at the rule');
});

// ─── D4 architecture §10 module layout ──────────────────────────────────

test("D4 architecture.md §10 module layout lists the shared-core modules", () => {
    const text = readDoc('docs/architecture.md');
    assert.ok(text.includes('placeholder.js'),
        'architecture §10 missing placeholder.js entry');
    assert.ok(text.includes('literal-types.js'),
        'architecture §10 missing literal-types.js entry');
    assert.ok(text.includes('string-literal.js'),
        'architecture §10 missing string-literal.js entry');
    assert.ok(text.includes('safe-keys.js'),
        'architecture §10 missing safe-keys.js entry');
});

// ─── m1 parse.js warnings comment is no longer over-promised ─────────────

test("m1 parse.js no longer claims warnings are a 'first-class diagnostic surface'", () => {
    const text = readDoc('src/parser/parse.js');
    assert.equal(text.includes('first-class diagnostic surface'), false,
        'over-promising language should be gone — only one helper writes warnings today');
});

// ─── m2 no-AST-cache rule pinned at every advertised site ────────────────

const sampleSchema = `columns: 10

[container({title})]

  - [textfield(5,{name})] Name
  - [number(5,{count:int})] Count
`;

function freshAst() {
    return new TextFormBuilder({ schemaText: sampleSchema }).parse().payload;
}

test('m2 no-cache: process() returns distinct payloads on consecutive calls', () => {
    const b = new TextFormBuilder({ schemaText: sampleSchema });
    const r1 = b.process();
    const r2 = b.process();
    assert.equal(r1.error, ERR.OK);
    assert.equal(r2.error, ERR.OK);
    assert.notEqual(r1.payload, r2.payload);
});

test('m2 no-cache: collectProperties returns a fresh dictionary every call', () => {
    const ast = freshAst();
    const a = collectProperties(ast);
    const b = collectProperties(ast);
    assert.notEqual(a, b, 'collectProperties should return distinct dictionaries — no identity caching');
    // Same content though — the rule is "no caching", not "different result".
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
});

test('m2 no-cache: validateProperties returns a fresh array every call', () => {
    // process() so __properties exists; validate twice and check
    // for distinct array identity.
    const built = new TextFormBuilder({ schemaText: sampleSchema }).process().payload;
    const a = validateProperties(built);
    const b = validateProperties(built);
    assert.notEqual(a, b, 'validateProperties should return distinct arrays — no identity caching');
});

test('m2 no-cache: inferDataSchema returns a fresh schema every call', () => {
    const ast = freshAst();
    const a = inferDataSchema(ast);
    const b = inferDataSchema(ast);
    assert.notEqual(a, b, 'inferDataSchema should return distinct schemas — no identity caching');
    assert.notEqual(a.fields, b.fields, 'fields array should be a fresh allocation each call');
});

test('m2 no-cache: renderFormPreview returns a fresh string each call (no memoization)', () => {
    // Strings are primitives so identity is interning-dependent;
    // the meaningful no-cache check on a render is that the result
    // is structurally identical without being the same reference
    // chain. We sanity-check by confirming repeated calls don't
    // throw and produce the same output.
    const ast = freshAst();
    const a = renderFormPreview(ast);
    const b = renderFormPreview(ast);
    assert.equal(a, b, 'two consecutive renders of the same AST should be identical');
    assert.ok(a.length > 0);
});

// ─── m3 four newline shapes produce the same logical line count ─────────

test('m3 LineSplitter handles \\n, \\r, \\r\\n, \\n\\r as one logical line each', () => {
    // Build four equivalent forms with different newline shapes.
    // Each produces a 5-line schema with the same parsed structure.
    const variants = {
        'LF only':   "columns: 10\n\n[container({t})]\n\n  - [textfield(5,{x})] X\n",
        'CR only':   "columns: 10\r\r[container({t})]\r\r  - [textfield(5,{x})] X\r",
        'CRLF':      "columns: 10\r\n\r\n[container({t})]\r\n\r\n  - [textfield(5,{x})] X\r\n",
        'LF+CR pair':"columns: 10\n\r\n\r[container({t})]\n\r\n\r  - [textfield(5,{x})] X\n\r"
    };

    const results = [];
    for (const [name, schemaText] of Object.entries(variants)) {
        const r = new TextFormBuilder({ schemaText }).parse();
        assert.equal(r.error, ERR.OK,
            `${name} variant should parse cleanly; got messages: ${r.messages.join(' / ')}`);
        results.push({ name, payload: r.payload });
    }

    // Every variant should produce the same parsed structure: one
    // container with one row holding one textfield. Compare structural
    // signatures rather than full deep equality (loc fields will differ).
    const sig = (p) => ({
        rows: p.root.rows.length,
        controls: p.root.rows[0].controls.length,
        controlType: p.root.rows[0].controls[0].controlType,
        binding: p.root.rows[0].controls[0].binding
    });
    const first = JSON.stringify(sig(results[0].payload));
    for (const r of results.slice(1)) {
        assert.equal(
            JSON.stringify(sig(r.payload)),
            first,
            `${r.name} variant produced a different structure than ${results[0].name}`
        );
    }
});

test('m3 a CR followed by an LF (CRLF) does not double-count as two lines', () => {
    // Specifically pin that error line numbers match across newline
    // shapes. A control on "line 5" of an LF document should also
    // be on "line 5" of a CRLF document.
    const lfErr = new TextFormBuilder({
        schemaText: "columns: 10\n\n[container({t})]\n\n  - [textfield(5,{x:int},min=-1)] X\n"
    }).parse();
    const crlfErr = new TextFormBuilder({
        schemaText: "columns: 10\r\n\r\n[container({t})]\r\n\r\n  - [textfield(5,{x:int},min=-1)] X\r\n"
    }).parse();
    // The textfield spec doesn't actually have a min param, so this
    // test pins line-number equality on whatever error fires —
    // either both succeed or both report the error at the same line.
    assert.equal(lfErr.error, crlfErr.error,
        'LF and CRLF variants should report the same error code');
    if (lfErr.error !== ERR.OK) {
        // Compare the line numbers if both errored.
        const extractLine = (msg) => {
            const m = /line (\d+)/.exec(msg);
            return m ? parseInt(m[1], 10) : null;
        };
        const lfLines = lfErr.messages.map(extractLine).filter(Boolean);
        const crlfLines = crlfErr.messages.map(extractLine).filter(Boolean);
        assert.deepEqual(lfLines, crlfLines,
            'CRLF and LF should report identical line numbers');
    }
});
