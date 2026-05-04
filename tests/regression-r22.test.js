// Regression tests for round-22 critical fixes.
//
// Coverage map:
//   C1 — renderForm round-trips a collapsible container.
//   C2 — renderForm round-trips a panels=[N:W] container.
//   C3 — renderForm round-trips every documented value type.

import test from 'node:test';
import assert from 'node:assert/strict';

import { TextFormBuilder, ERR, renderForm, walkAst } from '../src/index.js';

// Round-trip helper: parse → render → parse and assert structural
// equivalence. Returns the second parse result so a caller can
// inspect specific fields if needed.
function roundTrip(schemaText) {
    const a = new TextFormBuilder({ schemaText }).parse();
    if (a.error !== ERR.OK) {
        throw new Error(`first parse failed:\n${a.messages.join('\n')}\n--- source ---\n${schemaText}`);
    }
    const text = renderForm(a.payload);
    const b = new TextFormBuilder({ schemaText: text }).parse();
    if (b.error !== ERR.OK) {
        throw new Error(`re-parse failed:\n${b.messages.join('\n')}\n--- rendered ---\n${text}`);
    }
    return { a, b, text };
}

// Structural signature for equivalence comparison. Strips loc info
// (line/col can shift across rewrites) but keeps every field that
// matters for behaviour.
function sig(payload) {
    const node = (n) => {
        if (!n) return null;
        const out = { kind: n.nodeKind };
        if (n.collapsible !== undefined) out.collapsible = n.collapsible;
        if (n.panels) out.panels = n.panels.map(p => ({ num: p.number, width: p.width, rows: p.rows.map(r => node(r)) }));
        if (n.rows)   out.rows = n.rows.map(node);
        if (n.controls) out.controls = n.controls.map(c => c.nodeKind === 'control'
            ? { kind: 'control', controlType: c.controlType, binding: c.binding, width: c.width, init: c.init?.kind, when: c.when }
            : node(c));
        if (n.arrayBinding !== undefined && n.arrayBinding !== null) out.arrayBinding = n.arrayBinding;
        if (n.search) out.search = true;
        if (n.draggable) out.draggable = true;
        return out;
    };
    return {
        columns: payload.columns,
        root: node(payload.root)
    };
}

// ─── C1 collapsible container ────────────────────────────────────────────

test('C1 renderForm round-trips a collapsible container', () => {
    const { a, b, text } = roundTrip(`columns: 10

[>container({title})]

  - [textfield(5,{name})] Name
`);
    assert.equal(b.payload.root.collapsible, true,
        `re-parsed root should still be collapsible; rendered text was:\n${text}`);
    assert.deepEqual(sig(a.payload), sig(b.payload));
});

test('C1 a non-collapsible container does not pick up a stray > on the round-trip', () => {
    const { b } = roundTrip(`columns: 10

[container({title})]

  - [textfield(5,{name})] Name
`);
    assert.equal(b.payload.root.collapsible, false);
});

// ─── C2 panels container ─────────────────────────────────────────────────

test('C2 renderForm round-trips a panels=[1:8,2:12] container', () => {
    const { a, b, text } = roundTrip(`columns: 20

[container({t},panels=[1:8,2:12])]

  1. First panel
    - [textfield(8,{x})] X
  2. Second panel
    - [number(12,{y})] Y
`);
    assert.ok(b.payload.root.panels, `re-parsed root should have panels; got:\n${text}`);
    assert.equal(b.payload.root.panels.length, 2);
    assert.equal(b.payload.root.panels[0].number, 1);
    assert.equal(b.payload.root.panels[0].width,  8);
    assert.equal(b.payload.root.panels[1].number, 2);
    assert.equal(b.payload.root.panels[1].width,  12);
    assert.deepEqual(sig(a.payload), sig(b.payload));
});

test('C2 a panels container without panels= header in the rendered output is a regression catch', () => {
    // Asserts the head includes panels=[...]; without it, the body
    // markers would parse as garbage. This is the specific failure
    // mode that shipped before the fix.
    const a = new TextFormBuilder({
        schemaText: `columns: 20

[container({t},panels=[1:8,2:12])]

  1. First
    - [textfield(8,{x})] X
  2. Second
    - [number(12,{y})] Y
`
    }).parse();
    const text = renderForm(a.payload);
    assert.ok(/panels=\[1:8,2:12\]/.test(text),
        `rendered text should include panels=[1:8,2:12]; got:\n${text}`);
    assert.equal(/\[panel\(/.test(text), false,
        `rendered text should NOT contain [panel(...)] declarations (that is invented syntax); got:\n${text}`);
});

// ─── C3 wider round-trip coverage ────────────────────────────────────────

test('C3 round-trip preserves a repeater', () => {
    const { a, b } = roundTrip(`columns: 10

[repeater({routes},min=1,max=10)]

  - [textfield(5,{this.match})] Match
  - [textfield(5,{this.target})] Target
`);
    assert.equal(b.payload.root.nodeKind, 'repeater');
    assert.equal(b.payload.root.arrayBinding, 'routes');
    assert.equal(b.payload.root.itemMin, 1);
    assert.equal(b.payload.root.itemMax, 10);
    assert.deepEqual(sig(a.payload), sig(b.payload));
});

test('C3 round-trip preserves a listManager with search and draggable', () => {
    const { a, b } = roundTrip(`columns: 10

[listManager({items},search=true,draggable=true)]

  - [textfield(5,{this.name})] Name
`);
    assert.equal(b.payload.root.nodeKind, 'listManager');
    assert.equal(b.payload.root.search, true);
    assert.equal(b.payload.root.draggable, true);
    assert.deepEqual(sig(a.payload), sig(b.payload));
});

test('C3 round-trip preserves a tooltips block + tt= reference', () => {
    const { b } = roundTrip(`columns: 10

tooltips = ["help" = "this helps"]

[container({t})]

  - [textfield(5,{x},tt="help")] X
`);
    assert.deepEqual(Object.keys(b.payload.tooltips), ['help']);
    assert.equal(b.payload.root.rows[0].controls[0].tooltipRef, 'help');
});

test('C3 round-trip preserves a colors block', () => {
    const { b } = roundTrip(`columns: 10

colors = ["primary" = "#3498DB"]

[container({t})]

  - [textfield(5,{x})] X
`);
    assert.equal(b.payload.colors.primary, '#3498DB');
});

test('C3 round-trip preserves an option source with arrow bindings', () => {
    const { b } = roundTrip(`columns: 10

sizes = ["S","M","L"] -> {size}

[container({t})]

  - [select(5,#sizes,{size})] Size
`);
    assert.deepEqual(b.payload.optionSources.sizes.values, ['S', 'M', 'L']);
    assert.deepEqual(b.payload.optionSources.sizes.bindings, ['size']);
});

test('C3 round-trip preserves an init= literal and a bindingType', () => {
    const { b } = roundTrip(`columns: 10

[container({t})]

  - [number(5,{count:int},init=42)] Count
`);
    const ctl = b.payload.root.rows[0].controls[0];
    assert.equal(ctl.bindingType, 'int');
    assert.equal(ctl.init.kind, 'literal');
    assert.equal(ctl.init.value, 42);
});

test('C3 round-trip preserves a when= expression', () => {
    const { b } = roundTrip(`columns: 10

[container({t})]

  - [check(5,{enabled})] Enabled
  - [textfield(5,{name},when="enabled == true")] Name
`);
    const nameCtl = b.payload.root.rows[1].controls[0];
    assert.equal(nameCtl.when, 'enabled == true');
});

test('C3 round-trip preserves a UTF-8 string default in __properties', () => {
    const a = new TextFormBuilder({
        schemaText: `columns: 10

__properties = ["greeting" = { type: "string", default: "Über grüße — 日本語" }]

[container({t})]

  - [textfield(5,{greeting})] G
`
    }).process();
    const text = renderForm(a.payload);
    const b = new TextFormBuilder({ schemaText: text }).process();
    assert.equal(b.error, ERR.OK, b.messages.join('\n'));
    assert.equal(b.payload.__properties.greeting.default, 'Über grüße — 日本語');
});

test('C3 round-trip preserves a __dataType override', () => {
    const { b } = roundTrip(`columns: 10

[container({t})]

  - [textfield(5,{flag},__dataType=bool)] Flag
`);
    const ctl = b.payload.root.rows[0].controls[0];
    assert.equal(ctl.dataType, 'bool');
});

test('C3 round-trip preserves a collapsible repeater', () => {
    // Combination of C1 and a non-default container kind.
    const { b } = roundTrip(`columns: 10

[>repeater({items})]

  - [textfield(5,{this.x})] X
`);
    assert.equal(b.payload.root.collapsible, true);
    assert.equal(b.payload.root.nodeKind, 'repeater');
});

// ─── walkAst sanity (the round-trip only matters if walkAst sees
// every node, which it does — repeated here as a quick sanity check
// after the renderForm changes touched container emit shape) ─────────

test('C3 walkAst still visits every node kind after renderForm fixes', () => {
    const r = new TextFormBuilder({
        schemaText: `columns: 20

[>container({t},panels=[1:8,2:12])]

  1. First
    - [textfield(8,{x})] X
  2. Second
    - [number(12,{y})] Y
`
    }).parse();
    assert.equal(r.error, ERR.OK);
    // walkAst tags each visit by what kind of node it was. Panels
    // are plain {number, label, width, rows} objects that don't
    // carry a nodeKind on the runtime AST, so visited entries for
    // them show up as 'panel' through the structural-descent
    // branch (we tag them explicitly here for the assertion).
    const visited = [];
    walkAst(r.payload, (n) => {
        if (n.nodeKind) visited.push(n.nodeKind);
        else if ('number' in n && 'width' in n && 'rows' in n) visited.push('panel');
        else visited.push('?');
    });
    assert.deepEqual(visited, ['container', 'panel', 'row', 'control', 'panel', 'row', 'control']);
});
