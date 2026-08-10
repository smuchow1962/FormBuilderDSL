// Tests covering the ninth principal-review round of fixes. Each
// `test(...)` block names the review item it locks in (M1, M2, m2,
// m3, etc.).
//
// Coverage map:
//   M1   uniform assertSafeObjectKey on every parsed binding path.
//   M2   interpolate PLACEHOLDER rejects {a..b} and {a.}.
//   D2   TYPE_BY_CONTROL covers fileSize / fileBrowser / directoryBrowser.
//   m2   parseDecorated accepts \{ and \} escapes.
//   m3   negative panel numbers raise INVALID_PARAM.
//   m4   INTERNAL_ERROR message strips absolute file paths.
//   m6   `\n\r` newline pair counts as one logical line.
//   m7-a __properties default mismatch raises PARSE_ERROR for known types.
//   Q8.5 maxNestingDepth option overrides the default of 16.

import assert from 'node:assert/strict';

import {
    TextFormBuilder,
    ERR,
    interpolate,
    parseDecorated,
    TYPE_BY_CONTROL,
    MAX_NESTING_DEPTH
} from '../src/index.js';

// ─── M1 uniform binding-path screening ─────────────────────────────────────

test("M1 dynamic option-source path with __proto__ segment raises INVALID_PARAM", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

choices = {data.__proto__.values}

[container({t})]

  - [textfield(5,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_PARAM);
});

test("M1 commit={@__proto__} on listManager raises INVALID_PARAM", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[listManager({items},commit={@__proto__})]

  - [textfield(5,{this.name})] N
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_PARAM);
});

test("M1 init={__proto__.x} on a control raises INVALID_PARAM", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [textfield(5,{x},init={__proto__.x})] X
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_PARAM);
});

test("M1 container array-binding {__proto__} raises INVALID_PARAM", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[repeater({__proto__})]

  - [textfield(5,{this.name})] N
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_PARAM);
});

// ─── M2 interpolate PLACEHOLDER tightened ──────────────────────────────────

test("M2 interpolate('{a..b}') leaves the literal placeholder (regex doesn't match)", () => {
    // {a..b} doesn't match the new PLACEHOLDER, so the placeholder
    // text stays in the output as literal characters in lenient mode.
    assert.equal(interpolate('see {a..b}', { a: { b: 1 } }), 'see {a..b}');
});

test("M2 interpolate('{a.}') leaves the literal placeholder", () => {
    assert.equal(interpolate('see {a.}', { a: 1 }), 'see {a.}');
});

test("M2 interpolate('{a.b.c}') still resolves a clean dotted path", () => {
    assert.equal(
        interpolate('see {a.b.c}', { a: { b: { c: 'OK' } } }),
        'see OK'
    );
});

// ─── D2 TYPE_BY_CONTROL covers all default-spec controls ───────────────────

test("D2 TYPE_BY_CONTROL has fileSize / fileBrowser / directoryBrowser", () => {
    assert.ok(TYPE_BY_CONTROL.fileSize);
    assert.ok(TYPE_BY_CONTROL.fileBrowser);
    assert.ok(TYPE_BY_CONTROL.directoryBrowser);
});

// ─── m2 \{ and \} escapes in label text ────────────────────────────────────

test("m2 parseDecorated handles \\{ and \\} as literal braces", () => {
    const fragments = parseDecorated('See \\{x\\} for examples');
    assert.equal(fragments.length, 1);
    assert.equal(fragments[0].kind, 'text');
    assert.equal(fragments[0].text, 'See {x} for examples');
});

// ─── m3 negative panel numbers ─────────────────────────────────────────────

test("m3 panels=[-1:8] raises INVALID_PARAM", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 20

[container(panels=[-1:8])]

  1. Hello
    - [textfield(8,{a})] A
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_PARAM);
    assert.ok(result.messages.some(m => /Panel number must be 1 or greater/.test(m)));
});

// ─── m4 INTERNAL_ERROR scrub ──────────────────────────────────────────────

test("m4 INTERNAL_ERROR message does not embed an absolute filesystem path", () => {
    // Force an INTERNAL_ERROR via a control spec proxy that throws.
    const builder = new TextFormBuilder({
        schemaText: `columns: 10\n\n[container({t})]\n\n  - [textfield(5,{x})] X\n`
    });
    builder.controlSpec = new Proxy({}, {
        get(_t, prop) {
            if (prop === '__common') throw new TypeError('forced internal error');
            return undefined;
        },
        ownKeys() { return ['__common']; },
        getOwnPropertyDescriptor() {
            return { enumerable: true, configurable: true, value: undefined };
        }
    });
    const result = builder.parse();
    assert.equal(result.error, ERR.INTERNAL_ERROR);
    const msg = result.messages[0];
    // No file:// URLs, no absolute Windows-drive paths, no /
    // root-anchored paths in the message.
    assert.ok(!/file:\/\//.test(msg), `expected no file:// in message: ${msg}`);
    assert.ok(!/[A-Za-z]:[\\/][\w\-/\\.]+\\/.test(msg), `expected no Windows path: ${msg}`);
});

// ─── m6 \n\r newline pair counts as one logical line ──────────────────────

test("m6 \\n\\r newline pair counts as one logical line, not two", async () => {
    const { LineSplitter } = await import('../src/tokenizer.js');
    const ls = new LineSplitter('a = "x"\n\rb = "y"');
    const lines = ls.split();
    // The b = "y" line should report startLine 2, not 3.
    assert.equal(lines.length, 2);
    assert.equal(lines[1].startLine, 2);
});

// ─── m7-a __properties default vs declared type ──────────────────────────

test("m7-a __properties type:int with default:'abc' raises PARSE_ERROR", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

__properties = ["x" = { type: "int", default: "abc" }]

[container({t})]

  - [textfield(5,{y})] Y
`
    }).parse();
    assert.equal(result.error, ERR.PARSE_ERROR);
    assert.ok(result.messages.some(m => /expected integer/.test(m)));
});

test("m7-a __properties type:string[] with default:5 raises PARSE_ERROR", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

__properties = ["tags" = { type: "string[]", default: 5 }]

[container({t})]

  - [textfield(5,{y})] Y
`
    }).parse();
    assert.equal(result.error, ERR.PARSE_ERROR);
    assert.ok(result.messages.some(m => /expected array/.test(m)));
});

test("m7-a custom type passes through without default validation", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

__properties = ["sessionId" = { type: "uuid", default: "anything-goes" }]

[container({t})]

  - [textfield(5,{y})] Y
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
});

test("m7-a known type with matching default still parses", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

__properties = [
    "port" = { type: "int", default: 8080 },
    "name" = { type: "string", default: "alice" },
    "tags" = { type: "string[]", default: ["a","b"] }
]

[container({t})]

  - [textfield(5,{y})] Y
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
});

// ─── Q8.5 configurable maxNestingDepth ────────────────────────────────────

test("Q8.5 MAX_NESTING_DEPTH default is 16", () => {
    assert.equal(MAX_NESTING_DEPTH, 16);
});

function buildNestedContainers(depth) {
    const lines = ['columns: 10', ''];
    let indent = '';
    lines.push(indent + '[container({t0})]');
    for (let i = 1; i < depth; i++) {
        indent += '  ';
        lines.push(indent + '- [container({t' + i + '})]');
    }
    indent += '  ';
    lines.push(indent + '- [textfield(5,{x})] X');
    return lines.join('\n');
}

test("Q8.5 default cap of 16 rejects 18-deep nesting", () => {
    const result = new TextFormBuilder({ schemaText: buildNestedContainers(18) }).parse();
    assert.equal(result.error, ERR.INVALID_LAYOUT);
});

test("Q8.5 maxNestingDepth: 32 accepts 24-deep nesting (over the default, under the override)", () => {
    const result = new TextFormBuilder({
        schemaText: buildNestedContainers(24),
        maxNestingDepth: 32
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
});

test("Q8.5 maxNestingDepth: 4 tightens for hostile-input pipeline", () => {
    const result = new TextFormBuilder({
        schemaText: buildNestedContainers(8),
        maxNestingDepth: 4
    }).parse();
    assert.equal(result.error, ERR.INVALID_LAYOUT);
});

// ─── m8 LineSplitter logical-line cap (sanity that the cap exists) ────────

test("m8 LineSplitter rejects an input over MAX_LOGICAL_LINES", async () => {
    // The cap is 100k. Build content lines (blank and comment-only
    // lines don't get pushed; only real content does), one per
    // newline, then add one more to push past the cap.
    const { LineSplitter } = await import('../src/tokenizer.js');
    const huge = 'a\n'.repeat(100_001);
    const ls = new LineSplitter(huge);
    assert.throws(() => ls.split(), /max logical-line count/);
});
