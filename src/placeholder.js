// Shared placeholder-resolution core. One function decides what the
// text for a `{path}` or `{@fn}` placeholder should be; both
// `interpolate` (string-template) and `text-fragment.fragmentToText`
// (TextFragment binding/function fragment) call it. The two
// surfaces share one regex shape, one trust story, one set of
// strict-mode error messages, and one lenient fallback so a
// consumer who debugs one surface knows what the other will say.
//
// Trust story (matches docs/expression-trust.md):
//
//   - `{path}` lookups go through `resolveSafePath`, which refuses
//     `__proto__` / `prototype` / `constructor` segments and only
//     reads own properties on each step.
//   - `{@fn}` lookups are own-property only on `functions`, so
//     `{@constructor}` and `{@toString}` never reach
//     `Object.prototype` members.
//
// Lenient mode (the default) returns the literal placeholder text
// for every miss case (undefined data, null data, missing function,
// function returned null/undefined, function threw). The visible
// placeholder makes typos easy to spot rather than silently
// producing an empty string.
//
// Strict mode throws an `Error` for the same five cases. The error
// messages are uniform across both call sites:
//
//   - "missing data for {path}"
//   - "no function registered for {@name}"
//   - "{@name} returned null or undefined"
//   - the original error rethrown when the function threw
//
// Lenient/strict behaviour matches: a function that throws still
// rethrows the original under strict; lenient swallows it on
// purpose so a single bad function doesn't tear down the whole
// rendered string.

import { resolveSafePath, isReservedObjectKey } from './safe-keys.js';

/**
 * Resolve one placeholder.
 *
 * @param {{ name: string, isFunction: boolean }} placeholder
 *   `name` is the dotted identifier captured from the source text.
 *   `isFunction` is true when the placeholder was `{@name}`.
 * @param {object} ctx
 * @param {Record<string, unknown>} ctx.data       caller-supplied host data
 * @param {Record<string, (data: any) => unknown>} ctx.functions  function registry
 * @param {boolean} ctx.strict                     true to throw on misses
 * @param {(name: string, isFunction: boolean) => string} ctx.literalPlaceholder
 *   returns the text the lenient miss-path should render. Both
 *   call sites format the literal as `{name}` or `{@name}`; they
 *   pass their own formatter so the helper stays free of string
 *   concatenation policy.
 * @returns {string} the resolved text (or the literal placeholder in
 *   lenient mode on a miss).
 */
export function resolvePlaceholder(placeholder, ctx) {
    const { name, isFunction } = placeholder;
    const { data, functions, strict, literalPlaceholder } = ctx;
    const lit = literalPlaceholder(name, isFunction);

    if (isFunction) {
        // Own-property check on `functions`. Without it,
        // `{@constructor}` and `{@toString}` would resolve to
        // Object.prototype members.
        const fn = Object.prototype.hasOwnProperty.call(functions ?? {}, name)
            ? functions[name]
            : undefined;
        if (typeof fn !== 'function') {
            if (strict) throw new Error(`no function registered for {@${name}}`);
            return lit;
        }
        let result;
        try {
            result = fn(data);
        } catch (e) {
            if (strict) throw e;
            return lit;
        }
        if (result == null) {
            if (strict) throw new Error(`{@${name}} returned null or undefined`);
            return lit;
        }
        return String(result);
    }

    // Data-path placeholder. Reserved segments are normally caught
    // upstream: interpolate's pre-scan and parseDecorated's per-
    // fragment check both throw ParseError(PARSE_ERROR) before any
    // fragment with a reserved segment reaches this function. The
    // check below is a defence-in-depth catcher for hand-built
    // fragment arrays passed straight to renderFragments without
    // going through parseDecorated. Treats the case as a miss
    // (strict throws, lenient renders the literal) rather than a
    // hard error so a synthetic fragment list does not crash the
    // renderer.
    if (containsReservedSegment(name)) {
        if (strict) throw new Error(`missing data for {${name}}`);
        return lit;
    }
    const value = resolveSafePath(data ?? {}, name);
    // Loose null check catches both undefined and null. The two
    // aren't distinguished here, matching the lenient-mode rule for
    // both surfaces. A consumer who wants the empty case to render
    // visibly puts an empty string in the data, not null.
    if (value == null) {
        if (strict) throw new Error(`missing data for {${name}}`);
        return lit;
    }
    return String(value);
}

function containsReservedSegment(dottedName) {
    for (const seg of dottedName.split('.')) {
        if (isReservedObjectKey(seg)) return true;
    }
    return false;
}
