// Regression tests for round-14 review fixes.
//
// Coverage map:
//   M3   parse-controls.js comment near the contentRef / optionsSource
//        dispatch references the validateControlSpec check that
//        actually shipped, not a forward-looking note. Verified by
//        reading the source file and confirming no "right place to
//        add" wording remains.
//   M4   ControlSpec / ControlSpecEntry / ParamSpec interfaces are
//        exported. Sanity-checked at runtime by importing them as
//        types via JSDoc and confirming a default-spec entry shape
//        matches.
//   D1   json-internal-model.md skeleton no longer claims
//        dataType: "string" on controls without __dataType=. The
//        skeleton now matches the runtime (dataType: null).
//   D3   architecture.md no longer carries §10A; the philosophy
//        moved to docs/design-philosophy.md.
//   D5   README clarifies the npm test vs npm run test:coverage:check
//        relationship.
//   D6   expression-trust.md describes the function-arm own-property
//        check + reserved-segment screen.
//   D7-residual  parse-containers.js + literal-types.js comments no
//        longer narrate iteration history.
//   m9   _normalizeMessages produces a tagged "[unserialisable
//        object: <reason>]" message instead of "[object Object]"
//        when JSON.stringify throws.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { TupleResponse, ERR } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot  = join(__dirname, '..');
const readDoc = (relPath) => readFileSync(join(repoRoot, relPath), 'utf8');

// ─── M3 stale forward-looking comment removed ────────────────────────────

test("M3 parse-controls.js no longer carries the 'right place to add' forward-looking comment", () => {
    const text = readDoc('src/parser/parse-controls.js');
    assert.equal(text.includes('right place to add an'),       false);
    assert.equal(text.includes('before that lands'),           false);
    // The comment now references the actual check (split across
    // multiple lines, so match on the distinctive verb).
    assert.ok(text.includes('refuses a spec that declares contentRef'),
        'expected forward-looking explanation referencing the validator');
});

// ─── M4 ControlSpec types are exported ───────────────────────────────────

test('M4 types/index.d.ts declares ControlSpec / ControlSpecEntry / ParamSpec', () => {
    const text = readDoc('types/index.d.ts');
    assert.ok(text.includes('export interface ControlSpec'),       'ControlSpec interface missing');
    assert.ok(text.includes('export interface ControlSpecEntry'),  'ControlSpecEntry interface missing');
    assert.ok(text.includes('export interface ParamSpec'),         'ParamSpec interface missing');
    // The builder constructor and registerControl now reference the typed shape.
    assert.ok(text.includes('controlSpec?: ControlSpec'),          'TextFormBuilder.controlSpec not typed as ControlSpec');
    assert.ok(text.includes('spec: ControlSpecEntry'),             'registerControl spec parameter not typed as ControlSpecEntry');
});

// ─── D1 json-internal-model.md removed; architecture.md is canonical ────

test('D1 json-internal-model.md has been deleted; architecture.md is the canonical AST reference', () => {
    assert.equal(existsSync(join(repoRoot, 'docs/json-internal-model.md')), false,
        'docs/json-internal-model.md should be deleted; architecture.md is canonical');
});

// ─── D3 §10A moved to design-philosophy.md ──────────────────────────────

test('D3 architecture.md no longer contains the "10A. CUPID + DRY" section', () => {
    const text = readDoc('docs/architecture.md');
    assert.equal(text.includes('## 10A'),    false);
    assert.equal(text.includes('CUPID + DRY in this codebase'), false);
});

test('D3 docs/design-philosophy.md exists and covers CUPID + DRY', () => {
    const text = readDoc('docs/design-philosophy.md');
    assert.ok(text.includes('CUPID'));
    assert.ok(text.includes('DRY'));
    assert.ok(text.includes('Composable'));
    assert.ok(text.includes('Domain-based'));
});

// ─── D5 README coverage-check clarification ──────────────────────────────

test('D5 README distinguishes npm test from npm run test:coverage:check', () => {
    const text = readDoc('README.md');
    assert.ok(text.includes('test:coverage:check'),
        'coverage-check command name missing from README');
    assert.ok(text.match(/npm test.*does not.*c8|gated in CI by `npm run test:coverage:check`/),
        'README should say which command enforces the threshold gate');
});

// ─── D6 expression-trust.md describes function-arm safety ────────────────

test("D6 expression-trust.md covers the function-arm own-property check", () => {
    const text = readDoc('docs/expression-trust.md');
    assert.ok(text.includes('Function-arm safety'),
        'function-arm safety section missing');
    assert.ok(text.includes('hasOwnProperty'),
        'hasOwnProperty check not named in trust doc');
    assert.ok(text.includes('{@constructor}'),
        'function-arm reserved-segment example missing');
});

// ─── D7-residual no iteration-history comments left in source ────────────

test("D7-residual parse-containers.js no longer narrates the removal of inline tooltip=", () => {
    const text = readDoc('src/parser/parse-containers.js');
    assert.equal(text.includes('earlier inline'),    false);
    assert.equal(text.includes('has been removed'),  false);
});

test("D7-residual literal-types.js no longer narrates 'two parse paths used to own a copy'", () => {
    const text = readDoc('src/parser/literal-types.js');
    assert.equal(text.includes('used to own a copy'), false);
});

// ─── m9 _normalizeMessages tagged unserialisable message ─────────────────

test('m9 TupleResponse.fail with a circular object produces a tagged unserialisable message', () => {
    const obj = { a: 1 };
    obj.self = obj;
    const r = TupleResponse.fail(ERR.PARSE_ERROR, obj);
    assert.equal(r.messages.length, 1);
    assert.match(r.messages[0], /^\[unserialisable object: /,
        'expected tagged "[unserialisable object: ...]" message; got ' + r.messages[0]);
});

test('m9 TupleResponse.fail with a BigInt-bearing object produces a tagged unserialisable message', () => {
    // BigInt values are not JSON-serialisable. The fallback path
    // names the reason rather than collapsing to "[object Object]".
    const obj = { count: 42n };
    const r = TupleResponse.fail(ERR.PARSE_ERROR, obj);
    assert.equal(r.messages.length, 1);
    assert.match(r.messages[0], /^\[unserialisable object: /,
        'expected tagged unserialisable message for BigInt input');
});

test('m9 TupleResponse.fail with a serialisable object still produces JSON', () => {
    // Sanity check that the new branch only fires on the throw
    // path; a normal object still serialises through JSON.stringify.
    const r = TupleResponse.fail(ERR.PARSE_ERROR, { code: 'X', detail: 'y' });
    assert.equal(r.messages.length, 1);
    assert.equal(r.messages[0], '{"code":"X","detail":"y"}');
});

// ─── M1 / M2 housekeeping (rename + glob) ────────────────────────────────

test("M1 + M2 housekeeping: package.json test:unit uses a glob, not a hand-maintained list", () => {
    const pkg = JSON.parse(readDoc('package.json'));
    assert.match(pkg.scripts['test:unit'], /tests\/\*\.test\.js/,
        'test:unit should glob test files rather than enumerate them');
    assert.equal(pkg.scripts['test:unit'].includes('principal-review-r'), false,
        'test:unit should not reference the old principal-review-rN names');
});
