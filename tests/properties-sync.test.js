// Tests for viewer/properties-sync.js — the auto-sync gate that
// prevents the viewer from rewriting a __properties block whose
// existing text already parses to the canonical dictionary.
//
// The classic regression: an int-typed property declared as
// `default: "30"` (numeric-string literal). The parser coerces the
// string to a number (round-25 numeric-string default support), so
// the canonical text shape is `default: 30`. Without the gate, every
// Process pass silently rewrites the user's "30" → 30 and reads as
// "my edit became stale on Process." The gate catches that case
// and short-circuits the rewrite.

import test from 'node:test';
import assert from 'node:assert/strict';

import { TextFormBuilder } from '../src/index.js';
import {
    locatePropertiesBlock,
    arePropertiesSemanticallyEqual
} from '../viewer/properties-sync.js';

function canonicalProps(source) {
    const r = new TextFormBuilder({ schemaText: source }).process();
    if (r.error !== 0) {
        throw new Error(`fixture parse failed: ${r.messages.join('\n')}`);
    }
    return r.payload.__properties;
}

// ─── locatePropertiesBlock ──────────────────────────────────────────────

test('locatePropertiesBlock finds a canonical multi-line block and returns its slice', () => {
    const src = `columns: 12

__properties = [
    "retentionDays" = { type: "int", default: "30" }
]

[container("X")]
`;
    const loc = locatePropertiesBlock(src);
    assert.ok(loc, 'block should be located');
    assert.equal(src.slice(loc.start, loc.end), loc.text,
        'returned text must match the slice between start and end');
    assert.match(loc.text, /^__properties\s*=\s*\[/,
        'returned text must lead with the keyword');
    assert.match(loc.text, /\]\s*$/,
        'returned text must end at the closing bracket (with no trailing newline)');
});

test('locatePropertiesBlock returns null when no block exists', () => {
    const src = `columns: 12

[container("X")]
  - [textfield(4, {name})] Name
`;
    assert.equal(locatePropertiesBlock(src), null);
});

test('locatePropertiesBlock returns null for an empty source', () => {
    assert.equal(locatePropertiesBlock(''), null);
    assert.equal(locatePropertiesBlock(null), null);
    assert.equal(locatePropertiesBlock(undefined), null);
});

test('locatePropertiesBlock returns null when brackets are unterminated', () => {
    const src = `columns: 12

__properties = [
    "name" = { type: "string", default: "x"
`;
    assert.equal(locatePropertiesBlock(src), null);
});

test('locatePropertiesBlock skips through ] inside string literals', () => {
    const src = `columns: 12

__properties = [
    "tip" = { type: "string", default: "this ] is fine" }
]

[container("X")]
`;
    const loc = locatePropertiesBlock(src);
    assert.ok(loc, 'a string-internal ] must not close the block');
    assert.match(loc.text, /\]\s*$/);
});

// ─── arePropertiesSemanticallyEqual — the real bug ──────────────────────

test('default: "30" for an int property is semantically equal to the canonical default: 30 — auto-sync must NOT rewrite', () => {
    const userSource = `columns: 12

__properties = [
    "retentionDays" = { type: "int", default: "30" }
]

[container("X")]
  - [number(4, {retentionDays})] Days
`;
    const canon = canonicalProps(userSource);
    // The canonical dict will have the coerced number. The gate must
    // recognise the user's typed string-literal form as semantically
    // equivalent so the auto-sync rewrite is suppressed.
    assert.equal(canon.retentionDays.default, 30,
        'sanity: the parser canonicalises "30" → 30 for an int default');
    assert.equal(arePropertiesSemanticallyEqual(userSource, canon), true,
        'auto-sync gate must treat default: "30" as equivalent to default: 30');
});

test('arePropertiesSemanticallyEqual returns false when the source has no block (insertion needed)', () => {
    const src = `columns: 12

[container("X")]
  - [textfield(4, {name})] Name
`;
    const canon = canonicalProps(src);
    // No block in source, so the gate must allow the rewrite to insert one.
    assert.equal(arePropertiesSemanticallyEqual(src, canon), false);
});

test('arePropertiesSemanticallyEqual returns false when the source block is missing inferred keys (refresh needed)', () => {
    const stale = `columns: 12

__properties = [
    "name" = { type: "string", default: "" }
]

[container("X")]
  - [textfield(4, {name})] Name
  - [number(4, {age})] Age
`;
    // The canonical dict will include both name and age (age inferred
    // from the control). The source block only declares name — the
    // gate must allow the rewrite so age gets added.
    const canon = canonicalProps(stale);
    assert.ok('age' in canon, 'sanity: parser inferred age from the control');
    assert.equal(arePropertiesSemanticallyEqual(stale, canon), false,
        'gate must not suppress the rewrite when the block is missing inferred keys');
});

test('arePropertiesSemanticallyEqual returns false when the canonical dict is null/missing', () => {
    const src = `columns: 12
__properties = []
[container("X")]
`;
    assert.equal(arePropertiesSemanticallyEqual(src, null), false);
    assert.equal(arePropertiesSemanticallyEqual(src, undefined), false);
});

test('arePropertiesSemanticallyEqual is order-insensitive on property keys', () => {
    const src = `columns: 12

__properties = [
    "a" = { type: "string", default: "" },
    "b" = { type: "int",    default: 0 }
]

[container("X")]
  - [textfield(4, {a})] A
  - [number(4, {b})]    B
`;
    // Reorder the canonical dict — same keys, different insertion
    // order. The gate must still treat it as equivalent.
    const canon = canonicalProps(src);
    const reordered = { b: canon.b, a: canon.a };
    assert.equal(arePropertiesSemanticallyEqual(src, reordered), true,
        'gate must compare via stable key sort, not insertion order');
});

test('arePropertiesSemanticallyEqual returns false when an init= override changes the default', () => {
    const src = `columns: 12

__properties = [
    "retentionDays" = { type: "int", default: 30 }
]

[container("X")]
  - [number(4, {retentionDays}, init=42)] Days
`;
    // The init= literal hoists to the property default (existing
    // round-? behaviour: "Literal init= sets the property default").
    // Canonical dict reports default: 42. The user's source block
    // says default: 30. Gate must allow the rewrite — the source IS
    // out of sync with the controls.
    const canon = canonicalProps(src);
    assert.equal(canon.retentionDays.default, 42,
        'sanity: init=42 hoists to the property default');
    assert.equal(arePropertiesSemanticallyEqual(src, canon), false,
        'gate must not suppress the rewrite when init= drives a real semantic change');
});

test('arePropertiesSemanticallyEqual handles an empty block matching an empty canonical dict', () => {
    // Both source block and canonical dict are empty — the rewrite
    // would be a no-op anyway, but the gate's contract still says
    // "true when equivalent."
    const src = `columns: 12

__properties = []

[container("X")]
`;
    const canon = canonicalProps(src);
    // The parser hands back an Object.create(null)-style dict, so
    // a key-count check is more honest than deepEqual({}).
    assert.equal(Object.keys(canon).length, 0,
        'sanity: empty block produces a no-keys dict');
    assert.equal(arePropertiesSemanticallyEqual(src, canon), true);
});
