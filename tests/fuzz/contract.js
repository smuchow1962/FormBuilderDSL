// The error contract every fuzz property holds the library to.
//
// A fuzz test whose only assertion is "didn't crash" is close to worthless:
// a library that swallowed everything into `catch {}` would pass it. The
// contract here is sharper — untrusted input may produce exactly one of two
// outcomes:
//
//   • a normal return value, or
//   • a ParseError (the library's own declared error type)
//
// Anything else — TypeError, RangeError, "Cannot read properties of
// undefined" — is an unhandled internal failure and a real bug. Keeping that
// distinction in one place means every property enforces the same bar.

import { ParseError } from '../../src/tuple-response.js';

/**
 * Run `fn`. Returns its value if it returns. If it throws a ParseError,
 * returns the sentinel below. Any other throw is rethrown with the original
 * error type named, because "TypeError leaked out of the tokenizer" is the
 * finding, and the raw message alone rarely makes that obvious.
 */
export const THREW_PARSE_ERROR = Symbol('threw ParseError');

export function runUnderContract(fn) {
    try {
        return fn();
    } catch (err) {
        if (err instanceof ParseError) {
            assertWellFormedParseError(err);
            return THREW_PARSE_ERROR;
        }
        const kind = err?.constructor?.name ?? typeof err;
        throw new Error(
            `expected a return value or ParseError, got ${kind}: ${err?.message ?? err}\n` +
            `${err?.stack ?? ''}`
        );
    }
}

/**
 * A ParseError is part of the public contract, so its own fields have to hold
 * up under fuzz input too — a diagnostic that reports NaN or a negative
 * column is a diagnostic a consumer's editor integration will mis-render.
 */
export function assertWellFormedParseError(err) {
    if (typeof err.message !== 'string' || err.message.length === 0) {
        throw new Error('ParseError carries an empty message');
    }
    for (const field of ['line', 'col']) {
        const v = err[field];
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
            throw new Error(`ParseError.${field} should be a finite non-negative number, got ${String(v)}`);
        }
    }
    if (typeof err.toMessage() !== 'string') {
        throw new Error('ParseError.toMessage() should return a string');
    }
}

/** Assert the value is a TupleResponse-shaped envelope. */
export function assertEnvelope(result) {
    if (result === null || typeof result !== 'object') {
        throw new Error(`expected a result envelope, got ${String(result)}`);
    }
    if (typeof result.error !== 'number' || !Number.isInteger(result.error)) {
        throw new Error(`envelope.error should be an integer code, got ${String(result.error)}`);
    }
    if (!Array.isArray(result.messages)) {
        throw new Error(`envelope.messages should be an array, got ${String(result.messages)}`);
    }
    for (const m of result.messages) {
        if (typeof m !== 'string') {
            throw new Error(`envelope.messages entries should be strings, got ${String(m)}`);
        }
    }
}
