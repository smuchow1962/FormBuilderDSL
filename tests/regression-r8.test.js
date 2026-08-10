// Tests covering the eighth principal-review round of fixes. Each
// `test(...)` block names the review item it locks in (3.x, 4.x,
// 5.x).
//
// Coverage map:
//   3.1  repeater / listManager without an array binding -> INVALID_PARAM.
//   4.2  named-object body accepts T.DATE values.
//   4.4  filter defaults to null on every container kind.
//   5.1  LineTokenizer no longer exposes the dead public methods.
//   5.3  container nesting cap raises INVALID_LAYOUT past 64 levels.
//   5.4  parseDecorated rejects {this} and {@this}.
//   5.5  parseDecorated rejects {a..b} and {foo.}.
//   5.7  parseGlobalConfig friendlier error message.
//   5.9  option-source value list accepts dates and null.
//   5.10 typo'd block names get a "did you mean" hint.

import assert from 'node:assert/strict';

import {
    TextFormBuilder,
    ERR,
    parseDecorated
} from '../src/index.js';

// ─── 3.1 bound-less repeater / listManager ─────────────────────────────────

test("3.1 [repeater()] with no array binding raises INVALID_PARAM", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[repeater()]

  - [textfield(5,{name})] N
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_PARAM);
    assert.ok(result.messages.some(m => /repeater.*array binding/.test(m)));
});

test("3.1 [listManager()] with no array binding raises INVALID_PARAM", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[listManager()]

  - [textfield(5,{name})] N
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_PARAM);
});

test("3.1 [repeater({items})] with a binding still works", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[repeater({items})]

  - [textfield(5,{this.name})] N
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    assert.equal(result.payload.root.arrayBinding, 'items');
});

// ─── 4.2 named-object body accepts dates ──────────────────────────────────

test("4.2 named-object body accepts a bare DATE value", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

audit = { name: "audit", asOf: 2026-01-01 }

[container({t})]

  - [textfield(5,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    assert.equal(result.payload.namedObjects.audit.asOf, '2026-01-01');
});

// ─── 4.4 filter defaults to null on every container kind ──────────────────

test("4.4 plain container has filter: null", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [textfield(5,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    assert.equal(result.payload.root.filter, null);
});

test("4.4 listManager without filter= still has filter: null (renderer falls back to 'name')", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[listManager({items})]

  - [textfield(5,{this.name})] N
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    assert.equal(result.payload.root.filter, null);
});

test("4.4 listManager with filter='label' carries the value through", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[listManager({items},filter="label")]

  - [textfield(5,{this.label})] L
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    assert.equal(result.payload.root.filter, 'label');
});

// ─── 5.1 LineTokenizer dead-method removal ────────────────────────────────

test("5.1 LineTokenizer no longer exposes consumeLabelTextUntilNextDecl / contentPosOf / sliceFrom", async () => {
    const { LineTokenizer } = await import('../src/tokenizer.js');
    const tk = new LineTokenizer('[textfield(5,{x})] X', 1);
    assert.equal(typeof tk.consumeLabelTextUntilNextDecl, 'undefined');
    assert.equal(typeof tk.contentPosOf,                  'undefined');
    assert.equal(typeof tk.sliceFrom,                     'undefined');
});

// ─── 5.3 nesting cap ──────────────────────────────────────────────────────

function buildNestedContainers(depth) {
    // The first container is the root (indent 0). Every subsequent
    // container sits inside its parent's row body via `- [container(...)]`.
    // The row marker indents 2 more than the container line above it.
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

test("5.3 container nesting past 64 levels raises INVALID_LAYOUT", () => {
    const result = new TextFormBuilder({ schemaText: buildNestedContainers(70) }).parse();
    assert.equal(result.error, ERR.INVALID_LAYOUT);
    assert.ok(result.messages.some(m => /Container nesting too deep/.test(m)));
});

test("5.3 a modest nesting (8 levels) parses fine", () => {
    const result = new TextFormBuilder({ schemaText: buildNestedContainers(8) }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
});

// ─── 5.4 parseDecorated this rejection ────────────────────────────────────

test("5.4 parseDecorated('{this}') raises PARSE_ERROR", () => {
    assert.throws(() => parseDecorated('Status: {this}'), /reserved/);
});

test("5.4 parseDecorated('{@this}') raises PARSE_ERROR", () => {
    assert.throws(() => parseDecorated('see {@this}'), /reserved/);
});

test("5.4 parseDecorated('{this.field}') still works (dotted, repeater scope)", () => {
    const fragments = parseDecorated('{this.name}');
    assert.equal(fragments[0].kind, 'binding');
    assert.equal(fragments[0].path, 'this.name');
});

// ─── 5.5 parseDecorated PATH_RX tightening ────────────────────────────────

test("5.5 parseDecorated('{a..b}') raises PARSE_ERROR (no adjacent dots)", () => {
    // PATH_RX trips on the `..` and reports "Malformed binding".
    assert.throws(() => parseDecorated('see {a..b}'), /Malformed binding|Expected '\}'/);
});

test("5.5 parseDecorated('{foo.}') raises PARSE_ERROR (no trailing dot)", () => {
    // PATH_RX consumes `foo`; the trailing `.` is not part of the
    // path, the closing `}` check fails.
    assert.throws(() => parseDecorated('see {foo.}'), /Expected '\}'/);
});

test("5.5 parseDecorated('{a.b.c}') still parses (well-formed dotted path)", () => {
    const fragments = parseDecorated('see {a.b.c}');
    assert.equal(fragments[1].kind, 'binding');
    assert.equal(fragments[1].path, 'a.b.c');
});

// ─── 5.7 parseGlobalConfig friendlier error ───────────────────────────────

test("5.7 unknown global config key error mentions 'columns:' explicitly", () => {
    const result = new TextFormBuilder({
        schemaText: 'version: 1'
    }).parse();
    assert.equal(result.error, ERR.PARSE_ERROR);
    assert.ok(result.messages.some(m => /Only 'columns:' is recognised/.test(m)));
});

// ─── 5.9 option-source value list dates + null ────────────────────────────

test("5.9 option-source value list accepts a date literal", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

cutoffs = [2026-01-01, 2026-12-31] -> {dates}

[container({t})]

  - [textfield(5,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    assert.deepEqual(result.payload.optionSources.cutoffs.values, ['2026-01-01', '2026-12-31']);
});

test("5.9 option-source value list accepts null", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

choices = [null, "yes", "no"] -> {choice}

[container({t})]

  - [textfield(5,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    assert.deepEqual(result.payload.optionSources.choices.values, [null, 'yes', 'no']);
});

test("5.9 option-source value list still rejects bare typo identifiers", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

choices = [tru, "yes"] -> {choice}

[container({t})]

  - [textfield(5,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.PARSE_ERROR);
    assert.ok(result.messages.some(m => /tru/.test(m)));
});

// ─── 5.10 typo hint on top-level block ────────────────────────────────────

test("5.10 'tooltps =' raises with a 'did you mean' hint", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

tooltps = "wrong"

[container({t})]

  - [textfield(5,{x})] X
`
    }).parse();
    // The 'tooltps = "wrong"' line dispatches as parseNamedText (the
    // value side is a STRING). To trigger the option-source path,
    // we have to use a value side that would normally be `[` or `{`.
    // So pivot: 'tooltps = []' which goes to parseOptionSource and
    // hits our "did you mean" hint.
    if (result.error === ERR.OK) {
        // First-form succeeded as named text; that's a separate path.
        // The hint test follows.
    }
    // Now the option-source path:
    const result2 = new TextFormBuilder({
        schemaText: `columns: 10

tooltps = somevalue

[container({t})]

  - [textfield(5,{x})] X
`
    }).parse();
    assert.equal(result2.error, ERR.PARSE_ERROR);
    assert.ok(result2.messages.some(m => /did you mean/.test(m) && /tooltips/.test(m)));
});

test("5.10 a non-typo name doesn't get the hint", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

myList = somevalue

[container({t})]

  - [textfield(5,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.PARSE_ERROR);
    assert.ok(!result.messages.some(m => /did you mean/.test(m)));
});

// ─── property-collector helper consolidation (5.2 sanity) ─────────────────

test("5.2 sanity: validateProperties still detects mismatched defaults", async () => {
    const { validateProperties } = await import('../src/index.js');
    const ast = {
        root: {
            nodeKind: 'container',
            headerControls: [],
            rows: [{
                nodeKind: 'row',
                controls: [{
                    nodeKind: 'control',
                    controlType: 'textfield',
                    binding: 'name'
                }]
            }]
        },
        __properties: { name: { type: 'string', default: 'wrong' } }
    };
    const errors = validateProperties(ast);
    assert.ok(errors.some(e => /default/.test(e)));
});
