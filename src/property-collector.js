// Property collection for the mmpform document processor.
//
// collectProperties(ast) walks the AST and returns the dictionary
// that process() attaches as `ast.__properties`. Every `{name}` or
// `{name:type}` binding on a control becomes one entry, shaped
// `{ type, default }`. Consumers like sinks and dashboards read the
// dictionary to know two things: what data shape the form expects,
// and what initial values it should start with.
//
// Type resolution per binding (most specific wins):
//
//   1. Inline `:type` on the binding itself: `{name:int}`
//   2. The control's `__dataType` override: applies to any binding
//      on that control unless the binding has its own `:type`
//   3. DEFAULT_DATA_TYPE_BY_CONTROL[controlType]: the per-control
//      fallback (textfield is string, check is bool, etc.)
//
// Default resolution per binding (most specific wins):
//
//   1. The control's `init=` literal: `init="hello"`, `init=42`,
//      `init=true`
//   2. The zero value for the resolved type:
//        int / float -> 0
//        bool        -> false
//        string      -> ""
//        string[]    -> []
//
//      Init forms that point at a binding (`init={someField}`) or a
//      function (`init={@compute}`) have no static value at parse
//      time. They fall through to the zero rule above.
//
// Bindings that don't match the documented `\w+(:\w+)?` shape are
// skipped on purpose. Dotted paths like `customer.name`, function
// bindings like `@compute`, and `this.x` references inside a
// repeater all live somewhere other than the flat property bag.

import { DEFAULT_DATA_TYPE_BY_CONTROL } from './control-spec.js';
import { isReservedObjectKey } from './safe-keys.js';
import { writeQuotedString } from './string-literal.js';
import { coerceLiteral } from './parser/literal-types.js';

const SIMPLE_NAME_RX = /^(?<name>\w+)$/;

function zeroValueForType(type) {
    if (type === 'int' || type === 'float')  return 0;
    if (type === 'bool')                     return false;
    if (type === 'string[]')                 return [];
    return '';                                                      // string and any unrecognised type
}

// Resolve a single control's emitted property type. Returns null when the
// control has no eligible binding (e.g. label, function binding, dotted
// path) so callers can skip the entry.
function resolveControlPropertyType(ctl) {
    if (!ctl.binding) return null;
    if (ctl.binding.startsWith('@')) return null;
    if (!SIMPLE_NAME_RX.test(ctl.binding)) return null;

    if (ctl.bindingType) return ctl.bindingType;
    if (ctl.dataType)    return ctl.dataType;

    const fallback = DEFAULT_DATA_TYPE_BY_CONTROL[ctl.controlType];
    return fallback ?? 'string';
}

// Pull a default value out of a control. Literal init wins; binding /
// function inits have no compile-time value, so they fall through to the
// type-based zero handled by the caller.
function resolveControlPropertyDefault(ctl, type) {
    if (ctl.init && ctl.init.kind === 'literal') {
        return ctl.init.value;
    }
    return zeroValueForType(type);
}

// Walk the AST and build { propertyName: { type, default } }. Does not mutate.
//
// The returned object has a null prototype. That's deliberate: a
// hand-built AST could in theory carry a binding named `__proto__`
// or `constructor` (the parser rejects those, but a consumer who
// constructs the AST themselves bypasses that check). Writing into
// a null-prototype object turns those names into normal own
// properties instead of mutating the prototype slot. The
// `isReservedObjectKey` skip below is defence in depth.
// Walks the AST every call. NEVER cached.
// See docs/architecture-no-ast-caching.md for the package-wide rule.
export function collectProperties(ast) {
    const properties = Object.create(null);
    if (!ast || !ast.root) return properties;

    const noteControl = (ctl) => {
        const type = resolveControlPropertyType(ctl);
        if (type == null) return;
        const name = ctl.binding;
        if (isReservedObjectKey(name)) return;
        const isExplicit = !!(ctl.bindingType || ctl.dataType || (ctl.init && ctl.init.kind === 'literal'));
        // Last writer wins on duplicates, but explicit choices (binding
        // `:type`, __dataType, or a literal init) outrank a plain
        // fallback so the dictionary lands on the most informative
        // entry. Conflicting explicit declarations are surfaced by
        // validateProperties.
        if (!(name in properties) || isExplicit) {
            properties[name] = { type, default: resolveControlPropertyDefault(ctl, type) };
        }
    };

    const visit = (node) => {
        if (!node) return;
        if (node.nodeKind === 'control') {
            noteControl(node);
            return;
        }
        if (node.nodeKind === 'row') {
            for (const c of node.controls) visit(c);
            return;
        }
        if (node.nodeKind === 'container'
         || node.nodeKind === 'repeater'
         || node.nodeKind === 'listManager') {
            for (const h of node.headerControls) visit(h);
            if (node.panels) for (const p of node.panels) for (const r of p.rows) visit(r);
            if (node.rows)   for (const r of node.rows) visit(r);
        }
    };

    visit(ast.root);
    return properties;
}

// Merge an existing __properties dictionary with what the parser
// discovers in the form, returning the merged dictionary plus a
// list of the changes the merge made.
//
// Rules:
//
//   1. Every key already in `existing` survives into the result.
//      A sink author who declared a property the form doesn't bind
//      (e.g. a sink-internal field) keeps it on the round trip.
//   2. A control whose binding is a fresh name lands as a new entry.
//      The discovery's type and default win. (Not recorded as a
//      change; new entries are discoveries, not overwrites.)
//   3. A control whose binding matches an existing entry but
//      resolves to a different type overwrites the existing type.
//      Recorded as `{ name, kind: 'type', from, to }`.
//   4. A control whose binding has an `init=` literal AND whose
//      literal value differs from the existing default overwrites
//      the existing default. Recorded as `{ name, kind: 'default',
//      from, to }`. Without an explicit `init=`, the discovery's
//      default is the type's zero value, and the existing default
//      is left alone (the author's intent wins for the empty case).
//
// The change list is what the consumer surfaces to the editor (so
// the author sees what the parser overwrote) AND what makes the
// round trip stable: writing the merged dictionary back to source
// means the next parse sees the same values and reports an empty
// change list.
export function mergeProperties(ast, existing) {
    const properties = Object.create(null);
    const changes = [];

    if (existing && typeof existing === 'object') {
        for (const [name, entry] of Object.entries(existing)) {
            if (isReservedObjectKey(name)) continue;
            if (!entry || typeof entry !== 'object') continue;
            properties[name] = { type: entry.type, default: entry.default };
        }
    }

    if (!ast || !ast.root) return { properties, changes };

    const visit = (node) => {
        if (!node) return;
        if (node.nodeKind === 'control') {
            mergeOne(node);
            return;
        }
        if (node.nodeKind === 'row') {
            for (const c of node.controls) visit(c);
            return;
        }
        if (node.nodeKind === 'container'
         || node.nodeKind === 'repeater'
         || node.nodeKind === 'listManager') {
            for (const h of node.headerControls) visit(h);
            if (node.panels) for (const p of node.panels) for (const r of p.rows) visit(r);
            if (node.rows)   for (const r of node.rows) visit(r);
        }
    };

    function mergeOne(ctl) {
        const type = resolveControlPropertyType(ctl);
        if (type == null) return;
        const name = ctl.binding;
        if (isReservedObjectKey(name)) return;
        const hasExplicitDefault = ctl.init != null && ctl.init.kind === 'literal';
        // Coerce the literal init value against the control-resolved
        // type. Without this, an `init="50"` on a [number] (resolved
        // type 'int') stays a string here and would override an
        // existing __properties entry whose default was already
        // coerced to the number 50 — flipping the canonical AST shape
        // back to a string and producing a stable-churn change record
        // on every Process pass.
        const explicitValue = hasExplicitDefault ? coerceLiteral(type, ctl.init.value) : undefined;

        if (!(name in properties)) {
            // New discovery: take the discovered type, plus the
            // explicit init value when present, the type zero
            // otherwise.
            properties[name] = {
                type,
                default: hasExplicitDefault ? explicitValue : zeroValueForType(type)
            };
            return;
        }

        const before = properties[name];
        let nextType = before.type;
        let nextDefault = before.default;
        let touched = false;

        if (before.type !== type) {
            changes.push({ name, kind: 'type', from: before.type, to: type });
            nextType = type;
            touched = true;
        }
        if (hasExplicitDefault && !defaultsEqual(before.default, explicitValue)) {
            changes.push({ name, kind: 'default', from: before.default, to: explicitValue });
            nextDefault = explicitValue;
            touched = true;
        }
        if (touched) {
            properties[name] = { type: nextType, default: nextDefault };
        }
    }

    visit(ast.root);
    return { properties, changes };
}

function defaultsEqual(a, b) {
    // JSON-equality is sufficient: defaults are scalars or string[]
    // (per ALLOWED_DATA_TYPES), and JSON.stringify is deterministic
    // enough for that shape. This avoids pulling in a deep-equal
    // dependency for a single use site.
    //
    // A consumer-supplied `existing` __properties dictionary may
    // hand in a value JSON.stringify cannot serialise (BigInt,
    // circular ref). Catch the throw and fall back to "not equal"
    // so the merge still progresses — the change list will record
    // the difference and formatChange's defensive serialiser will
    // produce a tagged message rather than crashing the success
    // path.
    let sa, sb;
    try { sa = JSON.stringify(a); } catch { return false; }
    try { sb = JSON.stringify(b); } catch { return false; }
    return sa === sb;
}

// Render a JS value as DSL text. Strings route through the symmetric
// writer in string-literal.js so a default that contains a newline,
// tab, or quote round-trips through `parse -> render -> parse`
// without losing or mutating its content. Numbers and booleans
// format as themselves; string[] renders as a square-bracket list.
function formatDefault(value) {
    if (typeof value === 'string')  return writeQuotedString(value);
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number')  return String(value);
    if (Array.isArray(value)) {
        return '[' + value.map(formatDefault).join(', ') + ']';
    }
    return 'null';
}

// Render a __properties dictionary as the canonical DSL block text the
// viewer writes back into the Source panel. Mirrors the tooltips/colors
// block style so the format reads consistently in the editor.
//
// Output is sorted by property name so a Process click produces the same
// text every time, regardless of map iteration order.
export function renderPropertiesBlock(properties, opts = {}) {
    const indent = opts.indent ?? '    ';
    const names = Object.keys(properties ?? {}).sort();
    if (names.length === 0) return '__properties = []';

    const lines = ['__properties = ['];
    names.forEach((name, i) => {
        const tail  = i < names.length - 1 ? ',' : '';
        const entry = properties[name];
        // Route name and type through writeQuotedString so a
        // consumer-supplied string containing `"` or `\` (or any
        // grammar-illegal byte) produces a clean error rather than
        // malformed DSL. In normal use both are parser-produced
        // identifiers and the call is a no-op encoding.
        const nameLit = writeQuotedString(name);
        const typeLit = writeQuotedString(entry.type);
        const def     = formatDefault(entry.default);
        lines.push(`${indent}${nameLit} = { type: ${typeLit}, default: ${def} }${tail}`);
    });
    lines.push(']');
    return lines.join('\n');
}

// `entriesEqual` is `defaultsEqual` plus a type-equality short-circuit.
// validateProperties calls this when both entries already exist; the
// type check makes the failure mode "wrong type" vs "wrong default"
// readable in the diagnostic message.
function entriesEqual(a, b) {
    if (a.type !== b.type) return false;
    return defaultsEqual(a.default, b.default);
}

// Validate that an AST carries a __properties dictionary covering every
// eligible control binding in its layout. Returns an empty array when
// the document is valid; otherwise returns one diagnostic per problem.
//
// Used both as a self-check (after process() runs) and as a contract
// check for ASTs supplied externally where __properties was hand-written
// or loaded from disk.
// Walks the AST every call. NEVER cached. The `expected = collectProperties(ast)`
// line below re-runs the full walk; that is intentional, not an
// optimization opportunity. See docs/architecture-no-ast-caching.md.
export function validateProperties(ast) {
    // Two failure cases need separate messages so a consumer
    // reporting errors knows whether the call was malformed
    // (no AST) or the AST was malformed (no root).
    if (!ast) return ['No AST provided'];
    if (!ast.root) return ['AST has no root container'];
    const props = ast.__properties;
    if (props == null || typeof props !== 'object' || Array.isArray(props)) {
        return ['Document is missing the __properties dictionary'];
    }

    const errors = [];
    const expected = collectProperties(ast);
    for (const [name, expectedEntry] of Object.entries(expected)) {
        // Own-property check. A caller might hand in a plain `{}`
        // dict whose prototype carries entries we don't want to
        // accidentally read. The collector-side dict has a null
        // prototype so `name in props` would be safe there, but
        // the contract here accepts any consumer-built dict.
        if (!Object.prototype.hasOwnProperty.call(props, name)) {
            errors.push(`__properties is missing entry for '${name}'`);
            continue;
        }
        const have = props[name];
        if (have == null || typeof have !== 'object' || Array.isArray(have)) {
            errors.push(`__properties['${name}'] must be an object with 'type' and 'default'`);
            continue;
        }
        if (have.type !== expectedEntry.type) {
            errors.push(`__properties['${name}'].type = '${have.type}' but layout requires '${expectedEntry.type}'`);
        }
        if (!entriesEqual(have, expectedEntry)) {
            // Only emit a default-mismatch diagnostic when the type
            // matched. If the types differ, the message just above
            // already covers the disagreement; piling another error
            // on top would double-report the same problem.
            if (have.type === expectedEntry.type) {
                errors.push(
                    `__properties['${name}'].default = ${JSON.stringify(have.default)} `
                    + `but layout requires ${JSON.stringify(expectedEntry.default)}`
                );
            }
        }
    }
    return errors;
}

/**
 * Compare two parsed forms and report what changed in their
 * inferred property dictionaries. The same shape `mergeProperties`
 * uses for `changes` on a single form, generalised to two ASTs.
 *
 * Three buckets:
 *   - `added`: bindings present in `astB` but not in `astA`.
 *   - `removed`: bindings present in `astA` but not in `astB`.
 *   - `changed`: bindings on both sides whose `type` or `default`
 *     differs. Each entry names what changed and from what value.
 *
 * Useful for "what changed in this revision" tooling: a sink
 * author seeing a diff between today's form and yesterday's, a
 * migration tool generating a property-rename script, an editor
 * surfacing "you removed a binding that the database still has."
 *
 * @param {object | null | undefined} astA  the "before" parse result
 * @param {object | null | undefined} astB  the "after" parse result
 * @returns {{
 *   added: Array<{ name: string, type: string, default: unknown }>,
 *   removed: Array<{ name: string, type: string, default: unknown }>,
 *   changed: Array<{ name: string, kind: 'type' | 'default', from: unknown, to: unknown }>
 * }}
 */
export function diffSchemas(astA, astB) {
    const a = collectProperties(astA);
    const b = collectProperties(astB);
    const added = [];
    const removed = [];
    const changed = [];
    for (const [name, entry] of Object.entries(b)) {
        if (!(name in a)) {
            added.push({ name, type: entry.type, default: entry.default });
            continue;
        }
        const prev = a[name];
        if (prev.type !== entry.type) {
            changed.push({ name, kind: 'type', from: prev.type, to: entry.type });
        }
        if (!defaultsEqual(prev.default, entry.default)) {
            changed.push({ name, kind: 'default', from: prev.default, to: entry.default });
        }
    }
    for (const [name, entry] of Object.entries(a)) {
        if (!(name in b)) {
            removed.push({ name, type: entry.type, default: entry.default });
        }
    }
    return { added, removed, changed };
}
