// Tests covering the fourth principal-review round of fixes. Each
// `test(...)` block names the review item it locks in (4.x, 5.x) so
// a future maintainer can trace why the assertion exists.
//
// Coverage map:
//   4.5  parseBindingPath now accepts dotted function refs (@a.b).
//   4.7  parsePropertiesBlock returns a null-prototype dictionary
//        (matching collectProperties).
//   5.2  Bare `&&` outside a when= string raises LEX_ERROR (not
//        silently emitted as IDENT).
//   5.4  Empty option-source list emits a warning on success.
//   5.5  Duplicate option-source values emit a warning on success.
//   5.6  String literals share grammar between DSL tokenizer and the
//        when= expression tokenizer (locked via behaviour parity).
//   5.9  renderFragments strict messages now mirror interpolate's.
//   5.10 Panel width 0 is allowed; negative still rejected.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    TextFormBuilder,
    ERR,
    parseDecorated,
    renderFragments
} from '../src/index.js';

// ─── 4.5 dotted function refs in DSL ────────────────────────────────────────

test("4.5 [textfield(5,{@math.add})] parses cleanly with dotted function path", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [display(5,{@math.add})] Sum
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    const ctl = result.payload.root.rows[0].controls[0];
    assert.equal(ctl.binding, '@math.add');
});

test("4.5 dotted function ref on a writeable control still rejected (function-binding policy)", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [textfield(5,{@math.add})] Whatever
`
    }).parse();
    // textfield is writeable; function bindings are read-only-only.
    assert.equal(result.error, ERR.INVALID_PARAM);
});

// ─── 4.7 explicit __properties block returns null-prototype object ─────────

test("4.7 explicit __properties block produces a null-prototype dictionary", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

__properties = ["port" = { type: "int", default: 8080 }]

[container({t})]

  - [number(5,{port})] Port
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    assert.equal(Object.getPrototypeOf(result.payload.__properties), null);
});

test("4.7 collected __properties (process(), no block) also has null prototype", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [number(5,{port})] Port
`
    }).process();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    assert.equal(Object.getPrototypeOf(result.payload.__properties), null);
});

// ─── 5.2 bare `&&` outside when= raises LEX_ERROR ──────────────────────────

test("5.2 bare && outside a when= string raises LEX_ERROR", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

a && b = ["x"]
`
    }).parse();
    assert.equal(result.error, ERR.LEX_ERROR);
});

// ─── 5.4 empty option-source list warns on success ─────────────────────────

test("5.4 empty option-source list emits a warning, not an error", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

empty = []

[container({t})]

  - [select(5,#empty,{x})] Pick
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    assert.ok(
        result.messages.some(m => /Option source 'empty' is empty/.test(m)),
        `expected empty-list warning, got: ${result.messages.join(' | ')}`
    );
});

// ─── 5.5 duplicate option-source values warn on success ────────────────────

test("5.5 duplicate option-source values emit a warning", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

dups = ["a","a","b"]

[container({t})]

  - [select(5,#dups,{x})] Pick
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    assert.ok(
        result.messages.some(m => /Option source 'dups' has duplicate values/.test(m)),
        `expected duplicate-values warning, got: ${result.messages.join(' | ')}`
    );
});

test("5.5 unique option-source values produce no warning", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

clean = ["a","b","c"]

[container({t})]

  - [select(5,#clean,{x})] Pick
`
    }).parse();
    assert.equal(result.error, ERR.OK);
    assert.deepEqual(result.messages, []);
});

// ─── 5.6 string-literal grammar shared between DSL and when= ───────────────

test("5.6 DSL string literal: \\\\ becomes one backslash", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [textfield(5,{x},placeholder="C:\\\\path")] Path
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    const ctl = result.payload.root.rows[0].controls[0];
    assert.equal(ctl.params.placeholder, 'C:\\path');
});

test("5.6 when= string literal: \\\\ becomes one backslash (same rule)", async () => {
    const { parseWhen } = await import('../src/index.js');
    // The DSL stores the when= text as the literal source string.
    // parseWhen runs its own lexer over that source. Both lexers
    // route through src/string-literal.js, so an escaped backslash
    // in the when= source decodes to a single backslash the same
    // way it does in the outer DSL.
    const ast = parseWhen("path == 'C:\\\\name'");
    assert.equal(ast.r.v, 'C:\\name');
});

// ─── 5.9 renderFragments strict messages mirror interpolate ────────────────

test("5.9 renderFragments strict on missing binding says 'missing data'", () => {
    const fragments = parseDecorated('Hi {x}');
    assert.throws(
        () => renderFragments(fragments, {}, {}, { strict: true }),
        /missing data for \{x\}/
    );
});

test("5.9 renderFragments strict on missing function says 'no function registered'", () => {
    const fragments = parseDecorated('see {@x}');
    assert.throws(
        () => renderFragments(fragments, {}, {}, { strict: true }),
        /no function registered for \{@x\}/
    );
});

test("5.9 renderFragments strict on null-returning function says 'returned null or undefined'", () => {
    const fragments = parseDecorated('see {@empty}');
    const fns = { empty: () => null };
    assert.throws(
        () => renderFragments(fragments, {}, fns, { strict: true }),
        /returned null or undefined/
    );
});

// ─── 5.10 panel width 0 ─────────────────────────────────────────────────────

test("5.10 panel width 0 parses cleanly", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 20

[container(panels=[1:0,2:5])]

  1. Hidden
    - [textfield(5,{a})] A

  2. Visible
    - [textfield(5,{b})] B
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    assert.equal(result.payload.root.panels[0].width, 0);
});
