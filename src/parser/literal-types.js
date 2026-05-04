// Shared rules for typed literal values. Two parse paths route
// through `defaultMatchesType`:
//
//   - The block-side __properties default check (parse-blocks).
//     Each entry like `{ type: "int", default: 0 }` has its
//     declared type compared against the literal default the
//     author wrote.
//   - The control-side `init=` literal hoist (parse-controls).
//     When a control declares a binding type via `{name:int}`, the
//     `init=42` literal is checked against that type so a typo
//     (`init="abc"` against an int binding) fires at parse time.
//
// One rule, one error vocabulary, no drift across the two surfaces.
//
// String literals are JavaScript strings, which are full Unicode.
// `typeof value === 'string'` accepts ASCII, umlauts, emoji, CJK,
// or anything else the source can hold. The validator does not
// restrict the alphabet of a string default beyond "is a string."
//
// Null defaults are rejected for all five known types. The
// vocabulary doesn't have a "nullable" qualifier in v1: a
// `__properties` entry that needs to express "absent" uses the
// type's zero value (`""`, `0`, `false`, `[]`) rather than `null`.
// A `default: null` against any of the five known types raises
// `expected X, got null` so the author either picks the zero value
// or moves to a custom type the parser doesn't validate. The
// custom-type fallback at the bottom of the switch is what makes
// "I really do want null here" expressible — declare the entry
// with `type: "nullable-int"` (or any name outside the five) and
// the parser leaves it alone.

/**
 * Returns null when `value` matches the declared `type`, or a short
 * reason string otherwise. Returns null for any type outside the
 * five known names so consumer-defined types ("uuid",
 * "durationSeconds", and so on) are not falsely rejected.
 *
 * Known types:
 *   - "int"      Number.isInteger
 *   - "float"    typeof === 'number' (covers ints too)
 *   - "bool"     typeof === 'boolean'
 *   - "string"   typeof === 'string' (any Unicode content)
 *   - "string[]" Array of strings (no nesting; type system is flat)
 *
 * @param {string} type
 * @param {unknown} value
 * @returns {string | null}
 */
export function defaultMatchesType(type, value) {
    switch (type) {
        case 'int':
            // Plain integer literal is the canonical case. A
            // quoted-string literal whose contents parse as an
            // integer is also accepted — common in hand-written
            // __properties blocks where the author keeps every
            // default as a quoted string for readability ("50",
            // "30"). The call site is expected to run coerceLiteral
            // after validation so the AST stores the canonical
            // number form regardless of which surface form the
            // author wrote.
            if (Number.isInteger(value)) return null;
            if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return null;
            return `expected integer, got ${describeValue(value)}`;
        case 'float':
            if (typeof value === 'number') return null;
            if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim())) return null;
            return `expected number, got ${describeValue(value)}`;
        case 'bool':
            return typeof value === 'boolean' ? null : `expected boolean, got ${describeValue(value)}`;
        case 'string':
            return typeof value === 'string' ? null : `expected string, got ${describeValue(value)}`;
        case 'string[]':
            if (!Array.isArray(value)) return `expected array, got ${describeValue(value)}`;
            for (const v of value) {
                if (typeof v !== 'string') return `expected array of strings, got element ${describeValue(v)}`;
            }
            return null;
        default:
            return null;       // custom type; consumer's vocabulary, not the parser's
    }
}

/**
 * Canonicalise a literal value against its declared type. A
 * numeric-string default (`default: "50"` for an int) gets
 * converted to the number form so the AST stores one shape per
 * type. Pass-through for everything else, including custom types
 * the parser doesn't validate. Should be called only AFTER
 * `defaultMatchesType` returns null — coerceLiteral does not
 * re-validate.
 *
 * @param {string} type
 * @param {unknown} value
 * @returns {unknown}
 */
export function coerceLiteral(type, value) {
    if (type === 'int' && typeof value === 'string')   return parseInt(value.trim(), 10);
    if (type === 'float' && typeof value === 'string') return parseFloat(value.trim());
    return value;
}

/**
 * Short, human-readable description of a value's type, used by
 * `defaultMatchesType` to build error messages. Distinguishes null,
 * arrays, and the JS primitive names; deeper structure is collapsed
 * to "object."
 *
 * @param {unknown} value
 * @returns {string}
 */
export function describeValue(value) {
    if (value === null)       return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
}
