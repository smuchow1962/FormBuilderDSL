// Tests covering the third principal-review round of fixes. Each
// `test(...)` block names the review item it locks in (2.1, 2.2,
// 2.3, 3.1, etc.) so a future maintainer can trace why the
// assertion exists.
//
// Coverage map:
//   2.1  interpolate {path} refuses prototype-walking segments.
//   2.2  renderFragments binding fragment uses the same safe walker.
//   2.3  Reserved keys (__proto__, prototype, constructor) are
//        rejected at every IDENT-to-dict-key write site.
//   3.1  Tokenizer rejects non-ASCII identifiers; doc now matches.
//   3.2  __properties block syntax in architecture.md matches the parser.
//   3.3  columns: 0 and columns: -N raise INVALID_PARAM.
//   3.4  parseDecorated accepts `\\` as a literal backslash.

import assert from 'node:assert/strict';

import {
    TextFormBuilder,
    ERR,
    interpolate,
    parseDecorated,
    renderFragments,
    collectProperties
} from '../src/index.js';

// ─── 2.1 interpolate prototype-walk guard ───────────────────────────────────

test("2.1 interpolate `{__proto__.toString}` throws at parse time (fail-fast on reserved segment)", () => {
    // Reserved segments raise ParseError(PARSE_ERROR) before any
    // substitution begins, regardless of strict / lenient mode.
    assert.throws(
        () => interpolate('see {__proto__.toString}', {}),
        /reserved name '__proto__'/
    );
});

test("2.1 interpolate `{constructor.name}` does not leak the constructor name (throws at parse)", () => {
    class HostData { constructor() { this.user = 'alice'; } }
    assert.throws(
        () => interpolate('hi {constructor.name}', new HostData()),
        /reserved name 'constructor'/
    );
});

test("2.1 interpolate strict mode throws on a prototype-walking placeholder (same as lenient)", () => {
    // Both modes throw on a reserved segment. The message is a
    // parse-time message ("contains reserved name 'X'"), not a
    // strict-mode runtime message ("missing data for ...").
    assert.throws(
        () => interpolate('hi {__proto__.toString}', {}, {}, { strict: true }),
        /reserved name '__proto__'/
    );
});

test("2.1 interpolate ignores inherited properties (own-property only)", () => {
    const proto = { inherited: 'leaked' };
    const data = Object.create(proto);
    data.own = 'kept';
    assert.equal(interpolate('a {own} b {inherited}', data), 'a kept b {inherited}');
});

// ─── 2.2 parseDecorated rejects prototype-walking placeholders ─────────────
//
// The parser-side screen now rejects {__proto__.x} and
// {constructor.x} at parse time (symmetric with assertSafeObjectKey
// in the rest of the parser). The render-time hasOwnProperty /
// resolveSafePath guards are still in place for any fragment a
// consumer hand-builds without going through parseDecorated.

test("2.2 parseDecorated('{__proto__.toString}') throws PARSE_ERROR", () => {
    assert.throws(
        () => parseDecorated('see {__proto__.toString}'),
        /reserved name '__proto__'/
    );
});

test("2.2 parseDecorated('{constructor.name}') throws PARSE_ERROR", () => {
    assert.throws(
        () => parseDecorated('see {constructor.name}'),
        /reserved name 'constructor'/
    );
});

test("2.2 hand-built binding fragment with prototype-walking path still resolves to undefined at render time", () => {
    // Defence-in-depth: a consumer who skips parseDecorated and
    // hands renderFragments a fragment with a forbidden path
    // doesn't get a prototype walk; the path resolves to undefined
    // and lenient mode renders the literal placeholder.
    const fragments = [{ kind: 'binding', path: '__proto__.toString' }];
    const out = renderFragments(fragments, {});
    assert.equal(out, '{__proto__.toString}');
});

// ─── 2.3 reserved keys rejected at parse time ───────────────────────────────

test("2.3 binding name `__proto__` raises INVALID_PARAM", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [textfield(5,{__proto__})] X
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_PARAM);
    assert.ok(result.messages.some(m => /__proto__/.test(m)));
});

test("2.3 binding name `constructor` raises INVALID_PARAM", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [textfield(5,{constructor})] X
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_PARAM);
});

test("2.3 dotted binding with a prototype segment raises INVALID_PARAM", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [textfield(5,{user.__proto__})] X
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_PARAM);
});

test("2.3 option-source name `__proto__` raises INVALID_PARAM", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

__proto__ = ["a","b"]

[container({t})]

  - [textfield(5,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_PARAM);
});

test("2.3 named-text key `__proto__` raises INVALID_PARAM", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

__proto__ = "hi"

[container({t})]

  - [textfield(5,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_PARAM);
});

test("2.3 named-object key `prototype` raises INVALID_PARAM", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

prototype = { a: 1 }

[container({t})]

  - [textfield(5,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_PARAM);
});

test("2.3 color name `constructor` raises INVALID_PARAM", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

colors = [constructor = "#FF0000"]

[container({t})]

  - [textfield(5,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_PARAM);
});

test("2.3 tooltip key `__proto__` raises INVALID_PARAM", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

tooltips = [__proto__ = "hi"]

[container({t})]

  - [textfield(5,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_PARAM);
});

test("2.3 __properties key `__proto__` raises INVALID_PARAM", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

__properties = ["__proto__" = { type: "int", default: 0 }]

[container({t})]

  - [textfield(5,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_PARAM);
});

test("2.3 collectProperties on a hand-built AST with __proto__ binding does not pollute", () => {
    // Hand-build an AST that bypasses the parse-time check, to lock
    // the defensive null-prototype dictionary at the collector level.
    const ast = {
        root: {
            nodeKind: 'container',
            headerControls: [],
            rows: [{
                nodeKind: 'row',
                controls: [{
                    nodeKind: 'control',
                    controlType: 'textfield',
                    binding: '__proto__'
                }]
            }]
        }
    };
    const props = collectProperties(ast);
    assert.equal(Object.getPrototypeOf(props), null, 'dictionary has null prototype');
    // The binding was skipped, not landed.
    assert.equal('__proto__' in props, false);
});

// ─── 3.1 ASCII identifier policy ────────────────────────────────────────────

test("3.1 ASCII identifier in binding parses fine", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [textfield(5,{customer_name})] Customer Name
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
});

test("3.1 Unicode in label text parses fine", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [textfield(5,{name})] お客様の名前
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
});

test("3.1 Unicode identifier in binding raises LEX_ERROR", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [textfield(5,{año})] X
`
    }).parse();
    assert.equal(result.error, ERR.LEX_ERROR);
    assert.ok(result.messages.some(m => /Unexpected character/.test(m)));
});

// ─── 3.3 columns floor ──────────────────────────────────────────────────────

test("3.3 columns: 0 raises INVALID_PARAM", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 0

[container({t})]

  - [textfield(5,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_PARAM);
    assert.ok(result.messages.some(m => /'columns' must be 1 or greater/.test(m)));
});

test("3.3 columns: -5 raises INVALID_PARAM", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: -5

[container({t})]

  - [textfield(5,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_PARAM);
});

test("3.3 columns: 1 is the floor and parses fine", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 1

[container({t})]

  - [textfield(1,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
});

// ─── 3.4 parseDecorated escaped backslash inside backtick spans ────────────

test("3.4 parseDecorated `\\\\` inside running text becomes one backslash", () => {
    const fragments = parseDecorated('a\\\\b');
    assert.equal(fragments[0].text, 'a\\b');
});

test("3.4 parseDecorated `\\``  still escapes a backtick", () => {
    const fragments = parseDecorated('a\\`b');
    assert.equal(fragments[0].text, 'a`b');
});

test("3.4 parseDecorated handles a path mixed with both escapes", () => {
    // `C:\\Users\\name` in a label should render `C:\Users\name`.
    const fragments = parseDecorated('C:\\\\Users\\\\name');
    assert.equal(fragments[0].text, 'C:\\Users\\name');
});

// ─── M1 evaluateWhen: whitespace-only `when=` is not an error ──────────────

test("evaluateWhen returns true for an empty when= source", async () => {
    const { evaluateWhen } = await import('../src/index.js');
    assert.equal(evaluateWhen('', {}), true);
});

test("evaluateWhen returns true for a whitespace-only when= source", async () => {
    const { evaluateWhen } = await import('../src/index.js');
    assert.equal(evaluateWhen('   ', {}), true);
    assert.equal(evaluateWhen('\t\t', {}), true);
});

test("parseWhen returns null for whitespace-only source (no AST, no throw)", async () => {
    const { parseWhen } = await import('../src/index.js');
    assert.equal(parseWhen('   '), null);
    assert.equal(parseWhen(''), null);
    assert.equal(parseWhen(null), null);
});

// ─── M3 listManager filter defaults to null; renderers fall back to 'name' ─

test("listManager filter is null when no filter= is set (renderer-side default)", () => {
    // Earlier rounds defaulted filter to the string 'name' on every
    // container kind; that bled the listManager-only field onto plain
    // containers. The parser now leaves filter null universally and
    // the renderer applies its own 'name' fallback.
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[listManager({items},search=true)]

  - [textfield(5,{this.name})] Name
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    assert.equal(result.payload.root.filter, null);
});

test("listManager filter='other' overrides the default", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[listManager({items},filter="label")]

  - [textfield(5,{this.label})] Label
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    assert.equal(result.payload.root.filter, 'label');
});

// ─── Belt-and-suspenders: collected dictionary uses null prototype ─────────

test("collectProperties returns an object with a null prototype", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [textfield(5,{x})] X
`
    }).process();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    assert.equal(Object.getPrototypeOf(result.payload.__properties), null);
});
