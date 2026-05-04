// Tests covering the sixth principal-review round of fixes. Each
// `test(...)` block names the review item it locks in (3.x, 5.x).
//
// Coverage map:
//   3.2  PLACEHOLDER regex uses named capture groups (verified by
//        successful run after the change; named groups appear in
//        the regex but the test pins the behaviour, not the regex).
//   3.3  bare `{this}` binding raises INVALID_PARAM; `{this.x}` in
//        a repeater scope still works.
//   3.4  validateProperties uses Object.prototype.hasOwnProperty so
//        a caller-supplied {} dict can't surprise the lookup with
//        an inherited entry.
//   3.5  `\[` and `\]` in label / header text render as literal
//        brackets without confusing the parser.
//   5.1  _postProcessSquareBrackets handles a deeply-nested array
//        without quadratic blow-up (smoke test on a moderate
//        nesting; behaviour parity is the lock).
//   5.4  Inline `tooltip="..."` parameter on container is no longer
//        accepted; only `tt="key"` is.
//   5.5  Non-ParseError exceptions become INTERNAL_ERROR.
//   5.7  Spec is not frozen by validateControlSpec.
//   5.8  hidden control (width 0) contributes 0 to layout sum.
//   5.9  Bare ident `tru` / `falsey` / `nul` in object value -> PARSE_ERROR.
//   5.10 EOF push counts against the maxTokens cap.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    TextFormBuilder,
    ERR,
    parseDecorated,
    renderFragments,
    parseWhen,
    interpolate,
    validateControlSpec
} from '../src/index.js';

// ─── 3.2 named capture groups in PLACEHOLDER ───────────────────────────────

test("3.2 interpolate placeholder still resolves correctly with named-capture regex", () => {
    assert.equal(
        interpolate('Hello {customer.name}', { customer: { name: 'Ada' } }),
        'Hello Ada'
    );
    assert.equal(
        interpolate('see {@fn}', {}, { fn: () => 'OK' }),
        'see OK'
    );
});

// ─── 3.3 bare `{this}` rejected ────────────────────────────────────────────

test("3.3 bare {this} binding raises INVALID_PARAM", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [textfield(5,{this})] X
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_PARAM);
    assert.ok(result.messages.some(m => /'this'/.test(m)));
});

test("3.3 dotted `{this.field}` inside a repeater is still legal", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[repeater({items})]

  - [textfield(5,{this.name})] Name
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
});

// ─── 3.4 validateProperties hasOwnProperty guard ───────────────────────────

test("3.4 validateProperties uses own-property check on a caller-supplied dict", async () => {
    const { validateProperties } = await import('../src/index.js');
    // Build a fake AST + a `__properties` dict that's a plain {}
    // (so its prototype is Object.prototype). The expected entry
    // `port` is NOT an own property; it would show up as `'port' in
    // props` only if the test poisoned Object.prototype, which we
    // don't do here. The test pins the contract: validateProperties
    // reports the missing own-property entry.
    const ast = {
        root: {
            nodeKind: 'container',
            headerControls: [],
            rows: [{
                nodeKind: 'row',
                controls: [{
                    nodeKind: 'control',
                    controlType: 'textfield',
                    binding: 'port'
                }]
            }]
        },
        __properties: {}
    };
    const errors = validateProperties(ast);
    assert.ok(errors.some(e => /missing entry for 'port'/.test(e)));
});

// ─── 3.5 escape brackets in label text ─────────────────────────────────────

test("3.5 \\[ and \\] in container header text render as literal brackets", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})] Step \\[1\\] of 5

  - [textfield(5,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    const label = result.payload.root.label;
    // Label is a single text fragment: "Step [1] of 5"
    assert.equal(label.length, 1);
    assert.equal(label[0].kind, 'text');
    assert.equal(label[0].text, 'Step [1] of 5');
});

test("3.5 \\[ in a control label also works", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [textfield(5,{x})] Username \\[required\\]
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    const ctlLabel = result.payload.root.rows[0].controls[0].label;
    assert.equal(ctlLabel[0].text, 'Username [required]');
});

// ─── 5.1 stack-based _postProcessSquareBrackets behaviour parity ───────────

test("5.1 deeply-nested __properties default array still parses", () => {
    // The old quadratic-worst-case rewrite was correct; the new
    // explicit-stack version must match. A nested array is the
    // most exercising shape.
    const result = new TextFormBuilder({
        schemaText: `columns: 10

__properties = ["nested" = { type: "string[]", default: ["a","b","c","d"] }]

[container({t})]

  - [textfield(5,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    assert.deepEqual(result.payload.__properties.nested.default, ['a','b','c','d']);
});

// ─── 5.4 inline tooltip="..." on container removed ─────────────────────────

test("5.4 container tooltip=\"literal\" is no longer accepted", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t},tooltip="hover help")]

  - [textfield(5,{x})] X
`
    }).parse();
    // Container parameter handler for `tooltip` is gone, so the
    // dispatcher reports it as an unknown parameter.
    assert.equal(result.error, ERR.INVALID_PARAM);
    assert.ok(result.messages.some(m => /Unknown container parameter 'tooltip'/.test(m)));
});

test("5.4 container tt=\"key\" still works (single tooltip surface)", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

tooltips = [help = "click for details"]

[container({t},tt="help")]

  - [textfield(5,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    assert.equal(result.payload.root.tooltipRef, 'help');
});

// ─── 5.5 INTERNAL_ERROR captures non-ParseError exceptions ─────────────────

test("5.5 a runtime exception inside the parser becomes INTERNAL_ERROR", () => {
    // Force a non-ParseError exception path. A controlSpec proxy
    // that throws on `__common` access tickles validateControlSpec
    // (which iterates Object.keys looking for `__common` and
    // touches `spec.__common.params`). The thrown TypeError is now
    // caught by runParse and lifted into TupleResponse instead of
    // surfacing in the consumer's stack trace.
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
    assert.ok(
        result.messages.some(m => /TypeError|forced internal error/.test(m)),
        `expected INTERNAL_ERROR message, got: ${result.messages.join(' | ')}`
    );
});

test("5.5 ParseError still maps to its own error code, not INTERNAL_ERROR", () => {
    // Sanity: a real PARSE_ERROR doesn't get re-coded to 8.
    const result = new TextFormBuilder({
        schemaText: 'columns: -5'
    }).parse();
    assert.equal(result.error, ERR.INVALID_PARAM);
});

// ─── 5.7 spec not frozen by validateControlSpec ────────────────────────────

test("5.7 validateControlSpec leaves the spec mutable", () => {
    const spec = {
        __common: { params: {} },
        textfield: { params: {} }
    };
    validateControlSpec(spec);
    assert.equal(Object.isFrozen(spec), false);
    // Mutation succeeds without TypeError.
    spec.newType = { params: {} };
    assert.ok(spec.newType);
});

// ─── 5.8 hidden width 0 contributes 0 to row sum ───────────────────────────

test("5.8 hidden control with width 0 contributes 0 to layout sum", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 5

[container({t})]

  - [hidden({secret})] [textfield(5,{visible})] V
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    // Row total is 0 (hidden) + 5 (textfield) = 5, exactly matching
    // columns. If hidden contributed anything, this would overflow.
    const ctls = result.payload.root.rows[0].controls;
    assert.equal(ctls[0].controlType, 'hidden');
    assert.equal(ctls[0].width, 0);
});

// ─── 5.9 bare-identifier strings rejected ──────────────────────────────────

test("5.9 named-object value: bare `tru` raises PARSE_ERROR", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

mode = { active: tru }

[container({t})]

  - [textfield(5,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.PARSE_ERROR);
    assert.ok(result.messages.some(m => /tru/.test(m) && /quote it/.test(m)));
});

test("5.9 named-object value: bare `true`/`false`/`null` are still allowed", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

mode = { a: true, b: false, c: null }

[container({t})]

  - [textfield(5,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    assert.equal(result.payload.namedObjects.mode.a, true);
    assert.equal(result.payload.namedObjects.mode.b, false);
    assert.equal(result.payload.namedObjects.mode.c, null);
});

test("5.9 __properties value: bare `barValue` raises PARSE_ERROR", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

__properties = ["x" = { type: "string", default: barValue }]

[container({t})]

  - [textfield(5,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.PARSE_ERROR);
    assert.ok(result.messages.some(m => /barValue/.test(m)));
});

test("5.9 __properties value: quoted strings are required for non-keyword defaults", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

__properties = ["x" = { type: "string", default: "barValue" }]

[container({t})]

  - [textfield(5,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    assert.equal(result.payload.__properties.x.default, 'barValue');
});

// ─── 5.10 EOF push counts against maxTokens ────────────────────────────────

test("5.10 a when= source that exactly fills the token cap raises PARSE_ERROR", () => {
    // A source like `a == 1` produces 4 tokens (IDENT, ==, NUM, EOF).
    // Setting maxTokens: 4 would have let EOF sneak in past the cap
    // before. After the fix, EOF counts against the cap so the
    // tokenizer raises PARSE_ERROR.
    assert.throws(
        () => parseWhen('a == 1', { maxTokens: 3 }),
        /max token count/
    );
    // A cap that comfortably accommodates EOF still parses.
    const ast = parseWhen('a == 1', { maxTokens: 10 });
    assert.ok(ast);
});

// ─── parseDecorated empty contract (5.3 lock) ──────────────────────────────

test("5.3 parseDecorated('') returns []", () => {
    assert.deepEqual(parseDecorated(''), []);
    assert.deepEqual(parseDecorated(null), []);
});

test("5.3 interpolate('') returns ''", () => {
    assert.equal(interpolate(''), '');
    assert.equal(interpolate(null), '');
});

// ─── renderFragments still throws on missing function (sanity) ─────────────

test("sanity: renderFragments strict still throws on missing function", () => {
    const fragments = parseDecorated('see {@fn}');
    assert.throws(
        () => renderFragments(fragments, {}, {}, { strict: true }),
        /no function registered/
    );
});
