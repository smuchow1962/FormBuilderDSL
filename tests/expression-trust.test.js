import assert from 'node:assert/strict';
import {
    evaluateWhen,
    parseWhen,
    DEFAULT_MAX_WHEN_SOURCE_LENGTH,
    FORBIDDEN_PATH_SEGMENTS
} from '../src/expression.js';

describe('expression trust boundaries', () => {
    it('documents forbidden path segments', () => {
        assert.ok(FORBIDDEN_PATH_SEGMENTS.has('__proto__'));
        assert.ok(FORBIDDEN_PATH_SEGMENTS.has('constructor'));
    });

    it('does not resolve forbidden segment even when key exists', () => {
        assert.equal(evaluateWhen('constructor == 1', { constructor: 1 }), false);
    });

    it('does not read inherited properties on data (when uses own props only)', () => {
        const data = Object.assign(Object.create({ inherited: 1 }), { own: 2 });
        assert.equal(evaluateWhen('inherited == 1', data), false);
        assert.equal(evaluateWhen('own == 2', data), true);
    });

    it('throws when source exceeds maxSourceLength', () => {
        const long = 'a'.repeat(DEFAULT_MAX_WHEN_SOURCE_LENGTH + 1);
        assert.throws(() => parseWhen(long), /exceeds max length/);
    });

    it('evaluateWhen respects maxSourceLength option', () => {
        assert.equal(evaluateWhen('a == 1', { a: 1 }, { maxSourceLength: 32 }), true);
        assert.throws(
            () => evaluateWhen('a == 1', { a: 1 }, { maxSourceLength: 4 }),
            /exceeds max length/
        );
    });
});
