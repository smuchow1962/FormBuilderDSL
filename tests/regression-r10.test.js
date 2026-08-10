// Tests covering the tenth principal-review round of fixes.
//
// Coverage map:
//   3.1   compute= rejects literal and {path}; accepts {@fn}.
//   3.2   parseDecorated screens prototype-walking placeholders.
//   3.3   process() wraps mergeProperties exception as INTERNAL_ERROR.
//   5.1   tokenizer no longer treats `in` as a path-opening token.
//   5.2   TextFormBuilder default export is gone (named only).
//   5.5   validateProperties splits null-AST from missing-root.
//   5.6   inferDataSchema sources are sorted by line.
//   Q8.3  VERSION export stays in sync with package.json.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
    TextFormBuilder,
    ERR,
    parseDecorated,
    inferDataSchema,
    validateProperties,
    VERSION
} from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

// ─── 3.1 compute= must be a function ──────────────────────────────────────

test("3.1 compute=42 raises INVALID_PARAM (literal not allowed)", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [number(5,{x},compute=42)] X
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_PARAM);
    assert.ok(result.messages.some(m => /function reference/.test(m)));
});

test("3.1 compute={otherField} raises INVALID_PARAM (binding not allowed)", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [number(5,{x},compute={other})] X
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_PARAM);
});

test("3.1 compute={@calcX} parses cleanly", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [number(5,{x},compute={@calcX})] X
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    const ctl = result.payload.root.rows[0].controls[0];
    assert.deepEqual(ctl.compute, { kind: 'function', name: 'calcX' });
});

test("3.1 compute={@registry.calcX} dotted function ref parses", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [number(5,{x},compute={@math.add})] X
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    assert.equal(result.payload.root.rows[0].controls[0].compute.name, 'math.add');
});

// ─── 3.2 parseDecorated screens prototype names ──────────────────────────

test("3.2 parseDecorated('{__proto__}') raises PARSE_ERROR", () => {
    assert.throws(() => parseDecorated('see {__proto__}'), /reserved name '__proto__'/);
});

test("3.2 parseDecorated('{@constructor}') raises PARSE_ERROR", () => {
    assert.throws(() => parseDecorated('see {@constructor}'), /reserved name 'constructor'/);
});

test("3.2 parseDecorated('{a.constructor.b}') raises PARSE_ERROR (dotted segment screen)", () => {
    assert.throws(() => parseDecorated('see {a.constructor.b}'), /reserved name 'constructor'/);
});

test("3.2 parseDecorated('{customer.name}') still parses cleanly", () => {
    const fragments = parseDecorated('see {customer.name}');
    assert.equal(fragments[1].kind, 'binding');
    assert.equal(fragments[1].path, 'customer.name');
});

// ─── 3.3 process() wraps mergeProperties exceptions ──────────────────────

test("3.3 process() returns INTERNAL_ERROR when mergeProperties throws", () => {
    // Force mergeProperties to throw by feeding a parsed AST whose
    // __properties has a frozen entry that mergeProperties tries to
    // overwrite. Easier: monkey-patch process() to call mergeProperties
    // with a poison existing dict. Since the merge runs inside a try
    // now, the exception comes back as INTERNAL_ERROR.
    //
    // The simplest path: trigger via a Proxy on the parsed payload's
    // __properties getter that throws when iterated.
    const builder = new TextFormBuilder({
        schemaText: `columns: 10

__properties = ["x" = { type: "string", default: "a" }]

[container({t})]

  - [textfield(5,{x})] X
`
    });
    // Wrap process: parse first, then poison __properties on the
    // payload before mergeProperties runs.
    const originalParse = builder.parse.bind(builder);
    builder.parse = function () {
        const r = originalParse();
        if (r.error === ERR.OK) {
            const trap = new Proxy({}, {
                ownKeys() { throw new TypeError('forced merge fault'); },
                getOwnPropertyDescriptor() { return undefined; },
                get() { return undefined; }
            });
            r.payload.__properties = trap;
        }
        return r;
    };
    const result = builder.process();
    assert.equal(result.error, ERR.INTERNAL_ERROR);
    assert.ok(result.messages.some(m => /process\(\)|forced merge fault/.test(m)));
});

// ─── 5.1 tokenizer dead `in` arm removed ─────────────────────────────────

test("5.1 outer DSL: bare `in` followed by [ does not silently re-classify the bracket", async () => {
    // The outer DSL has no `in` operator. With the dead arm removed,
    // an authoring error like `name = in [a,b]` no longer tries to
    // treat `[` as an array literal opener; it raises a parse error
    // pointing at the bare `in` token.
    const result = new TextFormBuilder({
        schemaText: `columns: 10

choices = in [1,2]
`
    }).parse();
    assert.equal(result.error, ERR.PARSE_ERROR);
});

// ─── 5.2 default export removed ──────────────────────────────────────────

test("5.2 TextFormBuilder module no longer ships a default export", async () => {
    const mod = await import('../src/text-form-builder.js');
    assert.equal(typeof mod.TextFormBuilder, 'function');
    assert.equal(mod.default, undefined);
});

// ─── 5.5 validateProperties null vs missing root ────────────────────────

test("5.5 validateProperties(null) returns 'No AST provided'", () => {
    const errors = validateProperties(null);
    assert.deepEqual(errors, ['No AST provided']);
});

test("5.5 validateProperties({}) returns 'AST has no root container'", () => {
    const errors = validateProperties({});
    assert.deepEqual(errors, ['AST has no root container']);
});

// ─── 5.6 inferDataSchema sources sorted by line ──────────────────────────

test("5.6 sources[0] for a field referenced in tooltip and a control points at earliest by line", () => {
    // The tooltip body lives under the tooltips block (early lines).
    // The control that uses {x} lives later. After sorting, the
    // first source for `x` is the earliest line, which is the
    // tooltip in this case (line 3) followed by the control (line 9).
    const result = new TextFormBuilder({
        schemaText: `columns: 10

tooltips = [help = "value: {x}"]

[container({t})]

  - [textfield(5,{x},tt="help")] X
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    const schema = inferDataSchema(result.payload);
    const xField = schema.fields.find(f => f.path === 'x');
    assert.ok(xField, 'expected an `x` field in inferred schema');
    // Sources are sorted by line; first one is the earliest mention.
    const lines = xField.sources.map(s => s.line ?? 0);
    const sorted = [...lines].sort((a, b) => a - b);
    assert.deepEqual(lines, sorted, 'sources should be in line order');
});

// ─── Q8.3 version bump ───────────────────────────────────────────────────

test("Q8.3 VERSION export matches package.json", () => {
    assert.equal(VERSION, pkg.version);
});

// ─── Sanity: existing compute consumer still works through inferSchema ───

test("compute={@fn} surfaces in inferDataSchema as a function context", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [number(5,{x},compute={@calcX})] X
`
    }).parse();
    assert.equal(result.error, ERR.OK);
    const schema = inferDataSchema(result.payload);
    const fn = schema.functions.find(f => f.name === 'calcX');
    assert.ok(fn, 'expected calcX in functions');
    assert.ok(fn.contexts.some(c => c.kind === 'compute'));
});
