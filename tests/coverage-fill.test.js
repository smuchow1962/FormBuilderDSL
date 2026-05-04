// Coverage-fill tests targeting paths the existing test suite doesn't
// exercise. Each block names the file + concern it's chasing, so a future
// maintainer pruning duplicate coverage knows what to keep.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    TextFormBuilder,
    ERR,
    renderFormPreview,
    parseDecorated,
    renderFragments
} from '../src/index.js';

// ─── render-preview: every widget glyph ────────────────────────────────────
//
// widgetGlyph() in render-preview.js has a per-controlType switch. The
// existing tests exercise a few; this builds a form that touches every
// branch so the switch's coverage isn't dominated by the default arm.

test("render-preview: every documented widget type renders", () => {
    const b = new TextFormBuilder({
        schemaText: `columns: 60

opts = ["a","b","c"]

[container({title})]

  - [textfield(4,{tf})] TF
    | [textarea(4,{ta},rows=3)] TA
    | [password(4,{pw})] PW

  - [number(4,{n},min=1,max=10)] N
    | [float(4,{f},min=0)] F
    | [slider(4,{s},min=0,max=100)] S

  - [check(4,{c1})] C1
    | [toggle(4,{c2})] C2
    | [radio(4,#opts,{r1})] R1

  - [select(4,#opts,{sel})] Sel
    | [combo(4,#opts,{cmb})] Combo
    | [multiselect(4,#opts,{ms})] MS

  - [date(4,{d1})] D
    | [time(4,{t1})] T
    | [datetime(4,{dt})] DT

  - [daterange(4,{dr})] DR
    | [file(4,{file})] File
    | [color(4,{col})] Color

  - [hidden(4,{h})] H
    | [label(8,style=heading)] Heading
`
    });
    const r = b.parse();
    assert.equal(r.error, ERR.OK, r.messages.join('\n'));
    const preview = renderFormPreview(r.payload);
    // Glyph spot checks — proves each switch arm fired at least once.
    assert.ok(preview.includes('▾'),  'select / combo glyph');
    assert.ok(preview.includes('☐'),  'check glyph');
    assert.ok(preview.includes('◉'),  'toggle glyph');
    assert.ok(preview.includes('◯'),  'radio glyph');
    assert.ok(preview.includes('═'),  'slider glyph');
    assert.ok(preview.includes('📁'), 'file glyph');
    assert.ok(preview.includes('◼'),  'color glyph');
    assert.ok(preview.includes('🔒'), 'password glyph');
    assert.ok(preview.includes('○'),  'hidden glyph');
});

// ─── render-preview: opts toggles + display + label ────────────────────────

test("render-preview: showInit / showWhen toggles + display + label-only", () => {
    const b = new TextFormBuilder({
        schemaText: `columns: 12

[container({t})]

  - [textfield(6,{name},init="Alice")] Name
    | [textfield(6,{age},when="name == 'Alice'")] Age

  - [display(6,{@uptime})] Uptime
    | [label(6,style=note)] A note line
`
    });
    const r = b.parse();
    assert.equal(r.error, ERR.OK, r.messages.join('\n'));
    // Default: init + when both shown
    const withBoth = renderFormPreview(r.payload);
    assert.ok(withBoth.includes('Conditional visibility'), 'when listing');
    // Toggle off: no init footer, no when footer
    const noWhen = renderFormPreview(r.payload, { showWhen: false });
    assert.ok(!noWhen.includes('Conditional visibility'));
    const noInit = renderFormPreview(r.payload, { showInit: false });
    assert.ok(noInit.length > 0);
});

test("render-preview: empty / null AST falls through to (empty form)", () => {
    assert.equal(renderFormPreview(null),       '(empty form)');
    assert.equal(renderFormPreview(undefined),  '(empty form)');
    assert.equal(renderFormPreview({}),         '(empty form)');
    assert.equal(renderFormPreview({ root: null }), '(empty form)');
});

// ─── render-preview: padOrTrunc truncation path ───────────────────────────

test("render-preview: long labels trigger truncation without crashing", () => {
    const longLabel = 'X'.repeat(200);
    const b = new TextFormBuilder({
        schemaText: `columns: 12

[container({t})]

  - [textfield(12,{x})] ${longLabel}
`
    });
    const r = b.parse();
    assert.equal(r.error, ERR.OK);
    const preview = renderFormPreview(r.payload, { width: 80 });
    // Each row should be exactly 80 characters wide (border + padding).
    const lines = preview.split('\n').filter(l => l.startsWith('│'));
    for (const ln of lines) assert.equal(ln.length, 80, `line not 80 wide: "${ln}"`);
});

// ─── render-preview: panels + container body ──────────────────────────────

test("render-preview: panels render with their numbers + labels", () => {
    const b = new TextFormBuilder({
        schemaText: `columns: 20

[>container(panels=[1:10,2:10])] [toggle(3,{enabled})] Rolling

  1. First Panel
    - [textfield(10,{a})] A

  2. Second Panel
    - [textfield(10,{b})] B
`
    });
    const r = b.parse();
    assert.equal(r.error, ERR.OK, r.messages.join('\n'));
    const preview = renderFormPreview(r.payload);
    assert.ok(preview.includes('Panel 1'), 'panel 1 header');
    assert.ok(preview.includes('Panel 2'), 'panel 2 header');
});

// ─── Named objects: full feature exercise ─────────────────────────────────

test("Named object: bare keys, primary key, value types", () => {
    const b = new TextFormBuilder({
        schemaText: `columns: 10

palette = { !id, label: "Red", priority: 1, active: true }

[container({title})]

  - [textfield(10,{x})] X
`
    });
    const r = b.parse();
    assert.equal(r.error, ERR.OK, r.messages.join('\n'));
    const obj = r.payload.namedObjects.palette;
    assert.equal(obj.id,       true,    'bare key default');
    assert.equal(obj.label,    'Red',   'string value');
    assert.equal(obj.priority, 1,       'integer value');
    assert.equal(obj.active,   true,    'boolean value');
    assert.equal(obj.__pk,     'id',    '__pk set on primary key');
});

test("Named object: rejects reserved name", () => {
    const b = new TextFormBuilder({
        schemaText: `columns: 10

container = { x: 1 }

[container({t})]

  - [textfield(10,{n})] N
`
    });
    const r = b.parse();
    assert.notEqual(r.error, ERR.OK);
});

test("Named object: rejects duplicate primary keys", () => {
    const b = new TextFormBuilder({
        schemaText: `columns: 10

p = { !a, !b }

[container({t})]

  - [textfield(10,{n})] N
`
    });
    const r = b.parse();
    assert.notEqual(r.error, ERR.OK);
    assert.ok(r.messages.some(m => /multiple primary keys/.test(m)));
});

// ─── __properties: error paths ────────────────────────────────────────────

test("__properties: declares with type + default fields", () => {
    const b = new TextFormBuilder({
        schemaText: `columns: 10

__properties = [
    "name"  = { type: "string", default: "Alice" },
    "age"   = { type: "int" },
    "tags"  = { type: "string[]", default: ["red","blue"] }
]

[container({t})]

  - [textfield(10,{name})] Name
`
    });
    const r = b.parse();
    assert.equal(r.error, ERR.OK, r.messages.join('\n'));
    const props = r.payload.__properties;
    assert.equal(props.name.type,    'string');
    assert.equal(props.name.default, 'Alice');
    assert.equal(props.age.type,     'int');
    assert.equal(props.age.default,  0,       'int zero default');
    assert.deepEqual(props.tags.default, ['red', 'blue']);
});

test("__properties: rejects entry missing 'type' field", () => {
    const b = new TextFormBuilder({
        schemaText: `columns: 10

__properties = [
    "broken" = { default: 0 }
]

[container({t})]

  - [textfield(10,{broken})] Broken
`
    });
    const r = b.parse();
    assert.notEqual(r.error, ERR.OK);
    assert.ok(r.messages.some(m => /must declare a 'type'/.test(m)));
});

test("__properties: rejects duplicate property names", () => {
    const b = new TextFormBuilder({
        schemaText: `columns: 10

__properties = [
    "x" = { type: "int" },
    "x" = { type: "string" }
]

[container({t})]

  - [textfield(10,{x})] X
`
    });
    const r = b.parse();
    assert.notEqual(r.error, ERR.OK);
    assert.ok(r.messages.some(m => /Duplicate property/.test(m)));
});

// ─── Tooltips block: error paths ──────────────────────────────────────────

test("Tooltips: rejects non-string value", () => {
    const b = new TextFormBuilder({
        schemaText: `columns: 10

tooltips = [
    "k" = 123
]

[container({t})]

  - [textfield(10,{n})] N
`
    });
    const r = b.parse();
    assert.notEqual(r.error, ERR.OK);
    assert.ok(r.messages.some(m => /quoted string/.test(m)));
});

test("Tooltips: rejects duplicate keys", () => {
    const b = new TextFormBuilder({
        schemaText: `columns: 10

tooltips = [
    "k" = "first",
    "k" = "second"
]

[container({t})]

  - [textfield(10,{n})] N
`
    });
    const r = b.parse();
    assert.notEqual(r.error, ERR.OK);
    assert.ok(r.messages.some(m => /Duplicate tooltip/.test(m)));
});

// ─── Parser-class: top-level error paths ──────────────────────────────────

test("Parser: indentation at top level is rejected", () => {
    const b = new TextFormBuilder({ schemaText: `   columns: 10\n` });
    const r = b.parse();
    assert.equal(r.error, ERR.PARSE_ERROR);
    assert.ok(r.messages.some(m => /indent/i.test(m)));
});

test("Parser: missing columns declaration is rejected", () => {
    const b = new TextFormBuilder({
        schemaText: `[container({t})]\n  - [textfield(5,{x})] X\n`
    });
    const r = b.parse();
    assert.equal(r.error, ERR.PARSE_ERROR);
    assert.ok(r.messages.some(m => /columns/.test(m)));
});

test("Parser: tab in indent throws LEX_ERROR", () => {
    const b = new TextFormBuilder({
        schemaText: `columns: 10\n\n[container({t})]\n\n\t- [textfield(5,{x})] X\n`
    });
    const r = b.parse();
    assert.equal(r.error, ERR.LEX_ERROR);
    assert.ok(r.messages.some(m => /[Tt]ab/.test(m)));
});

// ─── interpolate: lenient placeholders ────────────────────────────────────

test("interpolate: lenient mode echoes unresolved bindings", () => {
    // Imported for path coverage of interpolate.js's lenient branch.
    const out = renderFragments(parseDecorated('hi {missing} there'), {});
    assert.equal(out, 'hi {missing} there');
});

// ─── TextFormBuilder: setSchemaText + validateSchema ──────────────────────
//
// Both methods are part of the public API but not exercised by the
// existing parse-focused tests. validateSchema returns INVALID_SPEC for a
// malformed registry without ever calling parse().

test("TextFormBuilder: setSchemaText replaces source", () => {
    const b = new TextFormBuilder({ schemaText: 'columns: 5\n[container({t})]\n  - [textfield(5,{x})] X\n' });
    const first = b.parse();
    assert.equal(first.error, ERR.OK);
    assert.equal(first.payload.columns, 5);

    b.setSchemaText('columns: 12\n[container({t})]\n  - [textfield(12,{y})] Y\n');
    const second = b.parse();
    assert.equal(second.error, ERR.OK);
    assert.equal(second.payload.columns, 12);
});

test("TextFormBuilder: validateSchema returns OK on the default spec", () => {
    const b = new TextFormBuilder({ schemaText: 'columns: 10' });
    const r = b.validateSchema();
    assert.equal(r.error, ERR.OK);
    assert.equal(r.payload, null);
});

test("TextFormBuilder: validateSchema returns INVALID_SPEC for malformed custom spec", () => {
    const b = new TextFormBuilder({
        schemaText: 'columns: 10',
        controlSpec: { brokenCtl: { params: 'not-an-object' } }
    });
    const r = b.validateSchema();
    assert.equal(r.error, ERR.INVALID_SPEC);
    assert.ok(r.messages.length > 0);
});

// ─── mixin-controls init param: every literal kind ────────────────────────
//
// init= accepts string / integer / float / date / boolean literals plus
// {binding} and {@fn} forms. The parser branches per token kind; exercise
// each so the param-coercion switch isn't dominated by the default.

test("init=: literal string, integer, float, boolean, binding, function", () => {
    const b = new TextFormBuilder({
        schemaText: `columns: 60

[container({t})]

  - [textfield(10,{a},init="hello")] A
    | [number(10,{b},init=42)] B
    | [float(10,{c},init=1.5)] C

  - [check(10,{d},init=true)] D
    | [textfield(10,{e},init={a})] E
    | [textfield(10,{f},init={@compute})] F
`
    });
    const r = b.parse();
    assert.equal(r.error, ERR.OK, r.messages.join('\n'));
    const rows = r.payload.root.rows;
    const inits = rows.flatMap(row => row.controls.map(c => c.init));
    // Six controls, six init records — confirm the kinds matched expectation.
    assert.equal(inits[0].kind, 'literal');  assert.equal(inits[0].value, 'hello');
    assert.equal(inits[1].kind, 'literal');  assert.equal(inits[1].value, 42);
    assert.equal(inits[2].kind, 'literal');  assert.equal(inits[2].value, 1.5);
    assert.equal(inits[3].kind, 'literal');  assert.equal(inits[3].value, true);
    assert.equal(inits[4].kind, 'binding');  assert.equal(inits[4].path,  'a');
    assert.equal(inits[5].kind, 'function'); assert.equal(inits[5].name,  'compute');
});

test("init=: rejects unsupported token kind", () => {
    const b = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [textfield(10,{x},init=:notvalid)] X
`
    });
    const r = b.parse();
    assert.notEqual(r.error, ERR.OK);
});

// ─── contentRef on display + label resolves named-text content ────────────

test("contentRef: label control's #ref resolves to named text", () => {
    const b = new TextFormBuilder({
        schemaText: `columns: 12

intro = "Static intro paragraph"

[container({t})]

  - [label(12,#intro)] Header label
`
    });
    const r = b.parse();
    assert.equal(r.error, ERR.OK, r.messages.join('\n'));
    const ctl = r.payload.root.rows[0].controls[0];
    // After phase 2, the label is the resolved named-text fragments
    // rather than the raw "Header label" text.
    assert.ok(Array.isArray(ctl.label));
    assert.ok(ctl.label.length > 0);
    assert.equal(ctl.label[0].kind, 'text');
    assert.equal(ctl.label[0].text, 'Static intro paragraph');
});

test("contentRef: display control resolves both binding and #ref", () => {
    // display accepts both a binding (where the value comes from)
    // and a contentRef (the label text). The contentRef goes through
    // the same phase-2 named-text resolution as label controls.
    const b = new TextFormBuilder({
        schemaText: `columns: 12

uptime_label = "Server uptime"

[container({t})]

  - [display(12,{uptime},#uptime_label)] X
`
    });
    const r = b.parse();
    assert.equal(r.error, ERR.OK, r.messages.join('\n'));
    const ctl = r.payload.root.rows[0].controls[0];
    assert.equal(ctl.binding, 'uptime');
    assert.equal(ctl.contentRef, 'uptime_label');
    // contentRef triggers the named-text resolution into the label.
    assert.equal(ctl.label[0].text, 'Server uptime');
});

// ─── explain= parameter: inline string + #ref forms ───────────────────────

test("explain=: inline string parses into TextFragments", () => {
    const b = new TextFormBuilder({
        schemaText: `columns: 12

[container({t})]

  - [textfield(12,{x},explain="The value the server expects.")] X
`
    });
    const r = b.parse();
    assert.equal(r.error, ERR.OK, r.messages.join('\n'));
    const ctl = r.payload.root.rows[0].controls[0];
    assert.ok(Array.isArray(ctl.explain));
    assert.equal(ctl.explain[0].text, 'The value the server expects.');
});

test("explain=: #ref form pulls from named text", () => {
    const b = new TextFormBuilder({
        schemaText: `columns: 12

helpText = "Reference the named text block instead of repeating help inline."

[container({t})]

  - [textfield(12,{x},explain=#helpText)] X
`
    });
    const r = b.parse();
    assert.equal(r.error, ERR.OK, r.messages.join('\n'));
    const ctl = r.payload.root.rows[0].controls[0];
    assert.equal(ctl.explain[0].kind, 'text');
    assert.match(ctl.explain[0].text, /Reference the named text/);
});

// ─── Control param error paths ───────────────────────────────────────────

test("Param coercion: rejects unknown parameter for the control type", () => {
    const b = new TextFormBuilder({
        schemaText: `columns: 12

[container({t})]

  - [textfield(12,{x},notARealParam=5)] X
`
    });
    const r = b.parse();
    assert.equal(r.error, ERR.INVALID_PARAM);
    assert.ok(r.messages.some(m => /Unknown parameter|notARealParam/.test(m)));
});

test("Param coercion: integer-typed param rejects a string value", () => {
    const b = new TextFormBuilder({
        schemaText: `columns: 12

[container({t})]

  - [number(12,{x},min="not-a-number")] X
`
    });
    const r = b.parse();
    assert.equal(r.error, ERR.INVALID_PARAM);
});

test("Param coercion: enum-typed param rejects out-of-set value", () => {
    const b = new TextFormBuilder({
        schemaText: `columns: 12

[container({t})]

  - [label(12,style=notInTheEnum)] L
`
    });
    const r = b.parse();
    assert.notEqual(r.error, ERR.OK);
});

// ─── Trust-model fail-safe: __proto__ lookup returns undefined ────────────
//
// FORBIDDEN_PATH_SEGMENTS pre-emptively blocks prototype-chain
// access. evaluateWhen("foo.__proto__.x == 'y'", data) must return
// false (the resolver returns undefined, which fails the comparison).

import { evaluateWhen, FORBIDDEN_PATH_SEGMENTS } from '../src/expression.js';

test("evaluateWhen: forbidden path segments resolve to undefined", () => {
    for (const seg of FORBIDDEN_PATH_SEGMENTS) {
        const expr = `foo.${seg} == 'attack'`;
        const result = evaluateWhen(expr, { foo: { [seg]: 'attack' } });
        assert.equal(result, false, `expected ${seg} lookup to be blocked`);
    }
});

test("evaluateWhen: rejects expressions over the source-length cap", () => {
    const tooLong = "foo == '" + 'a'.repeat(10000) + "'";
    assert.throws(
        () => evaluateWhen(tooLong, { foo: 'a' }),
        /max length/
    );
});
