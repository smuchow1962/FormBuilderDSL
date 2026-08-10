// Tests covering the eleventh principal-review round of fixes.
//
// Coverage map:
//   2.1   #__proto__ in option-source value list raises INVALID_PARAM
//         (or INVALID_REF) instead of substituting Object.prototype.
//   2.2   Inline #__proto__ raises INVALID_PARAM at parse, never
//         INTERNAL_ERROR.
//   2.3   contentRef = '__proto__' raises INVALID_PARAM at parse.
//   2.4   Container parameter __proto__= raises INVALID_PARAM, not
//         INTERNAL_ERROR.
//   3.2   _rawExplain never appears in the public AST.
//   3.3   Negative integer params raise INVALID_PARAM uniformly.
//   3.4   Control parameter __proto__= raises INVALID_PARAM with a
//         clean message and the offending source position.
//   3.5   TypeScript narrowing: PlainContainerNode carries the same
//         shape the parser populates (shape parity verified at runtime).
//   5.1   state has no `input` field.
//   5.2   renderFragments unknown mode raises ParseError.
//   5.6   Nested arrays in __properties default raise PARSE_ERROR.
//   safeGet helper covered.

import assert from 'node:assert/strict';

import {
    TextFormBuilder,
    ERR,
    renderFragments,
    parseDecorated,
    ParseError
} from '../src/index.js';

// ─── 2.1 - 2.3 prototype-walking refs raise at parse time ─────────────────

test("2.1 #__proto__ in option-source value list raises INVALID_REF (no Object.prototype substitution)", () => {
    // safeGet on model.namedObjects refuses the reserved key, so
    // the resolution loop reports "Unknown named object '#__proto__'"
    // with INVALID_REF. The old bug silently substituted
    // Object.prototype here; that path is closed.
    const result = new TextFormBuilder({
        schemaText: `columns: 10

foo = [#__proto__]

[container({t})]

  - [textfield(5,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_REF);
    assert.ok(result.messages.some(m => /__proto__/.test(m)));
});

test("2.2 inline #__proto__ in container slot raises INVALID_REF at parse, never INTERNAL_ERROR", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container(#__proto__)]

  - [textfield(5,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_REF);
    assert.notEqual(result.error, ERR.INTERNAL_ERROR);
});

test("2.3 contentRef #__proto__ raises INVALID_REF at parse, never INTERNAL_ERROR", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [label(5,#__proto__)] X
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_REF);
    assert.notEqual(result.error, ERR.INTERNAL_ERROR);
});

// ─── 2.4 + 3.4 dispatcher screens at parse time ────────────────────────────

test("2.4 container parameter __proto__= raises INVALID_PARAM, not INTERNAL_ERROR", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t},__proto__=true)]

  - [textfield(5,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_PARAM);
    assert.ok(result.messages.some(m => /__proto__/.test(m)));
});

test("2.4 container parameter toString= raises INVALID_PARAM", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t},toString="x")]

  - [textfield(5,{x})] X
`
    }).parse();
    // toString isn't reserved, but it isn't a known container param
    // either. The dispatcher's safeGet returns undefined (own
    // properties only), so we get the clean "Unknown container
    // parameter" message instead of a TypeError.
    assert.equal(result.error, ERR.INVALID_PARAM);
    assert.ok(result.messages.some(m => /Unknown container parameter 'toString'/.test(m)));
});

test("3.4 control parameter __proto__= raises INVALID_PARAM with offending key", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [number(5,{x},__proto__=99)] X
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_PARAM);
    assert.ok(result.messages.some(m => /__proto__/.test(m)));
});

test("3.4 control parameter constructor= raises INVALID_PARAM", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [number(5,{x},constructor=99)] X
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_PARAM);
});

// ─── 3.2 _rawExplain leak ─────────────────────────────────────────────────

test("3.2 _rawExplain is not on a control with no explain= parameter", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [number(5,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.OK);
    const ctl = result.payload.root.rows[0].controls[0];
    assert.equal('_rawExplain' in ctl, false);
});

test("3.2 _rawExplain is gone after rewrite even when explain= was set", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

note = "fine print"

[container({t})]

  - [number(5,{x},explain=#note)] X
`
    }).parse();
    assert.equal(result.error, ERR.OK);
    const ctl = result.payload.root.rows[0].controls[0];
    assert.equal('_rawExplain' in ctl, false, '_rawExplain should be deleted after rewrite');
    assert.ok(Array.isArray(ctl.explain));
});

// ─── 3.3 integer params default to non-negative ───────────────────────────

test("3.3 textarea rows=-3 raises INVALID_PARAM", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [textarea(5,{x},rows=-3)] X
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_PARAM);
    assert.ok(result.messages.some(m => /rows.*0 or greater/.test(m)));
});

test("3.3 file maxBytes=-1 raises INVALID_PARAM", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [file(5,{x},maxBytes=-1)] X
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_PARAM);
});

test("3.3 multiselect min=-1 raises INVALID_PARAM", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

choices = ["a","b"]

[container({t})]

  - [multiselect(5,#choices,{x},min=-1)] X
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_PARAM);
});

test("3.3 textarea rows=4 still parses fine (positive integer)", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [textarea(5,{x},rows=4)] X
`
    }).parse();
    assert.equal(result.error, ERR.OK);
    assert.equal(result.payload.root.rows[0].controls[0].params.rows, 4);
});

// ─── 3.5 container variant TS shape vs runtime ────────────────────────────

test("3.5 plain container exposes every list-manager-shaped field at runtime", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [textfield(5,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.OK);
    const root = result.payload.root;
    // Fields that exist on every container kind at runtime.
    assert.equal(root.search,       false);
    assert.equal(root.filter,       null);
    assert.equal(root.draggable,    false);
    assert.equal(root.addLabel,     null);
    assert.equal(root.commit,       null);
    assert.equal(root.excludedRef,  null);
    assert.equal(root.arrayBinding, null);
});

// ─── 5.1 state.input is gone ──────────────────────────────────────────────

test("5.1 createParserState carries no `input` field", async () => {
    const { createParserState } = await import('../src/parser/state.js');
    const state = createParserState({}, {});
    assert.equal('input' in state, false);
});

// ─── 5.2 renderFragments unknown mode → ParseError ───────────────────────

test("5.2 renderFragments({ mode: 'plaintext' }) raises ParseError(INVALID_PARAM)", () => {
    const fragments = parseDecorated('hi');
    try {
        renderFragments(fragments, {}, {}, { mode: 'plaintext' });
        assert.fail('expected throw');
    } catch (e) {
        assert.ok(e instanceof ParseError);
        assert.equal(e.code, ERR.INVALID_PARAM);
        assert.match(e.message, /unknown mode 'plaintext'/);
    }
});

// ─── 5.6 nested arrays in __properties default ───────────────────────────

test("5.6 __properties default with nested array raises PARSE_ERROR", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

__properties = ["nested" = { type: "string[]", default: [["a","b"]] }]

[container({t})]

  - [textfield(5,{y})] Y
`
    }).parse();
    assert.equal(result.error, ERR.PARSE_ERROR);
    assert.ok(result.messages.some(m => /Nested arrays are not allowed/.test(m)));
});

// ─── safeGet helper ──────────────────────────────────────────────────────

test("safeGet returns undefined for reserved keys regardless of map shape", async () => {
    const { safeGet } = await import('../src/safe-keys.js');
    // Plain {} map (carries Object.prototype). safeGet still refuses.
    const plain = { a: 1 };
    assert.equal(safeGet(plain, '__proto__'),    undefined);
    assert.equal(safeGet(plain, 'constructor'),  undefined);
    assert.equal(safeGet(plain, 'prototype'),    undefined);
    assert.equal(safeGet(plain, 'toString'),     undefined);   // own-property check
    assert.equal(safeGet(plain, 'a'),            1);
});

test("safeGet returns undefined for null map", async () => {
    const { safeGet } = await import('../src/safe-keys.js');
    assert.equal(safeGet(null, 'a'), undefined);
    assert.equal(safeGet(undefined, 'a'), undefined);
});

test("safeGet on null-prototype map returns own properties only", async () => {
    const { safeGet } = await import('../src/safe-keys.js');
    const m = Object.create(null);
    m.x = 42;
    assert.equal(safeGet(m, 'x'), 42);
    assert.equal(safeGet(m, '__proto__'), undefined);
    assert.equal(safeGet(m, 'toString'), undefined);
});

// ─── Sanity: INVALID_PARAM is the parse-time error code, not INTERNAL_ERROR ──

test("regression sanity: __proto__ never reaches INTERNAL_ERROR via any of the four paths", () => {
    const sources = [
        // value list ref
        `columns: 10\nfoo = [#__proto__]\n[container({t})]\n  - [textfield(5,{x})] X\n`,
        // inline ref
        `columns: 10\n[container(#__proto__)]\n  - [textfield(5,{x})] X\n`,
        // contentRef
        `columns: 10\n[container({t})]\n  - [label(5,#__proto__)] X\n`,
        // container param
        `columns: 10\n[container({t},__proto__=true)]\n  - [textfield(5,{x})] X\n`,
        // control param
        `columns: 10\n[container({t})]\n  - [number(5,{x},__proto__=99)] X\n`
    ];
    for (const src of sources) {
        const r = new TextFormBuilder({ schemaText: src }).parse();
        assert.notEqual(r.error, ERR.INTERNAL_ERROR, `INTERNAL_ERROR for: ${src.split('\n')[1]}`);
        assert.notEqual(r.error, ERR.OK,             `unexpectedly OK: ${src.split('\n')[1]}`);
    }
});
