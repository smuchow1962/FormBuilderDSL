// Tests covering each behaviour change made to resolve audit findings.
// Each `test(...)` block names the audit item it covers so a future
// maintainer can trace why the assertion exists.

import assert from 'node:assert/strict';

import {
    TextFormBuilder,
    ERR,
    ParseError,
    TupleResponse,
    validateControlSpec,
    renderFragments,
    parseDecorated,
    renderFormPreview,
    scaffoldTypeScript,
    inferDataSchema
} from '../src/index.js';

// ─── escapeHtml: includes single-quote ─────────────────────────────────────
//
// `escapeHtml` lives behind `renderFragments({ mode: 'html' })`. We can't
// import it directly (private), so we exercise it via the public surface
// and assert the apostrophe is escaped to &#39;.

test("escapeHtml: apostrophes escape to &#39; in html mode", () => {
    const fragments = parseDecorated("don't");
    const html = renderFragments(fragments, {}, {}, { mode: 'html' });
    assert.match(html, /don&#39;t/);
    assert.doesNotMatch(html, /don't/);
});

test("escapeHtml: every metacharacter escapes", () => {
    const fragments = parseDecorated('a & b < c > d " e \' f');
    const html = renderFragments(fragments, {}, {}, { mode: 'html' });
    assert.match(html, /a &amp; b &lt; c &gt; d &quot; e &#39; f/);
});

// ─── ParseError.name ───────────────────────────────────────────────────────
//
// Subclasses of Error don't get `name` for free; we set it explicitly so
// stack traces and console.error read "ParseError: …" not "Error: …".

test("ParseError: name field is set", () => {
    const e = new ParseError(ERR.PARSE_ERROR, 'boom', 1, 1);
    assert.equal(e.name, 'ParseError');
});

test("ParseError: stack trace includes ParseError prefix", () => {
    const e = new ParseError(ERR.PARSE_ERROR, 'boom', 1, 1);
    assert.match(String(e), /^ParseError: boom/);
});

// ─── registerControl: returns TupleResponse + validates eagerly ────────────
//
// A malformed spec must surface at the call site, not on the next parse().
// The candidate-spread pattern means a rejection leaves controlSpec
// untouched.

test("registerControl: returns TupleResponse.ok on success", () => {
    const b = new TextFormBuilder({ schemaText: 'columns: 10' });
    const result = b.registerControl('myCtl', {
        params: { foo: { type: 'integer', default: 1 } }
    });
    assert.equal(result.error, ERR.OK);
    assert.equal(result.payload, null);
    assert.deepEqual(result.messages, []);
});

test("registerControl: rejects malformed spec, leaves controlSpec untouched", () => {
    const b = new TextFormBuilder({ schemaText: 'columns: 10' });
    const before = b.controlSpec;
    // params must be an object; passing null is a contract violation.
    const result = b.registerControl('badCtl', { params: null });
    assert.equal(result.error, ERR.INVALID_SPEC);
    assert.ok(result.messages.length > 0);
    // The candidate pattern: live spec is not poisoned.
    assert.equal(b.controlSpec.badCtl, undefined);
    // First registration on a default spec swaps in a fresh copy; that's
    // fine. What must NOT happen is the failed entry landing.
    assert.ok(b.controlSpec === before || !('badCtl' in b.controlSpec));
});

test("registerControl: rejects reserved type name", () => {
    const b = new TextFormBuilder({ schemaText: 'columns: 10' });
    const result = b.registerControl('container', { params: {} });
    assert.equal(result.error, ERR.INVALID_SPEC);
    assert.ok(result.messages.some(m => /[Rr]eserved/.test(m)));
});

test("registerControl: copies a caller-supplied frozen spec safely", () => {
    // A consumer that froze their own controlSpec for hygiene
    // shouldn't trip a strict-mode write failure when they later
    // call registerControl. The defensive copy must fire whenever
    // the spec is frozen, not just when it identity-matches
    // defaultControlSpec.
    const customSpec = Object.freeze({
        __common: { params: {} },
        myControl: { params: {} }
    });
    const b = new TextFormBuilder({
        schemaText: 'columns: 10',
        controlSpec: customSpec
    });
    const result = b.registerControl('newCtl', { params: {} });
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    assert.ok(b.controlSpec.newCtl?.params != null);
    // The caller's frozen spec is untouched.
    assert.equal('newCtl' in customSpec, false);
    assert.ok(Object.isFrozen(customSpec));
});

// ─── validateControlSpec: width field shape ────────────────────────────────
//
// `width` is either the string 'required' or { default: <number> }. Any
// other shape is malformed; the validator must catch it before the parser
// trips over it at runtime.

test("validateControlSpec: accepts width: 'required'", () => {
    const errors = validateControlSpec({
        myCtl: { width: 'required', params: {} }
    });
    assert.deepEqual(errors, []);
});

test("validateControlSpec: accepts width: { default: 0 }", () => {
    const errors = validateControlSpec({
        myCtl: { width: { default: 0 }, params: {} }
    });
    assert.deepEqual(errors, []);
});

test("validateControlSpec: rejects width: { default: 'not-a-number' }", () => {
    const errors = validateControlSpec({
        myCtl: { width: { default: 'huge' }, params: {} }
    });
    assert.ok(errors.some(e => /width/.test(e)));
});

test("validateControlSpec: rejects width: 'optional' (unknown string)", () => {
    const errors = validateControlSpec({
        myCtl: { width: 'optional', params: {} }
    });
    assert.ok(errors.some(e => /width/.test(e)));
});

test("validateControlSpec: rejects width: 7 (bare number)", () => {
    const errors = validateControlSpec({
        myCtl: { width: 7, params: {} }
    });
    assert.ok(errors.some(e => /width/.test(e)));
});

// ─── renderFragments: strict mode mirrors interpolate ──────────────────────
//
// Default behaviour is lenient: missing bindings render as `{path}`,
// missing functions as `{@name}`, throwing functions render as `{@name}`.
// strict=true makes each of these throw, mirroring interpolate.js.

test("renderFragments: strict mode throws on unresolved binding", () => {
    const fragments = parseDecorated('Hello {missing}');
    assert.throws(
        () => renderFragments(fragments, {}, {}, { strict: true }),
        /missing data for \{missing\}/
    );
});

test("renderFragments: strict mode throws on missing function", () => {
    const fragments = parseDecorated('Hello {@nope}');
    assert.throws(
        () => renderFragments(fragments, {}, {}, { strict: true }),
        /no function registered for \{@nope\}/
    );
});

test("renderFragments: strict mode rethrows function errors", () => {
    const fragments = parseDecorated('Hello {@bad}');
    assert.throws(
        () => renderFragments(
            fragments,
            {},
            { bad: () => { throw new Error('boom'); } },
            { strict: true }
        ),
        /boom/
    );
});

test("renderFragments: lenient mode (default) returns placeholders", () => {
    const fragments = parseDecorated('Hello {missing} {@nope}');
    const out = renderFragments(fragments);
    assert.equal(out, 'Hello {missing} {@nope}');
});

// ─── render-preview: handles listManager nodeKind ──────────────────────────
//
// listManager renders as a sub-container header rather than as an inline
// row item. Adding a new container-shaped nodeKind needs an entry in
// SUB_CONTAINER_KINDS or render-preview will try to format it as a control
// cell and produce garbage.

test("render-preview: listManager renders without crashing", () => {
    const b = new TextFormBuilder({
        schemaText: `columns: 12

allowed = ["one","two"]

[container({title})]

  - [>listManager({items},addLabel="Add",excluded=#allowed)] Items
    - [textfield(8,{this.name})] Name
`
    });
    const result = b.parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    const preview = renderFormPreview(result.payload);
    // Just confirms the renderer survived; the actual ASCII shape isn't
    // pinned down here (golden-parse covers shape) — the assertion is that
    // a listManager AST does not throw and produces some output.
    assert.ok(preview.length > 0);
    assert.ok(!preview.includes('undefined'));
});

// ─── scaffoldTypeScript: ifaceName parameter feeds Functions interface too ─
//
// The function-block emit (line ~253 of infer-schema.js) uses ifaceName to
// declare `(data: ${ifaceName})` parameter types. Renaming the source
// parameter from `interfaceName` to `ifaceName` regressed once when one
// reference was missed — this pins the contract.

test("scaffoldTypeScript: ifaceName flows into Functions interface", () => {
    const b = new TextFormBuilder({
        schemaText: `columns: 12

[container({title})]

  - [display(12,{@uptime})] Server uptime
`
    });
    const result = b.parse();
    assert.equal(result.error, ERR.OK);
    const inferred = inferDataSchema(result.payload);
    const ts = scaffoldTypeScript(inferred, 'MyForm');
    assert.match(ts, /export interface MyForm \{/);
    // The functions interface uses `(data: MyForm)` — verify the rename
    // didn't leave a stale `interfaceName` reference somewhere.
    assert.match(ts, /export interface MyFormFunctions \{/);
    assert.match(ts, /uptime: \(data: MyForm\) =>/);
});

test("scaffoldTypeScript: defaults ifaceName to 'FormData'", () => {
    const b = new TextFormBuilder({
        schemaText: `columns: 10

[container({title})]

  - [textfield(10,{name})] Name
`
    });
    const result = b.parse();
    assert.equal(result.error, ERR.OK);
    const inferred = inferDataSchema(result.payload);
    const ts = scaffoldTypeScript(inferred);
    assert.match(ts, /export interface FormData \{/);
});

// ─── OptionSource: bindings array (and binding shim) ───────────────────────
//
// Each `-> {b}` adds one binding to the static source. The legacy
// `binding` field points at the first entry for older readers.

test("OptionSource: single -> {binding} populates bindings + binding shim", () => {
    const b = new TextFormBuilder({
        schemaText: `columns: 10

sizes = ["S","M","L"] -> {sizeA}

[container({title})]

  - [select(5,#sizes,{sizeA})] Size
`
    });
    const result = b.parse();
    assert.equal(result.error, ERR.OK);
    const src = result.payload.optionSources.sizes;
    assert.deepEqual(src.bindings, ['sizeA']);
    assert.equal(src.binding, 'sizeA');
});

// ─── TupleResponse.fail: preserves Error context ──────────────────────────
//
// Passing an Error instance into TupleResponse.fail used to lose the
// stack via String(messages). The normalizer now formats Errors as
// "Name: message" + the stack so a thrown exception that leaks into
// fail() still leaves a useful trail.

test("TupleResponse.fail: preserves Error name + message + stack", () => {
    const err = new Error('something went wrong');
    const result = TupleResponse.fail(ERR.PARSE_ERROR, err);
    assert.equal(result.error, ERR.PARSE_ERROR);
    assert.equal(result.payload, null);
    assert.ok(result.messages.length >= 1);
    assert.match(result.messages[0], /Error: something went wrong/);
    // When a stack is present it's the second message line.
    if (err.stack) {
        assert.equal(result.messages.length, 2);
        assert.match(result.messages[1], /at /);
    }
});

test("TupleResponse.fail: preserves ParseError name in formatted output", () => {
    const err = new ParseError(ERR.PARSE_ERROR, 'boom', 5, 12);
    const result = TupleResponse.fail(ERR.PARSE_ERROR, err);
    assert.match(result.messages[0], /^ParseError: boom/);
});

test("TupleResponse.fail: still wraps a plain string in an array", () => {
    const result = TupleResponse.fail(ERR.UNKNOWN_TYPE, 'just a string');
    assert.deepEqual(result.messages, ['just a string']);
});

test("TupleResponse.fail: still passes an array through as-is", () => {
    const result = TupleResponse.fail(ERR.INVALID_PARAM, ['line 1', 'line 2']);
    assert.deepEqual(result.messages, ['line 1', 'line 2']);
});

// ─── ControlNode.width is always integer in the AST ───────────────────────
//
// Architecture doc §4 declares ControlNode.width as `integer`. With
// validateControlSpec now checking width-shape, every legitimate
// control spec produces an integer width in the emitted AST. This
// test pins that contract.

test("ControlNode.width is integer for every emitted control", () => {
    const b = new TextFormBuilder({
        schemaText: `columns: 20

[container({t})]

  - [textfield(8,{a})] A
    | [hidden(0,{b})] B
    | [number(8,{c},min=1)] C

  - [hidden(4,{d})] D
`
    });
    const r = b.parse();
    assert.equal(r.error, ERR.OK, r.messages.join('\n'));
    const allControls = r.payload.root.rows.flatMap(row => row.controls);
    for (const c of allControls) {
        assert.equal(typeof c.width, 'number', `control ${c.controlType} has non-numeric width`);
        assert.ok(Number.isInteger(c.width), `control ${c.controlType} width is not an integer`);
    }
});

test("ContainerNode: title + description are TextFragment[], not binding strings", () => {
    // The architecture doc commits to title/description being
    // TextFragment[] populated in phase 2. Confirm the AST matches
    // that contract for a literal title and a {binding} title.
    const literalTitle = new TextFormBuilder({
        schemaText: `columns: 10

[container("Setup", "Step 1 of 3")]

  - [textfield(10,{x})] X
`
    });
    const r1 = literalTitle.parse();
    assert.equal(r1.error, ERR.OK, r1.messages.join('\n'));
    assert.ok(Array.isArray(r1.payload.root.title));
    assert.equal(r1.payload.root.title[0].kind, 'text');
    assert.equal(r1.payload.root.title[0].text, 'Setup');
    assert.equal(r1.payload.root.description[0].text, 'Step 1 of 3');

    const bindingTitle = new TextFormBuilder({
        schemaText: `columns: 10

[container({pageTitle})]

  - [textfield(10,{x})] X
`
    });
    const r2 = bindingTitle.parse();
    assert.equal(r2.error, ERR.OK, r2.messages.join('\n'));
    assert.equal(r2.payload.root.title[0].kind, 'binding');
    assert.equal(r2.payload.root.title[0].path, 'pageTitle');
});

test("ControlNode.width: hidden control fills from { default: 0 } when omitted", () => {
    const b = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [hidden({h})] H
`
    });
    const r = b.parse();
    assert.equal(r.error, ERR.OK, r.messages.join('\n'));
    const ctl = r.payload.root.rows[0].controls[0];
    assert.equal(ctl.width, 0);
});

// ─── renderFragments: underline + strikethrough combine in CSS ────────────
//
// CSS only allows one `text-decoration` value per declaration. The
// HTML emitter combines the two into a single space-separated value
// when both apply, instead of emitting two declarations that would
// override each other.

test("renderFragments(html): underline alone emits text-decoration:underline", () => {
    const fragments = parseDecorated('`u`underlined``');
    const html = renderFragments(fragments, {}, {}, { mode: 'html' });
    assert.match(html, /text-decoration:underline/);
    assert.doesNotMatch(html, /line-through/);
});

test("renderFragments(html): strikethrough alone emits text-decoration:line-through", () => {
    const fragments = parseDecorated('`s`struck``');
    const html = renderFragments(fragments, {}, {}, { mode: 'html' });
    assert.match(html, /text-decoration:line-through/);
    assert.doesNotMatch(html, /underline/);
});

test("renderFragments(html): underline + strikethrough combine into one declaration", () => {
    const fragments = parseDecorated('`us`both``');
    const html = renderFragments(fragments, {}, {}, { mode: 'html' });
    // Both decorations land in a single text-decoration value, joined
    // by a space so neither gets clobbered by the other.
    assert.match(html, /text-decoration:underline line-through/);
});

// ─── Tokenizer: LSQUARE re-classification fires in every context ──────────
//
// The post-process step turns a `[` into LSQUARE (array literal)
// when the previous meaningful token is one of: EQUALS, COMMA,
// LPAREN, COLON, or `IDENT && value === 'in'`. One test per context.

test("LSQUARE re-class: EQUALS context (option source RHS)", () => {
    const b = new TextFormBuilder({
        schemaText: `columns: 5

xs = ["a","b"] -> {x}

[container({t})]

  - [select(5,#xs,{x})] X
`
    });
    const r = b.parse();
    assert.equal(r.error, ERR.OK, r.messages.join('\n'));
    assert.deepEqual(r.payload.optionSources.xs.values, ['a', 'b']);
});

test("LSQUARE re-class: COMMA context (panels list)", () => {
    const b = new TextFormBuilder({
        schemaText: `columns: 20

[>container(panels=[1:10,2:10])] G

  1. P1
    - [textfield(10,{a})] A

  2. P2
    - [textfield(10,{b})] B
`
    });
    const r = b.parse();
    assert.equal(r.error, ERR.OK, r.messages.join('\n'));
    assert.equal(r.payload.root.panels.length, 2);
});

test("LSQUARE re-class: COLON context (__properties array default)", () => {
    const b = new TextFormBuilder({
        schemaText: `columns: 5

__properties = [
    "tags" = { type: "string[]", default: ["red","blue"] }
]

[container({t})]

  - [textfield(5,{tags})] T
`
    });
    const r = b.parse();
    assert.equal(r.error, ERR.OK, r.messages.join('\n'));
    assert.deepEqual(r.payload.__properties.tags.default, ['red', 'blue']);
});

test("LSQUARE re-class: 'in' context inside when= expression", () => {
    // The `when=` value is captured as a quoted string by the parser,
    // then handed to parseWhen() at validation time. Confirms the
    // expression evaluator's own tokenizer handles `in [...]`.
    const b = new TextFormBuilder({
        schemaText: `columns: 5

[container({t})]

  - [textfield(5,{x},when="role in ['admin','owner']")] X
`
    });
    const r = b.parse();
    assert.equal(r.error, ERR.OK, r.messages.join('\n'));
    assert.equal(r.payload.root.rows[0].controls[0].when,
        "role in ['admin','owner']");
});

test("OptionSource: chained -> {a} -> {b} fills both", () => {
    const b = new TextFormBuilder({
        schemaText: `columns: 10

sizes = ["S","M","L"] -> {sizeA} -> {sizeB}

[container({title})]

  - [select(5,#sizes,{sizeA})] Size
`
    });
    const result = b.parse();
    assert.equal(result.error, ERR.OK);
    const src = result.payload.optionSources.sizes;
    assert.deepEqual(src.bindings, ['sizeA', 'sizeB']);
    assert.equal(src.binding, 'sizeA'); // shim points at first
});
