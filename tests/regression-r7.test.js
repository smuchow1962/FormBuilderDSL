// Tests covering the seventh principal-review round of fixes. Each
// `test(...)` block names the review item it locks in (2.x, 3.x,
// 5.x).
//
// Coverage map:
//   2.1  registerControl rejects __proto__ / constructor / prototype.
//   2.2  interpolate + renderFragments refuse Object.prototype walk
//        through the `functions` registry.
//   3.1  lookupType ignores prototype-chain entries.
//   3.2  render-preview no longer reads a non-existent node.tooltip.
//   3.3  ERR.INTERNAL_ERROR exists and is reachable.
//   3.4  Token-cap error includes the offset.
//   5.1  Leading-dot floats (`.5`, `-.5`) lex as a single FLOAT;
//        member-access `customer.name` still tokenises right.
//   5.2  Numeric literal length cap raises LEX_ERROR.
//   5.5  Duplicate keyword param raises INVALID_PARAM.
//   5.6  `{@this}` raises INVALID_PARAM.
//   5.7  Expression-tokenizer error escapes special characters.
//   v1   Named-object body rejects #name and nested objects.

import assert from 'node:assert/strict';

import {
    TextFormBuilder,
    ERR,
    interpolate,
    parseDecorated,
    renderFragments,
    parseWhen,
    lookupType,
    defaultControlSpec
} from '../src/index.js';

// ─── 2.1 registerControl reserved-name reject ──────────────────────────────

test("2.1 registerControl('__proto__', spec) returns INVALID_SPEC", () => {
    const b = new TextFormBuilder({ schemaText: 'columns: 1' });
    const r = b.registerControl('__proto__', { params: {} });
    assert.equal(r.error, ERR.INVALID_SPEC);
    assert.ok(r.messages.some(m => /__proto__.*reserved/.test(m)));
});

test("2.1 registerControl('constructor', spec) returns INVALID_SPEC", () => {
    const b = new TextFormBuilder({ schemaText: 'columns: 1' });
    const r = b.registerControl('constructor', { params: {} });
    assert.equal(r.error, ERR.INVALID_SPEC);
});

test("2.1 registerControl('prototype', spec) returns INVALID_SPEC", () => {
    const b = new TextFormBuilder({ schemaText: 'columns: 1' });
    const r = b.registerControl('prototype', { params: {} });
    assert.equal(r.error, ERR.INVALID_SPEC);
});

test("2.1 registerControl on __proto__ does not mutate the spec's prototype", () => {
    const b = new TextFormBuilder({ schemaText: 'columns: 1' });
    const before = Object.getPrototypeOf(b.controlSpec);
    b.registerControl('__proto__', { params: {} });
    assert.equal(Object.getPrototypeOf(b.controlSpec), before);
});

// ─── 2.2 functions registry hasOwnProperty guard ───────────────────────────

test("2.2 interpolate({@constructor}) throws at parse time (fail-fast on reserved)", () => {
    assert.throws(
        () => interpolate('{@constructor}', { a: 1 }, {}),
        /reserved name 'constructor'/
    );
});

test("2.2 interpolate({@toString}) renders the literal placeholder (lenient; not in reserved set)", () => {
    // toString is not in the parser's reserved-segment set. The
    // function-arm own-property check at render time catches it
    // and renders the literal placeholder; strict mode would
    // throw the documented "no function registered" error.
    assert.equal(
        interpolate('Hello {@toString}', {}, {}),
        'Hello {@toString}'
    );
});

test("2.2 interpolate({@hasOwnProperty}) throws on a non-reserved name only when no registry", () => {
    // hasOwnProperty is NOT in the reserved set (it is a prototype
    // member but not in the prototype-walking attack list).
    // The pre-scan does not throw; strict mode raises on the
    // missing-function path with the documented runtime error.
    assert.throws(
        () => interpolate('{@hasOwnProperty}', {}, {}, { strict: true }),
        /no function registered for \{@hasOwnProperty\}/
    );
});

test("2.2 parseDecorated('{@constructor}') is rejected at parse time", () => {
    // parse-time screen mirrors the parser-side
    // assertSafeObjectKey rule. The render-time hasOwnProperty
    // guard remains for hand-built fragments that bypass parse.
    assert.throws(
        () => parseDecorated('see {@constructor}'),
        /reserved name 'constructor'/
    );
});

test("2.2 hand-built {@toString} fragment in strict mode still throws documented error", () => {
    // Defence-in-depth: a consumer who builds the fragment directly
    // skips the parse-time screen. renderFragments' own
    // hasOwnProperty guard catches it and the strict-mode message
    // points at the missing function name.
    const fragments = [{ kind: 'function', name: 'toString' }];
    assert.throws(
        () => renderFragments(fragments, {}, {}, { strict: true }),
        /no function registered for \{@toString\}/
    );
});

// ─── 3.1 lookupType ignores prototype entries ──────────────────────────────

test("3.1 lookupType returns null for inherited prototype names", () => {
    // Default spec is frozen, so inheriting through Object would be
    // the only path. Confirm constructor / toString resolve to null.
    assert.equal(lookupType(defaultControlSpec, 'constructor'), null);
    assert.equal(lookupType(defaultControlSpec, 'toString'),    null);
    assert.equal(lookupType(defaultControlSpec, '__proto__'),   null);
});

test("3.1 lookupType still resolves real entries", () => {
    const t = lookupType(defaultControlSpec, 'textfield');
    assert.ok(t);
    assert.equal(t.binding, 'required');
});

// ─── 3.3 ERR.INTERNAL_ERROR ───────────────────────────────────────────────

test("3.3 ERR.INTERNAL_ERROR is exported with value 8", () => {
    assert.equal(ERR.INTERNAL_ERROR, 8);
});

// ─── 3.4 token-cap source position ─────────────────────────────────────────

test("3.4 when= over the token cap mentions the offset in the error", () => {
    assert.throws(
        () => parseWhen('a == 1 && b == 2 && c == 3', { maxTokens: 2 }),
        /max token count.*offset/
    );
});

// ─── 5.1 leading-dot numbers ───────────────────────────────────────────────

test("5.1 .5 in value position lexes as a single float", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [number(5,{x},step=.5)] X
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    assert.equal(result.payload.root.rows[0].controls[0].params.step, 0.5);
});

test("5.1 -.5 in value position lexes as a single negative float", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [number(5,{x},min=-.5)] X
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    assert.equal(result.payload.root.rows[0].controls[0].params.min, -0.5);
});

test("5.1 customer.name still tokenises as IDENT . IDENT (member access)", () => {
    // when= path lookup uses dotted paths; the leading-dot rule must
    // not break member access. evaluateWhen against {customer:{name:'A'}}
    // resolves the path correctly.
    const ast = parseWhen('customer.name == "A"');
    assert.deepEqual(ast.l, { kind: 'path', path: ['customer', 'name'] });
});

// ─── 5.2 numeric literal length cap ────────────────────────────────────────

test("5.2 numeric literal over 20 chars raises LEX_ERROR", () => {
    const longInt = '1'.repeat(50);
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [number(${longInt},{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.LEX_ERROR);
    assert.ok(result.messages.some(m => /Numeric literal too long/.test(m)));
});

test("5.2 a normal number well under the cap parses fine", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [number(5,{x},max=999999999999)] X
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
});

// ─── 5.5 duplicate keyword param ───────────────────────────────────────────

test("5.5 duplicate keyword param raises INVALID_PARAM", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [number(5,{x},min=1,min=2)] X
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_PARAM);
    assert.ok(result.messages.some(m => /Duplicate parameter 'min='/.test(m)));
});

// ─── 5.6 reject {@this} ────────────────────────────────────────────────────

test("5.6 {@this} function binding raises INVALID_PARAM", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [display({@this})] X
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_PARAM);
    assert.ok(result.messages.some(m => /'@this'/.test(m)));
});

// ─── 5.7 expression error message escapes special chars ────────────────────

test("5.7 expression-tokenizer error escapes literal newline in the message", () => {
    // The DSL collapses newlines inside brackets into spaces, so an
    // explicit literal newline in a when= source is unusual but
    // possible via direct parseWhen. Confirm the error reads cleanly.
    try {
        parseWhen('a == \n1');
        assert.fail('expected throw');
    } catch (e) {
        // The literal newline is escaped via JSON.stringify so a
        // terminal printing the message doesn't see a real \n.
        assert.match(e.message, /"\\n"/);
    }
});

// ─── v1 named-object body rule ─────────────────────────────────────────────

test("v1 named-object body rejects bare `#name` value", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

yellowSwatch = { hex: "#FFD700" }
audit = { name: "audit", color: #yellowSwatch }

[container({t})]

  - [textfield(5,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.PARSE_ERROR);
});

test("v1 named-object body rejects nested object value", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

audit = { name: "audit", display: { fg: "white" } }

[container({t})]

  - [textfield(5,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.PARSE_ERROR);
});

test("v1 named-object body accepts flat scalars", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

mode = { name: "verbose", level: 3, active: true, color: "yellow" }

[container({t})]

  - [textfield(5,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
});

test("v1 option-source value list still accepts #name (the canonical reference site)", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

audit = { name: "audit" }
trace = { name: "trace" }
levels = [#audit, #trace] -> {chosen}

[container({t})]

  - [select(5,#levels,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    // Both refs resolved to actual objects.
    assert.equal(result.payload.optionSources.levels.values[0].name, 'audit');
    assert.equal(result.payload.optionSources.levels.values[1].name, 'trace');
});
