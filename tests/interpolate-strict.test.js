import assert from 'node:assert/strict';
import { interpolate } from '../src/interpolate.js';

test('strict: missing binding throws', () => {
    assert.throws(
        () => interpolate('{missing}', {}, {}, { strict: true }),
        /missing data for \{missing\}/
    );
});

test('strict: missing @function throws', () => {
    assert.throws(
        () => interpolate('{@nope}', {}, {}, { strict: true }),
        /no function registered/
    );
});

test('strict: function throw propagates', () => {
    assert.throws(
        () => interpolate(
            '{@bad}',
            {},
            { bad: () => { throw new Error('boom'); } },
            { strict: true }
        ),
        /boom/
    );
});

test('strict: null function result throws', () => {
    assert.throws(
        () => interpolate(
            '{@nil}',
            {},
            { nil: () => null },
            { strict: true }
        ),
        /returned null or undefined/
    );
});

test('non-strict: placeholders pass through', () => {
    assert.equal(interpolate('{x}', {}, {}), '{x}');
    assert.equal(interpolate('{@z}', {}, {}), '{@z}');
});
