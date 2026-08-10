// Tests covering the second principal-review round of fixes. Each
// `test(...)` block names the review item it locks in (2.1, 3.1,
// etc.) so a future maintainer can trace why the assertion exists.
//
// Coverage map (review section -> behaviour locked):
//   2.1  process() preserves an explicit __properties block.
//   3.1  parseControlParams throws on duplicate width / binding / #ref.
//   3.2  Width and panel widths floor at 0; repeater min/max floor at 0.
//   3.4  combo data type is single-pick string (matches select / radio).
//   5.1  validateControlSpec is cached per-spec (WeakMap).
//   5.2  interpolate lenient: both undefined and null render the placeholder
//        (matches renderFragments; consumers who want the empty case set "" not null).
//   5.3  parseObjectValue accepts bare `null` as JS null.
//   5.4  parseControlParams accepts a trailing comma.
//   5.5  parsePropertiesBlock rejects unknown entry fields.
//   5.6  parsePanelSpec rejects duplicate panel numbers.
//   5.7  parseDecorated honours mid-stream `r` reset.
//   Q7   1 MB default input cap; `maxInputLength` option overrides it.

import assert from 'node:assert/strict';

import {
    TextFormBuilder,
    ERR,
    interpolate,
    validateControlSpec,
    DEFAULT_MAX_INPUT_LENGTH,
    DEFAULT_DATA_TYPE_BY_CONTROL,
    parseDecorated,
    renderFragments
} from '../src/index.js';

// ─── 2.1 process() preserves explicit __properties ──────────────────────────

test("2.1 process() merges explicit __properties with form discoveries", () => {
    const src = `columns: 12

__properties = [
    "port" = { type: "string", default: "wrong" },
    "userName" = { type: "string", default: "" }
]

[container({t},{d})]

  - [number(5,{port},init=22)] Port
  - [textfield(6,{userName})] User Name
`;
    const result = new TextFormBuilder({ schemaText: src }).process();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    // Merge model: discovery type wins (string -> int), init= wins
    // for default (wrong -> 22). userName matches discovery, no init,
    // so its declared default of '' stays.
    const props = result.payload.__properties;
    assert.equal(Object.keys(props).length, 2);
    assert.deepEqual(props.port,     { type: 'int',    default: 22 });
    assert.deepEqual(props.userName, { type: 'string', default: '' });
    // Change list captures both overwrites.
    assert.equal(result.payload.__propertyChanges.length, 2);
});

test("2.1 process() with NO __properties block fills it from collectProperties", () => {
    const src = `columns: 12

[container({t},{d})]

  - [number(5,{port},init=22)] Port
  - [textfield(6,{userName})] User Name
`;
    const result = new TextFormBuilder({ schemaText: src }).process();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    // collectProperties returns a null-prototype object on purpose so
    // a hand-built AST carrying a `__proto__` binding can't pollute
    // the dictionary's prototype slot. assert.deepEqual is strict
    // about prototypes, so compare entries one by one instead.
    const props = result.payload.__properties;
    assert.equal(Object.keys(props).length, 2);
    assert.deepEqual(props.port,     { type: 'int',    default: 22 });
    assert.deepEqual(props.userName, { type: 'string', default: '' });
});

// ─── 3.1 + Q3 duplicate-marker rejections ───────────────────────────────────

test("3.1 duplicate {binding} raises INVALID_PARAM", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [textfield(5,{a},{b})] X
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_PARAM);
    assert.ok(result.messages.some(m => /Duplicate binding/.test(m)));
});

test("3.1 duplicate width raises INVALID_PARAM", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [textfield(5,10,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_PARAM);
    assert.ok(result.messages.some(m => /Duplicate width/.test(m)));
});

test("3.1 duplicate #ref raises INVALID_PARAM", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

a = ["x", "y"]
b = ["m", "n"]

[container({t})]

  - [select(5,#a,#b,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_PARAM);
    assert.ok(result.messages.some(m => /Duplicate.*#b.*reference/.test(m)));
});

// ─── 3.2 + Q4 negative width and integer floor ──────────────────────────────

test("3.2 negative width raises INVALID_PARAM", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [number(-5,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_PARAM);
    assert.ok(result.messages.some(m => /Width must be 0 or greater/.test(m)));
});

test("3.2 width: 0 is allowed (hidden control uses default 0)", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [textfield(0,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
});

test("3.2 negative panel width raises INVALID_PARAM", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container(panels=[1:-3,2:5])]

  1. Left
    - [textfield(3,{a})] A

  2. Right
    - [textfield(5,{b})] B
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_PARAM);
    assert.ok(result.messages.some(m => /Panel 1 width must be 0 or greater/.test(m)));
});

test("3.2 negative repeater min raises INVALID_PARAM", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[repeater({items},min=-1)]

  - [textfield(5,{this.name})] Name
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_PARAM);
    assert.ok(result.messages.some(m => /repeater min must be 0 or greater/.test(m)));
});

test("3.2 negative repeater max raises INVALID_PARAM", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[repeater({items},max=-5)]

  - [textfield(5,{this.name})] Name
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_PARAM);
    assert.ok(result.messages.some(m => /repeater max must be 0 or greater/.test(m)));
});

// ─── 3.4 + Q2 combo is single-pick string ───────────────────────────────────

test("3.4 combo default data type is 'string', not 'string[]'", () => {
    assert.equal(DEFAULT_DATA_TYPE_BY_CONTROL.combo, 'string');
});

test("3.4 collectProperties on a combo emits string default", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

choices = ["a","b","c"]

[container({t})]

  - [combo(5,#choices,{pick})] Pick
`
    }).process();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    assert.deepEqual(result.payload.__properties.pick, { type: 'string', default: '' });
});

// ─── 5.1 validateControlSpec is a pure function (no cache, no freeze) ──────

test("5.1 validateControlSpec returns equal results on repeated calls", () => {
    const spec = {
        __common: { params: {} },
        textfield: { params: {} }
    };
    const first  = validateControlSpec(spec);
    const second = validateControlSpec(spec);
    assert.deepEqual(first, second);
});

test("5.1 validateControlSpec does NOT freeze the spec it inspects", () => {
    // Earlier rounds cached + deep-froze. That created surprising
    // strict-mode TypeErrors when consumers reused a spec across
    // builders and then mutated. The cache is gone; a consumer's
    // spec object stays mutable unless the consumer froze it.
    const spec = {
        __common: { params: {} },
        textfield: { params: {} }
    };
    validateControlSpec(spec);
    assert.equal(Object.isFrozen(spec), false);
});

test("5.1b registerControl on a frozen default spec still forks before writing", () => {
    // The default spec is module-level frozen. registerControl
    // detects a frozen live spec and spreads to a fresh copy
    // before assigning the new control. This still works without
    // the validation-time freeze.
    const b = new TextFormBuilder({ schemaText: 'columns: 10' });
    const firstParse = b.parse();
    assert.equal(firstParse.error, ERR.OK, firstParse.messages.join('\n'));

    const reg = b.registerControl('myCustom', {
        params: { foo: { type: 'integer', default: 1 } }
    });
    assert.equal(reg.error, ERR.OK, reg.messages.join('\n'));

    const second = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [myCustom(5,{x},foo=42)] X
`,
        controlSpec: b.controlSpec
    }).parse();
    assert.equal(second.error, ERR.OK, second.messages.join('\n'));
});

// ─── 5.2 interpolate lenient: undefined and null both render the placeholder ──

test("5.2 lenient: undefined field renders the placeholder", () => {
    assert.equal(interpolate('Hi {name}', {}), 'Hi {name}');
});

test("5.2 lenient: explicit null also renders the placeholder", () => {
    // Symmetric with renderFragments. A consumer who wants the empty
    // case to render visibly passes an empty string, not null.
    assert.equal(interpolate('Hi {name}', { name: null }), 'Hi {name}');
});

test("5.2 lenient: explicit empty string renders as empty", () => {
    assert.equal(interpolate('Hi {name}', { name: '' }), 'Hi ');
});

test("5.2 strict: null throws (same path as undefined)", () => {
    assert.throws(
        () => interpolate('Hi {name}', { name: null }, {}, { strict: true }),
        /missing data/
    );
});

// ─── 5.3 named-object bare null literal ─────────────────────────────────────

test("5.3 parseObjectValue: bare `null` becomes JS null", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

mode = { weight: null, name: "x" }

[container({t})]

  - [textfield(5,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    assert.equal(result.payload.namedObjects.mode.weight, null);
    assert.equal(result.payload.namedObjects.mode.name, 'x');
});

// ─── 5.4 trailing comma in control params ───────────────────────────────────

test("5.4 trailing comma after the last control param parses fine", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [number(5,{x},min=0,max=10,)] X
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    const ctl = result.payload.root.rows[0].controls[0];
    assert.equal(ctl.params.min, 0);
    assert.equal(ctl.params.max, 10);
});

// ─── 5.5 __properties unknown-field rejection ───────────────────────────────

test("5.5 __properties entry with an unknown field raises PARSE_ERROR", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

__properties = [
    "port" = { type: "int", defalt: 0 }
]

[container({t})]

  - [number(5,{port})] Port
`
    }).parse();
    assert.equal(result.error, ERR.PARSE_ERROR);
    assert.ok(result.messages.some(m => /defalt/.test(m)));
});

test("5.5 __properties entry with both type and default succeeds", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

__properties = [
    "port" = { type: "int", default: 8080 }
]

[container({t})]

  - [number(5,{port})] Port
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    // Entry is a null-prototype object (matches the rest of the
    // parser-produced model maps), so compare field by field rather
    // than against an Object.prototype literal.
    const entry = result.payload.__properties.port;
    assert.equal(entry.type,    'int');
    assert.equal(entry.default, 8080);
});

// ─── 5.6 duplicate panel numbers ────────────────────────────────────────────

test("5.6 panels=[1:8, 1:12] raises PARSE_ERROR on the duplicate number", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 20

[container(panels=[1:8, 1:12])]

  1. Left
    - [textfield(8,{a})] A
`
    }).parse();
    assert.equal(result.error, ERR.PARSE_ERROR);
    assert.ok(result.messages.some(m => /Duplicate panel number 1/.test(m)));
});

// ─── 5.7 mid-stream `r` resets the running style ────────────────────────────

test("5.7 mid-stream `r` resets running style (b r i = italic only)", () => {
    const fragments = parseDecorated('`b r i`text');
    assert.deepEqual(fragments[0].style, { italic: true });
});

test("5.7 lone `r` reset still works as documented", () => {
    const fragments = parseDecorated('`b`bold`r`plain');
    assert.equal(fragments[0].style?.bold, true);
    assert.equal(fragments[1].text, 'plain');
    assert.equal(fragments[1].style, undefined);
});

// ─── Q7 input-length cap ────────────────────────────────────────────────────

test("Q7 DEFAULT_MAX_INPUT_LENGTH is 1 MB", () => {
    assert.equal(DEFAULT_MAX_INPUT_LENGTH, 1024 * 1024);
});

test("Q7 input over the default cap raises LEX_ERROR", () => {
    // Build a string just over the 1 MB default. Use a pattern that
    // would otherwise parse cleanly so the cap is the only thing
    // rejecting it.
    const oneLine = '# fill\n';
    const padding = oneLine.repeat(Math.ceil(DEFAULT_MAX_INPUT_LENGTH / oneLine.length) + 10);
    const text = padding + 'columns: 10\n';
    assert.ok(text.length > DEFAULT_MAX_INPUT_LENGTH, 'padding exceeds the cap');
    const result = new TextFormBuilder({ schemaText: text }).parse();
    assert.equal(result.error, ERR.LEX_ERROR);
    assert.ok(result.messages.some(m => /exceeds max length/.test(m)));
});

test("Q7 maxInputLength override accepts a smaller cap", () => {
    const text = `columns: 10

[container({t})]

  - [textfield(5,{x})] X
`;
    const tightResult = new TextFormBuilder({
        schemaText: text,
        maxInputLength: 16
    }).parse();
    assert.equal(tightResult.error, ERR.LEX_ERROR);

    const looseResult = new TextFormBuilder({
        schemaText: text,
        maxInputLength: 10_000
    }).parse();
    assert.equal(looseResult.error, ERR.OK, looseResult.messages.join('\n'));
});

// ─── Misc: confirms HTML escape symmetry from the comment ──────────────────

test("html mode escapes lenient placeholder text the same as any other content", () => {
    const fragments = parseDecorated('see {missing}');
    const html = renderFragments(fragments, {}, {}, { mode: 'html' });
    assert.match(html, /see \{missing\}/);
});
