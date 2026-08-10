import assert from 'node:assert/strict';
import { TYPE_BY_CONTROL } from '../src/infer-schema.js';
import { DEFAULT_DATA_TYPE_BY_CONTROL } from '../src/control-spec.js';

/**
 * For each control in infer-schema, the property-collector default data type
 * must stay aligned (same keys where both apply; consistent semantics).
 */
function expectedPropertyType(control, inferEntry) {
    const { jsType } = inferEntry;
    if (jsType === null) return null;
    if (control === 'hidden') return 'string';
    if (control === 'daterange') return 'string';
    if (jsType === 'string') return 'string';
    if (jsType === 'boolean') return 'bool';
    if (jsType === 'array') return 'string[]';
    if (jsType === 'number') {
        if (control === 'number') return 'int';
        return 'float';
    }
    if (jsType === 'unknown') return 'string';
    throw new Error(`Unhandled jsType "${jsType}" for control "${control}"`);
}

test('TYPE_BY_CONTROL keys exist in DEFAULT_DATA_TYPE_BY_CONTROL (except label)', () => {
    for (const key of Object.keys(TYPE_BY_CONTROL)) {
        if (key === 'label') continue;
        assert.ok(
            Object.prototype.hasOwnProperty.call(DEFAULT_DATA_TYPE_BY_CONTROL, key),
            `DEFAULT_DATA_TYPE_BY_CONTROL missing "${key}" (present in TYPE_BY_CONTROL)`
        );
    }
});

test('infer vs property default types agree for shared controls', () => {
    for (const [control, inferEntry] of Object.entries(TYPE_BY_CONTROL)) {
        const expected = expectedPropertyType(control, inferEntry);
        const actual = DEFAULT_DATA_TYPE_BY_CONTROL[control];
        assert.equal(
            actual,
            expected,
            `control "${control}": DEFAULT_DATA_TYPE_BY_CONTROL is "${actual}", expected "${expected}" from infer jsType "${inferEntry.jsType}"`
        );
    }
});

test('DEFAULT_DATA_TYPE_BY_CONTROL keys are all covered by TYPE_BY_CONTROL', () => {
    // Every control with a default data type also has a TYPE_BY_CONTROL
    // entry so the scaffolders can emit a sensible default. Earlier
    // rounds left fileSize / fileBrowser / directoryBrowser missing
    // from TYPE_BY_CONTROL; that gap is now closed.
    const inferKeys = new Set(Object.keys(TYPE_BY_CONTROL));
    const extras = Object.keys(DEFAULT_DATA_TYPE_BY_CONTROL).filter((k) => !inferKeys.has(k));
    assert.deepEqual(extras, [], `unexpected extras in DEFAULT_DATA_TYPE_BY_CONTROL: ${extras.join(', ')}`);
});
