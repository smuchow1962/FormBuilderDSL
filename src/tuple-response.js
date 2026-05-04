// TupleResponse is the small `{ error, payload, messages }` envelope
// every public method that can fail returns. The shape borrows from
// Unix process results: a numeric code, a payload (or null on failure),
// and an array of diagnostic strings. Callers branch on `error === 0`
// (or `result.isOk()`) and have one stable place to look for both data
// and messages.
//
// ParseError is the internal exception the parser throws when it hits
// a problem. The runParse wrapper catches it and converts it into a
// TupleResponse failure. ParseError never escapes the public API; it's
// here so the parser code can throw from any depth without manually
// threading error returns up the call stack.

export const ERR = Object.freeze({
    OK:             0,
    LEX_ERROR:      1,
    PARSE_ERROR:    2,
    UNKNOWN_TYPE:   3,
    INVALID_PARAM:  4,
    INVALID_REF:    5,
    INVALID_LAYOUT: 6,
    INVALID_SPEC:   7,
    INTERNAL_ERROR: 8     // unexpected exception inside the parser; not a user-input problem
});

const ERR_NAMES = Object.freeze({
    0: 'OK',
    1: 'LEX_ERROR',
    2: 'PARSE_ERROR',
    3: 'UNKNOWN_TYPE',
    4: 'INVALID_PARAM',
    5: 'INVALID_REF',
    6: 'INVALID_LAYOUT',
    7: 'INVALID_SPEC',
    8: 'INTERNAL_ERROR'
});

export function errorName(code) {
    return ERR_NAMES[code] ?? `UNKNOWN(${code})`;
}

/**
 * Plain-object envelope for every fallible public call. Construct via
 * the static factories `TupleResponse.ok(payload, messages?)` or
 * `TupleResponse.fail(errorCode, messages)`. The constructor itself
 * is left public for niche cases (mostly tests), but the factories
 * are the documented entry points: they normalise the messages
 * argument and pin the success / failure shape so a consumer's
 * `result.error === ERR.OK` branch works whether the response came
 * from inside the parser or from a consumer-built helper.
 */
export class TupleResponse {
    constructor({ error = ERR.OK, payload = null, messages = [] } = {}) {
        this.error = error;
        this.payload = payload;
        this.messages = messages;
    }

    static ok(payload, messages = []) {
        return new TupleResponse({ error: ERR.OK, payload, messages });
    }

    static fail(error, messages) {
        return new TupleResponse({
            error,
            payload: null,
            messages: TupleResponse._normalizeMessages(messages)
        });
    }

    /**
     * Coerces the `messages` argument into a string[]. Four input
     * shapes get special handling so callers don't have to pre-format:
     *
     *   - string[]         used as-is
     *   - Error            formatted as "Name: message" plus the stack
     *                      on the next line, so a thrown exception
     *                      passed in by accident still leaves a useful
     *                      trail
     *   - plain object     JSON.stringify'd so a caller passing
     *                      `fail(ERR.PARSE_ERROR, { code, msg })` keeps
     *                      the structured detail instead of seeing it
     *                      collapsed to "[object Object]". Falls back
     *                      to String() if the object can't be
     *                      serialised (circular refs, BigInt fields).
     *   - other primitives wrapped in [String(value)]
     */
    static _normalizeMessages(messages) {
        if (Array.isArray(messages)) return messages;
        if (messages instanceof Error) {
            const head = `${messages.name || 'Error'}: ${messages.message}`;
            return messages.stack ? [head, messages.stack] : [head];
        }
        if (messages !== null && typeof messages === 'object') {
            try {
                return [JSON.stringify(messages)];
            } catch (e) {
                // Circular ref, BigInt field, or any other value
                // JSON.stringify refuses. Surface a tagged message
                // naming the reason so the caller knows their
                // structured detail was lost in normalization
                // rather than seeing an opaque "[object Object]".
                const reason = e && e.message ? e.message : 'unserialisable value';
                return [`[unserialisable object: ${reason}]`];
            }
        }
        return [String(messages)];
    }

    isOk() {
        return this.error === ERR.OK;
    }
}

export class ParseError extends Error {
    constructor(code, message, line = 0, col = 0) {
        super(message);
        // Subclasses of Error don't inherit the `name` field
        // automatically, so we set it here. With this, stack traces
        // and `console.error` output read "ParseError: ..." instead of
        // a misleading "Error: ...".
        this.name = 'ParseError';
        this.code = code;
        this.line = line;
        this.col = col;
    }

    toMessage() {
        const prefix = this.line > 0
            ? `line ${this.line}${this.col > 0 ? `, col ${this.col}` : ''}: `
            : '';
        return prefix + this.message;
    }
}
