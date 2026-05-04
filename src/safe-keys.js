// Shared key-safety helpers. The package never lets caller-supplied
// names walk the JavaScript prototype chain, and never lets them land
// as keys on a plain object whose prototype slot would change as a
// result. Three names need both protections:
//
//   __proto__   the prototype-set shorthand on a plain object literal
//   prototype   reaches the constructor's prototype object
//   constructor reaches the constructor function itself
//
// Two surfaces share these names:
//
//   - Path lookups against host data (interpolate {path}, decorated
//     {binding} fragments, when= path resolution). resolveSafePath()
//     refuses to follow any of the names and returns undefined.
//   - Object writes where a parsed identifier becomes a property key
//     (control bindings -> __properties, named-text keys, color keys,
//     tooltip keys, named-object keys, option-source names). Callers
//     check assertSafeObjectKey() up front and turn a hit into a
//     ParseError with the offending source position.
//
// Keeping the rule in one file means the next reader finds one list
// and one helper, not three different copies that drift over time.
//
// Quick reference for the three read helpers exported below:
//
//   isReservedObjectKey(name)   — yes/no. The cheap test. Use when
//                                  you have the name and just need
//                                  the verdict.
//   safeGet(map, key)           — own-property lookup with the
//                                  reserved-name screen. Use for a
//                                  single-segment lookup against a
//                                  parser-internal map.
//   resolveSafePath(data, path) — multi-segment dotted-path walk
//                                  with the screen on every step.
//                                  Use when the input is a dotted
//                                  string the parser produced.

import { ParseError, ERR } from './tuple-response.js';

const RESERVED_INTERNAL = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * Read-only view of the reserved-key list. Exported so consumers can
 * inspect it (e.g. to grey out path-completion suggestions) but the
 * Proxy refuses add / delete / clear so the list itself can't be
 * widened or narrowed at runtime.
 *
 * Naming note. The same Set is re-exported from `expression.js`
 * under its older name `FORBIDDEN_PATH_SEGMENTS`. The two names
 * describe the same thing from two angles: this module sees the
 * Set as a list of keys that cannot land as object property names;
 * `expression.js` sees it as a list of segments a `when=` path
 * cannot follow. The consumer-facing surface in `index.js` exposes
 * the older `FORBIDDEN_PATH_SEGMENTS` name only, so a public-API
 * reader sees one name and one definition.
 */
export const RESERVED_OBJECT_KEYS = makeReadOnlySet(RESERVED_INTERNAL);

/** True when `name` is one of the prototype-walking reserved names. */
export function isReservedObjectKey(name) {
    return RESERVED_INTERNAL.has(name);
}

/**
 * Walk a dotted path through a plain data object and return the leaf
 * value (or `undefined` when the path doesn't resolve). Refuses to
 * follow any segment in {@link RESERVED_OBJECT_KEYS}, and only reads
 * own properties (no inherited members).
 *
 * @param {unknown} data           the host data object
 * @param {string[] | string} path dotted string or pre-split segments
 * @returns {unknown} the leaf value, or `undefined` on miss / forbidden
 */
export function resolveSafePath(data, path) {
    const parts = Array.isArray(path) ? path : String(path).split('.');
    let cur = data;
    for (const seg of parts) {
        if (RESERVED_INTERNAL.has(seg)) return undefined;
        if (cur == null || typeof cur !== 'object') return undefined;
        if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
        cur = cur[seg];
    }
    return cur;
}

/**
 * Read a single key off a plain-object map without walking the
 * prototype chain. Returns `undefined` for any reserved name
 * (`__proto__`, `prototype`, `constructor`) AND for any key that
 * isn't an own property of the map. Use at every read-side bracket
 * access on a model-owned dictionary keyed by user-supplied
 * identifiers (named text, named objects, tooltips, colors,
 * option-source value lists, container-parameter dispatch tables,
 * merged spec params).
 *
 * Pairs with the parse-time `assertSafeObjectKey` write screen and
 * the structural `Object.create(null)` shape used by every model
 * map. The combination is belt-and-suspenders: the map can't carry
 * an inherited entry (null prototype), the parser refuses to write
 * a reserved name (assertSafeObjectKey), and any read goes through
 * one own-property check (this helper). Three lines of defence,
 * one rule.
 *
 * @template V
 * @param {Record<string, V>} map
 * @param {string} key
 * @returns {V | undefined}
 */
export function safeGet(map, key) {
    if (map == null) return undefined;
    if (RESERVED_INTERNAL.has(key)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(map, key)) return undefined;
    return map[key];
}

/**
 * Throw `ParseError(INVALID_PARAM)` when `name` is a reserved key.
 * Callers use this at every site where a parsed identifier becomes a
 * persistent object property key. The error message names the
 * reserved name and the source position so the author can fix the
 * typo.
 *
 * @param {string} name      the proposed key
 * @param {string} role      what the key was for (e.g. "binding name", "color name")
 * @param {{line?: number, col?: number} | null} [loc]  Either a
 *   tokenizer token (which has `.line` / `.col`) or a plain
 *   `{line, col}` object. The optional chain handles both. Tests
 *   that synthesise a fake loc just pass `{line, col}`.
 */
export function assertSafeObjectKey(name, role, loc) {
    if (RESERVED_INTERNAL.has(name)) {
        throw new ParseError(
            ERR.INVALID_PARAM,
            `'${name}' is a reserved JavaScript object key and cannot be used as a ${role}`,
            loc?.line ?? 0, loc?.col ?? 0
        );
    }
}

function makeReadOnlySet(target) {
    const blocked = new Set(['add', 'delete', 'clear']);
    return new Proxy(target, {
        get(t, prop) {
            if (blocked.has(prop)) {
                return () => {
                    throw new TypeError(
                        `RESERVED_OBJECT_KEYS is read-only; '${String(prop)}' is not allowed`
                    );
                };
            }
            const value = Reflect.get(t, prop, t);
            return typeof value === 'function' ? value.bind(t) : value;
        },
        set() {
            throw new TypeError('RESERVED_OBJECT_KEYS is read-only');
        },
        deleteProperty() {
            throw new TypeError('RESERVED_OBJECT_KEYS is read-only');
        }
    });
}
