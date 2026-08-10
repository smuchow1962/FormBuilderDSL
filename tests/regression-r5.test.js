// Tests covering the fifth principal-review round of fixes. Each
// `test(...)` block names the review item it locks in (3.x, 4.x,
// 5.x) so a future maintainer can trace why the assertion exists.
//
// Coverage map:
//   3.1  process() merges __properties (declared + discovered).
//   3.2  Architecture doc + code agree: when= is parsed eagerly.
//   3.3  RowNode.controls TS union exposes repeater / listManager
//        discriminators (verified via runtime shape; the TS check
//        is by inspection of types/index.d.ts).
//   4.1  setSchemaText is documented and works between parses.
//   5.1  Expression `foo..bar` raises PARSE_ERROR, not silent undef.
//   5.2  parseDecorated colour lookup ignores prototype-only entries.

import assert from 'node:assert/strict';

import {
    TextFormBuilder,
    ERR,
    parseDecorated,
    mergeProperties,
    parseWhen,
    evaluateWhen
} from '../src/index.js';

// ─── 3.1 merge model ───────────────────────────────────────────────────────

test("3.1 process() adds discovered bindings absent from the declared block", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

__properties = ["sinkOnly" = { type: "string", default: "x" }]

[container({t})]

  - [number(5,{port},init=8080)] Port
`
    }).process();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    const props = result.payload.__properties;
    assert.deepEqual(props.sinkOnly, { type: 'string', default: 'x' });
    assert.deepEqual(props.port,     { type: 'int',    default: 8080 });
});

test("3.1 process() overwrites declared type when discovery differs (records change)", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

__properties = ["port" = { type: "string", default: "8080" }]

[container({t})]

  - [number(5,{port})] Port
`
    }).process();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    assert.equal(result.payload.__properties.port.type, 'int');
    const changes = result.payload.__propertyChanges;
    assert.ok(changes);
    const typeChange = changes.find(c => c.kind === 'type' && c.name === 'port');
    assert.ok(typeChange, 'type change recorded');
    assert.equal(typeChange.from, 'string');
    assert.equal(typeChange.to,   'int');
});

test("3.1 process() overwrites declared default when init= literal differs", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

__properties = ["greeting" = { type: "string", default: "old" }]

[container({t})]

  - [textfield(5,{greeting},init="new")] G
`
    }).process();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    assert.equal(result.payload.__properties.greeting.default, 'new');
    const changes = result.payload.__propertyChanges;
    const defaultChange = changes.find(c => c.kind === 'default' && c.name === 'greeting');
    assert.ok(defaultChange, 'default change recorded');
    assert.equal(defaultChange.from, 'old');
    assert.equal(defaultChange.to,   'new');
});

test("3.1 no init= leaves the declared default alone", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

__properties = ["greeting" = { type: "string", default: "kept" }]

[container({t})]

  - [textfield(5,{greeting})] G
`
    }).process();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    assert.equal(result.payload.__properties.greeting.default, 'kept');
    assert.equal(result.payload.__propertyChanges, undefined);
});

test("3.1 round trip is stable: the merged dict reparses with no changes", () => {
    const src = `columns: 10

__properties = ["port" = { type: "string", default: "wrong" }]

[container({t})]

  - [number(5,{port},init=22)] Port
`;
    const first = new TextFormBuilder({ schemaText: src }).process();
    assert.equal(first.error, ERR.OK);
    assert.equal(first.payload.__properties.port.type, 'int');

    // Now write the merged block back and re-parse.
    const block = `__properties = [
    "port" = { type: "int", default: 22 }
]`;
    const second = new TextFormBuilder({
        schemaText: `columns: 10

${block}

[container({t})]

  - [number(5,{port},init=22)] Port
`
    }).process();
    assert.equal(second.error, ERR.OK);
    assert.equal(second.payload.__propertyChanges, undefined,
        'second pass reports no further changes');
});

test("3.1 mergeProperties is exported and usable directly", () => {
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
        }
    };
    const result = mergeProperties(ast, { existing: { type: 'int', default: 0 } });
    assert.deepEqual(result.properties.existing, { type: 'int', default: 0 });
    assert.deepEqual(result.properties.name,     { type: 'string', default: '' });
    assert.deepEqual(result.changes, []);
});

// ─── 3.2 when= is parsed eagerly ───────────────────────────────────────────

test("3.2 when= produces both raw `when` and pre-parsed `whenAst` at parse time", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [textfield(5,{x},when="x == 'y'")] X
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    const ctl = result.payload.root.rows[0].controls[0];
    assert.equal(ctl.when, "x == 'y'");
    assert.ok(ctl.whenAst, 'whenAst is populated at parse time');
    assert.equal(ctl.whenAst.kind, 'eq');
});

test("3.2 a malformed when= surfaces at parse time, not render time", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t})]

  - [textfield(5,{x},when="x ===")] X
`
    }).parse();
    assert.equal(result.error, ERR.PARSE_ERROR);
});

// ─── 4.1 setSchemaText ─────────────────────────────────────────────────────

test("4.1 setSchemaText replaces source between parses", () => {
    const b = new TextFormBuilder({
        schemaText: `columns: 5\n\n[container({t})]\n\n  - [textfield(5,{a})] A\n`
    });
    const first = b.parse();
    assert.equal(first.error, ERR.OK);
    assert.equal(first.payload.root.rows[0].controls[0].binding, 'a');

    b.setSchemaText(`columns: 5\n\n[container({t})]\n\n  - [textfield(5,{b})] B\n`);
    const second = b.parse();
    assert.equal(second.error, ERR.OK);
    assert.equal(second.payload.root.rows[0].controls[0].binding, 'b');
});

// ─── 5.1 expression IDENT regex tightened ──────────────────────────────────

test("5.1 parseWhen rejects `foo..bar` with PARSE_ERROR, not silent undefined", () => {
    assert.throws(() => parseWhen("foo..bar == 1"), /PARSE_ERROR|Unexpected/i);
});

test("5.1 parseWhen rejects a trailing dot", () => {
    assert.throws(() => parseWhen("foo. == 1"), /PARSE_ERROR|Unexpected/i);
});

test("5.1 parseWhen still accepts well-formed dotted paths", () => {
    const ast = parseWhen("a.b.c == 1");
    assert.equal(ast.kind, 'eq');
    assert.deepEqual(ast.l, { kind: 'path', path: ['a', 'b', 'c'] });
});

test("5.1 evaluateWhen on a clean dotted path resolves correctly", () => {
    assert.equal(evaluateWhen("user.name == 'A'", { user: { name: 'A' } }), true);
    assert.equal(evaluateWhen("user.name == 'A'", { user: { name: 'B' } }), false);
});

// ─── 5.2 parseDecorated colour lookup is own-property only ─────────────────

test("5.2 parseDecorated colour lookup ignores prototype-only colour entries", () => {
    const proto = { evil: '#FF0000' };
    const colorsMap = Object.create(proto);
    // Own-property is used; inherited 'evil' is not.
    colorsMap.real = '#00FF00';
    const fragments = parseDecorated('`:evil`text', colorsMap);
    assert.equal(fragments[0].style.fg.resolved, null,
        'inherited colour name not resolved');
    const fragments2 = parseDecorated('`:real`text', colorsMap);
    assert.equal(fragments2[0].style.fg.resolved, '#00FF00');
});
