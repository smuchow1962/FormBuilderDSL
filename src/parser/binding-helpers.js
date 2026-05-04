// Two helpers used across more than one grammar file. They live here
// so a contributor opening any of the parse-*.js files can find them
// in one place instead of jumping around.

import { T } from '../tokenizer.js';
import { ParseError, ERR } from '../tuple-response.js';
import { assertSafeObjectKey } from '../safe-keys.js';

/**
 * Read a binding-path body from inside a `{...}` brace pair. The
 * opening LCURLY is the caller's responsibility; this function
 * starts after it and reads up to (but not including) the RCURLY.
 *
 * Three shapes are accepted:
 *
 *   {field}                     -> ['field']
 *   {field.subfield.deeper}     -> ['field', 'subfield', 'deeper']
 *   {@functionName}             -> ['@functionName']
 *   {@registry.subFn}           -> ['@registry.subFn']  (dotted, joined back)
 *
 * The leading `@` survives in the returned path so the caller can
 * tell a function reference apart from a data path with a single
 * `path.startsWith('@')` check. Dotted function names like
 * `@math.add` resolve against the consumer's function registry as a
 * single key (`functions['math.add']`), matching the rule used by
 * `interpolate` and `parseDecorated` so the three surfaces share one
 * function-lookup grammar.
 */
export function parseBindingPath(tk) {
    if (tk.peek().kind === T.AT) {
        const at = tk.next();
        const firstTok = tk.expect(T.IDENT);
        // `this` is reserved across the language. A function binding
        // named `@this` has no meaning (the function registry is keyed
        // by name, and `this` is a binding-context word in the
        // repeater grammar, not a function-registry key). Reject it
        // up front with a clear message rather than letting it parse
        // and then mystify the renderer.
        if (firstTok.value === 'this') {
            throw new ParseError(
                ERR.INVALID_PARAM,
                `'@this' is not a valid function binding; 'this' is reserved (use 'this.field' inside a repeater for the current item's field, or pick a real function name)`,
                firstTok.line ?? at.line, firstTok.col ?? at.col
            );
        }
        // Function-name segments share the prototype-key check too:
        // `@constructor`, `@__proto__` are rejected at parse time so
        // a downstream consumer doesn't have to learn the rule.
        assertSafeObjectKey(firstTok.value, `function binding name`, firstTok);
        const fnParts = [firstTok.value];
        while (tk.accept(T.DOT)) {
            const segTok = tk.expect(T.IDENT);
            assertSafeObjectKey(segTok.value, `function binding segment`, segTok);
            fnParts.push(segTok.value);
        }
        return ['@' + fnParts.join('.')];
    }
    // Data path. Every segment lands as a key on the collected
    // __properties dictionary or as a step in resolveSafePath. The
    // prototype-walking names (`__proto__`, `prototype`,
    // `constructor`) are rejected here so every binding-path
    // producer in the parser shares one screening rule. Without this
    // check, the asymmetry would force every read-side consumer to
    // re-screen on its own.
    const firstTok = tk.expect(T.IDENT);
    assertSafeObjectKey(firstTok.value, `binding name`, firstTok);
    const parts = [firstTok.value];
    while (tk.accept(T.DOT)) {
        const segTok = tk.expect(T.IDENT);
        assertSafeObjectKey(segTok.value, `binding segment`, segTok);
        parts.push(segTok.value);
    }
    return parts;
}

/**
 * Defer the parsing of a label string until phase 2.
 *
 * Phase 1 records the raw text plus the AST node it belongs to.
 * Phase 2 (rewriteTextToFragments) walks every recorded label,
 * parses it into TextFragment[] using the now-complete colors map,
 * and writes the result back onto the owner's `label` field.
 *
 * The placeholder empty array on `owner.label` keeps any consumer
 * that reads the AST mid-build from tripping over `undefined`.
 */
export function collectLabel(state, owner, raw, line) {
    owner.label = [];
    state.pendingLabels.push({ owner, raw, line });
}
