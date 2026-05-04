// interpolate(text, data, functions, options?)
//
// Substitutes two kinds of placeholder in `text`:
//
//   {path}       reads the named field from the `data` object.
//                Dotted paths are supported: {customer.name} reads
//                data.customer.name.
//   {@fnName}    looks up `fnName` in the `functions` registry and
//                calls it with `data`. The returned value is converted
//                to a string and substituted into the text.
//
// Used by the renderer for tooltip text and by any consumer that wants
// the same lightweight templating.
//
// Default behaviour is lenient: when a placeholder doesn't resolve, the
// raw `{placeholder}` text stays in the output. The visible placeholder
// makes typos easy to spot rather than silently producing an empty
// string. Pass `{ strict: true }` as the fourth argument to throw
// instead. Strict mode throws on a missing data field, an unknown
// function, a function that returns null/undefined, or a function that
// throws on its own.
//
// Lenient mode treats `undefined` and explicit `null` the same way:
// both render the literal `{placeholder}` text. The rule matches
// renderFragments() in text-fragment.js so a decorated label and a
// templated tooltip tell the same story about a missing-or-null
// value. A consumer who really wants the empty case to render as
// the empty string passes an empty string in the data, not null.
//
// A function that throws is treated the same as a function that's
// missing. Both leave the literal `{@name}` in the output. Strict
// mode rethrows the original error so the caller sees what failed;
// lenient mode swallows it on purpose so a single bad function
// doesn't tear down the whole rendered string.
//
// Trust note. `{path}` lookups go through the shared safe walker
// (`safe-keys.resolveSafePath`). It refuses to follow `__proto__`,
// `prototype`, or `constructor`, and only reads own properties on
// each step. This matches `evaluateWhen`'s rule, so the two
// templating surfaces share one trust story (see
// `docs/expression-trust.md`). A consumer pointing this at a richer
// host object than a plain dictionary still won't reach the
// prototype chain by way of a placeholder.

import { ParseError, ERR } from './tuple-response.js';
import { isReservedObjectKey } from './safe-keys.js';
import { resolvePlaceholder } from './placeholder.js';

// Each path segment must be a non-empty identifier; segments are
// joined by single dots. Same shape as text-fragment.PATH_RX and
// expression.RX.ident so the three text surfaces share one
// path-shape rule. So `{a}`, `{a.b}`, `{@registry.fn}` work; `{a..b}`,
// `{a.}`, `{.a}` do not match the placeholder, and the literal
// braces stay in the output (lenient) or surface as a missing
// placeholder (strict).
const PLACEHOLDER = /\{(?<at>@?)(?<name>[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\}/g;

/**
 * @param {string | null | undefined} text
 * @param {Record<string, unknown>} [data]
 * @param {Record<string, (data: Record<string, unknown>) => unknown>} [functions]
 * @param {{ strict?: boolean }} [options] When `strict: true`, an unresolved
 *   placeholder throws instead of staying in the output. The strict throw
 *   covers five cases: a `{path}` whose data field is `undefined`; a `{path}`
 *   whose data field is `null` (treated the same as missing); a `{@fn}` whose
 *   function is not registered; a `{@fn}` whose function returned
 *   `null`/`undefined`; a `{@fn}` whose function threw (the original error
 *   rethrows). Lenient mode (the default) leaves the literal `{placeholder}`
 *   in the output for each of those cases.
 *
 * Reserved-segment placeholders (`{__proto__}`, `{constructor}`,
 * `{prototype}`, `{a.__proto__.b}`, `{@constructor}`, etc.) are
 * rejected at parse time with `ParseError(PARSE_ERROR)`, regardless
 * of strict / lenient mode. The same rule fires in `parseDecorated`
 * for the same identifiers so the two text surfaces share one
 * fail-fast policy: a placeholder that names a reserved segment
 * is a typo or an attack and never reaches the substitution loop.
 *
 * Resolution is delegated to `placeholder.resolvePlaceholder`, the
 * same core text-fragment.fragmentToText calls. Both helpers share
 * one regex shape (above), one trust story, one set of strict-mode
 * messages, and one lenient fallback for the runtime miss cases.
 *
 * @throws {ParseError} (code: PARSE_ERROR) when a placeholder names
 *         a reserved segment.
 */
export function interpolate(text, data = {}, functions = {}, options = {}) {
    const strict = Boolean(options && options.strict);
    if (text == null) return '';
    const src = String(text);

    // Fail-fast pre-scan. Walk every placeholder match once before
    // substitution begins; if any segment is reserved, throw before
    // emitting any output. The scan uses the same regex as the
    // substitution pass so the two stages agree on what counts as a
    // placeholder.
    //
    // PLACEHOLDER is a module-level /g regex shared between this
    // pre-scan loop and the String.replace call below. The reset
    // here is the load-bearing safe-state restore: if a future
    // edit lets the loop body throw before exec returns null,
    // PLACEHOLDER.lastIndex would be left non-zero between calls,
    // and the next interpolate() call would skip placeholders
    // before that index. The only thing the loop body can throw
    // today is the ParseError below — `isReservedObjectKey` is a
    // pure Set lookup that cannot throw — so the invariant holds.
    // Do not throw inside the exec loop without resetting
    // lastIndex in a finally.
    PLACEHOLDER.lastIndex = 0;
    let m;
    while ((m = PLACEHOLDER.exec(src)) !== null) {
        const { at, name } = m.groups;
        for (const seg of name.split('.')) {
            if (isReservedObjectKey(seg)) {
                const tag = at === '@' ? `'@${name}'` : `'{${name}}'`;
                throw new ParseError(
                    ERR.PARSE_ERROR,
                    `${tag} contains reserved name '${seg}'; cannot be a ${at === '@' ? 'function' : 'data'} binding`,
                    0, 0
                );
            }
        }
    }

    return src.replace(PLACEHOLDER, (full, _at, _name, _offset, _src, groups) => {
        const { at, name } = groups;
        return resolvePlaceholder(
            { name, isFunction: at === '@' },
            { data, functions, strict, literalPlaceholder: () => full }
        );
    });
}
