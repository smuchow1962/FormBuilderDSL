// Tests covering the principal-review v1.0.0 follow-up fixes. Each
// `test(...)` block names the review item it locks in (C1, M1, M3,
// etc.) so a future maintainer can trace why the assertion exists.
//
// Reference policy locked in here: every #name reference must be
// declared in the same .mmpform document. The only externally-
// resolvable reference is {@function}.

import assert from 'node:assert/strict';

import {
    TextFormBuilder,
    ERR,
    validateControlSpec,
    interpolate,
    parseWhen,
    evaluateWhen,
    FORBIDDEN_PATH_SEGMENTS
} from '../src/index.js';

// ─── C1: contentRef cross-check (label / display) ──────────────────────────

test("C1: [label(4,#missingName)] raises INVALID_REF", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container("Hi")]

  - [label(4,#missingName)]
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_REF);
    assert.ok(result.messages.some(m => m.includes('missingName')));
});

test("C1: [label(4,#realName)] succeeds when realName is declared", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

intro = "welcome"

[container("Hi")]

  - [label(4,#intro)]
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    const labelCtl = result.payload.root.rows[0].controls[0];
    assert.equal(labelCtl.contentRef, 'intro');
    // The label gets rewritten to the named-text body.
    assert.deepEqual(labelCtl.label, [{ kind: 'text', text: 'welcome' }]);
});

test("C1: [display(5,{value},#missingDoc)] raises INVALID_REF", () => {
    // display requires a binding AND allows an optional contentRef.
    // The HASH_IDENT routes to contentRef because policy.contentRef
    // is 'allowed'; the binding cross-check still has to fail.
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container("Hi")]

  - [display(5,{value},#missingDoc)]
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_REF);
});

// ─── C1 + ref policy: inline #name in container slots ───────────────────────

test("C1: unresolved inline #ref in container description raises INVALID_REF", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container("Title",#missingThing)]

  - [textfield(10,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_REF);
    assert.ok(result.messages.some(m => m.includes('missingThing')));
});

test("C1: declared inline #ref resolves into the container slot fragments", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

helpDesc = "see the docs"

[container("Title",#helpDesc)]

  - [textfield(10,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    assert.deepEqual(result.payload.root.description, [{ kind: 'text', text: 'see the docs' }]);
});

// ─── M7: container tt= cross-check ──────────────────────────────────────────

test("M7: container with tt='missing' raises INVALID_REF", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container({t},tt="missingTip")]

  - [textfield(10,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_REF);
    assert.ok(result.messages.some(m => m.includes('missingTip')));
});

test("M7: container with tt='real' succeeds when tooltip is declared", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

tooltips = [helpKey = "help me"]

[container({t},tt="helpKey")]

  - [textfield(10,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    assert.equal(result.payload.root.tooltipRef, 'helpKey');
});

// ─── Reference policy: excluded=#name on listManager ───────────────────────

test("validate: listManager with excluded=#missing raises INVALID_REF", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[listManager({items},excluded=#missing)]

  - [textfield(10,{name})] Name
`
    }).parse();
    assert.equal(result.error, ERR.INVALID_REF);
});

// ─── M5: parseGlobalConfig EOF check ────────────────────────────────────────

test("M5: 'columns:' with no value gives a missing-value message, not a type error", () => {
    const result = new TextFormBuilder({
        schemaText: `columns:`
    }).parse();
    assert.equal(result.error, ERR.PARSE_ERROR);
    assert.ok(
        result.messages.some(m => /Missing value for 'columns'/.test(m)),
        `expected missing-value message, got: ${result.messages.join(' | ')}`
    );
});

// ─── M1: expression string escape support ───────────────────────────────────

test("M1: parseWhen accepts a single quote escaped inside a single-quoted string", () => {
    const ast = parseWhen("name == 'O\\'Brien'");
    assert.ok(ast);
    assert.equal(ast.kind, 'eq');
    assert.equal(ast.r.kind, 'lit');
    assert.equal(ast.r.v, "O'Brien");
});

test("M1: parseWhen accepts an escaped double quote inside a double-quoted string", () => {
    const ast = parseWhen('name == "a\\"b"');
    assert.equal(ast.r.v, 'a"b');
});

test("M1: parseWhen rejects an unterminated string", () => {
    assert.throws(() => parseWhen("name == 'unterminated"), /Unterminated/);
});

// ─── M3: missing-field eq / neq semantics ───────────────────────────────────

test("M3: evaluateWhen returns false for `missing == 'x'`", () => {
    assert.equal(evaluateWhen("field == 'x'", {}), false);
});

test("M3: evaluateWhen returns true for `missing != 'x'`", () => {
    // Strict !== semantics: undefined !== 'x' is true. Locked
    // intentionally per docs/expression-trust.md.
    assert.equal(evaluateWhen("field != 'x'", {}), true);
});

// ─── M2: `in` operator with mixed-type list ─────────────────────────────────

test("M2: `in [1, '1']` matches the number 1 against numeric LHS", () => {
    assert.equal(evaluateWhen("port in [1, '1']", { port: 1 }),  true);
    // String '1' also matches because the list contains both literals.
    assert.equal(evaluateWhen("port in [1, '1']", { port: '1' }), true);
});

test("M2: `in [1]` does NOT match the string '1'", () => {
    assert.equal(evaluateWhen("port in [1]", { port: '1' }), false);
});

test("M2: `in ['1']` does NOT match the number 1", () => {
    assert.equal(evaluateWhen("port in ['1']", { port: 1 }), false);
});

// ─── N7: FORBIDDEN_PATH_SEGMENTS is truly read-only ─────────────────────────

test("N7: FORBIDDEN_PATH_SEGMENTS.add throws TypeError", () => {
    assert.throws(() => FORBIDDEN_PATH_SEGMENTS.add('extra'), /read-only/);
});

test("N7: FORBIDDEN_PATH_SEGMENTS.delete throws TypeError", () => {
    assert.throws(() => FORBIDDEN_PATH_SEGMENTS.delete('__proto__'), /read-only/);
});

test("N7: FORBIDDEN_PATH_SEGMENTS.clear throws TypeError", () => {
    assert.throws(() => FORBIDDEN_PATH_SEGMENTS.clear(), /read-only/);
});

test("N7: FORBIDDEN_PATH_SEGMENTS.has still works", () => {
    assert.equal(FORBIDDEN_PATH_SEGMENTS.has('__proto__'), true);
    assert.equal(FORBIDDEN_PATH_SEGMENTS.has('prototype'), true);
    assert.equal(FORBIDDEN_PATH_SEGMENTS.has('constructor'), true);
    assert.equal(FORBIDDEN_PATH_SEGMENTS.has('safeName'), false);
});

test("N7: FORBIDDEN_PATH_SEGMENTS still blocks prototype-pollution paths after attempted mutation", () => {
    try { FORBIDDEN_PATH_SEGMENTS.delete('__proto__'); } catch { /* expected */ }
    // Path resolver still refuses; the policy held.
    assert.equal(evaluateWhen("__proto__.x == 'evil'", {}), false);
});

// ─── N6: validateControlSpec walks __common.params ──────────────────────────

test("N6: validateControlSpec rejects malformed __common.params.<name>.type", () => {
    const errors = validateControlSpec({
        __common: {
            params: {
                when: { type: 'oops', default: null }
            }
        },
        textfield: { params: {} }
    });
    assert.ok(
        errors.some(e => /__common\.when/.test(e) && /unknown param type/.test(e)),
        `expected __common.when type error, got: ${errors.join(' | ')}`
    );
});

test("N6: validateControlSpec rejects __common.params entry that is not an object", () => {
    const errors = validateControlSpec({
        __common: { params: { when: null } },
        textfield: { params: {} }
    });
    assert.ok(errors.some(e => /__common\.when/.test(e)));
});

test("N6: validateControlSpec rejects __common enum without values", () => {
    const errors = validateControlSpec({
        __common: { params: { mode: { type: 'enum' } } },
        textfield: { params: {} }
    });
    assert.ok(errors.some(e => /__common\.mode/.test(e) && /enum/.test(e)));
});

// ─── interpolate: lenient vs strict throw behaviour ─────────────────────────

test("interpolate lenient: throwing function returns the literal {@name} placeholder", () => {
    const fns = { boom: () => { throw new Error('explode'); } };
    const out = interpolate('hello {@boom}', {}, fns);
    assert.equal(out, 'hello {@boom}');
});

test("interpolate strict: throwing function rethrows the original error", () => {
    const original = new Error('explode');
    const fns = { boom: () => { throw original; } };
    assert.throws(
        () => interpolate('hello {@boom}', {}, fns, { strict: true }),
        e => e === original
    );
});

// ─── tokenizer: .5 and escaped quotes ───────────────────────────────────────

test("tokenizer: bare '.5' lexes as a single FLOAT in value position", () => {
    // Leading-dot floats are now first-class. The previous behaviour
    // (DOT + INTEGER, then a parse error) was a sharp edge for
    // anyone coming from JSON; the lexer now accepts `.5` and `-.5`
    // when the previous token isn't an identifier path component.
    const result = new TextFormBuilder({
        schemaText: `columns: 10

choices = [.5]
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    assert.deepEqual(result.payload.optionSources.choices.values, [0.5]);
});

test("tokenizer: '0.5' tokenises as a single FLOAT and parses fine", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

choices = [0.5]

[container("Hi")]

  - [textfield(10,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
});

test("tokenizer: escaped single quote inside a single-quoted DSL string survives", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container("Hi")]

  - [textfield(10,{x},placeholder='O\\'Brien')] Name
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    const ctl = result.payload.root.rows[0].controls[0];
    assert.equal(ctl.params.placeholder, "O'Brien");
});

test("tokenizer: escaped double quote inside a double-quoted DSL string survives", () => {
    const result = new TextFormBuilder({
        schemaText: `columns: 10

[container("Hi")]

  - [textfield(10,{x},placeholder="a\\"b")] Name
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    const ctl = result.payload.root.rows[0].controls[0];
    assert.equal(ctl.params.placeholder, 'a"b');
});

// ─── tokenizer M6: nested array literal still re-classifies inner [ ─────────

test("M6: a __properties block with a string-array default parses without confusing [ tokens", () => {
    // The __properties block opens with `[`. The default's `[`
    // comes after a COLON, so the post-process pass has to
    // re-classify it as LSQUARE. The fix to the post-process pass
    // adds LSQUARE itself to the list of openers, so a `[` that
    // sits inside an already-rewritten LSQUARE region also
    // re-classifies. This test locks the canonical case.
    const result = new TextFormBuilder({
        schemaText: `columns: 10

__properties = [tags = { type: 'string[]', default: ["a","b"] }]

[container("Hi")]

  - [textfield(10,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));
    assert.deepEqual(result.payload.__properties.tags.default, ['a', 'b']);
});

// ─── parse-toplevel: bare ident as object value ────────────────────────────

test("parseObjectValue: bare ident `tru` is rejected (strings must be quoted)", () => {
    // Quoted-strings rule: only `true`, `false`, `null` are allowed
    // bare in object values. A typo like `tru` raises PARSE_ERROR
    // instead of silently becoming the string "tru".
    const result = new TextFormBuilder({
        schemaText: `columns: 10

mode = { active: tru }

[container("Hi")]

  - [textfield(10,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.PARSE_ERROR);
    assert.ok(result.messages.some(m => /tru/.test(m)));
});

// ─── parser policy: types/index.d.ts has 3-fragment union ──────────────────

test("policy: TextFragment AST values use the 3-kind union (no 'ref' leaks)", () => {
    // After parse, every fragment in every text slot is one of
    // text / binding / function. A `ref` fragment is internal and
    // never reaches a consumer.
    const result = new TextFormBuilder({
        schemaText: `columns: 10

intro = "welcome"

[container("Title", #intro)]

  - [textfield(10,{x})] X
`
    }).parse();
    assert.equal(result.error, ERR.OK, result.messages.join('\n'));

    const seenKinds = new Set();
    const visit = (node) => {
        if (!node) return;
        const slots = ['title', 'description', 'tooltip', 'label', 'explain'];
        for (const slot of slots) {
            const frags = node[slot];
            if (Array.isArray(frags)) {
                for (const f of frags) seenKinds.add(f.kind);
            }
        }
        if (node.headerControls) for (const h of node.headerControls) visit(h);
        if (node.panels) for (const p of node.panels) for (const r of p.rows) visit(r);
        if (node.rows) for (const r of node.rows) visit(r);
        if (node.controls) for (const c of node.controls) visit(c);
    };
    visit(result.payload.root);

    for (const kind of seenKinds) {
        assert.ok(
            kind === 'text' || kind === 'binding' || kind === 'function',
            `unexpected fragment kind '${kind}' in consumer-facing AST`
        );
    }
});
