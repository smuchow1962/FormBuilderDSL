// TextFormBuilder is the public entry point. A consumer constructs one,
// hands it the DSL text plus an optional control spec (the data
// dictionary that says what each control type accepts), and calls
// parse(). The result is a TupleResponse whose payload is the form
// model AST.
//
// Rendering happens elsewhere. The consumer takes the AST returned
// here and walks it with their own component map. This class never
// touches the DOM, never holds the user's data object, and never
// stores a target element. See docs/architecture.md for the full
// reasoning.

import { runParse } from './parser.js';
import { defaultControlSpec, validateControlSpec } from './control-spec.js';
import { mergeProperties } from './property-collector.js';
import { TupleResponse, ERR } from './tuple-response.js';
import { isReservedObjectKey } from './safe-keys.js';

class TextFormBuilder {
    constructor(options = {}) {
        this.schemaText = options.schemaText ?? '';
        this.controlSpec = options.controlSpec ?? defaultControlSpec;
        // Optional input-length cap. Falls back to runParse's
        // DEFAULT_MAX_INPUT_LENGTH (1 MB) when omitted. A consumer
        // hosting untrusted DSL text should pin this to a tight
        // value; an admin tool editing trusted forms can raise it.
        this.maxInputLength = options.maxInputLength;
        // Optional container-nesting cap. Falls back to
        // MAX_NESTING_DEPTH (16) when omitted. A machine-generated
        // form that legitimately nests deeper can raise it; a
        // hostile-input pipeline can lower it.
        this.maxNestingDepth = options.maxNestingDepth;
    }

    setSchemaText(text) {
        this.schemaText = text;
    }

    // Add a custom control type to the spec, or replace one that's
    // already there. The returned TupleResponse tells the caller right
    // away if the spec is malformed, instead of letting the bad entry
    // sit until the next parse() call. On success the response is
    // error: ERR.OK with payload null. On rejection the response is
    // error: ERR.INVALID_SPEC, and the live controlSpec is left
    // exactly as it was before the call.
    registerControl(name, spec) {
        // Reject the prototype-walking JS reserved names up front. A
        // bare `this.controlSpec[name] = spec` would otherwise reach
        // Object.prototype's `__proto__` setter (bracket assignment
        // does not bypass it) and replace the spec's prototype slot.
        // The same hazard applies to `constructor` and `prototype`.
        // Symmetric with the parser-side check that rejects these
        // names as binding identifiers.
        if (isReservedObjectKey(name)) {
            return TupleResponse.fail(ERR.INVALID_SPEC, [
                `Control type '${name}' is a reserved JavaScript object key and cannot be registered`
            ]);
        }
        // Make a defensive copy whenever the live spec is the frozen
        // default OR any other frozen object the caller may have
        // handed in. Either case would throw on the assignment below
        // (ESM modules run in strict mode), so we copy first to keep
        // the public API forgiving of input hygiene. The copy is
        // shallow on purpose. Per-control entries get validated
        // against `candidate` below and we don't mutate them in
        // place; only the top-level keys and the __common block need
        // a fresh wrapper.
        //
        // Depth dependency: `__common` today carries one field,
        // `params`. The copy below clones `__common` itself but not
        // its `params` map. If a future addition to `__common`
        // introduces nested mutable state (per-control hooks, a
        // `description` block with sub-fields), this copy needs to
        // recurse one more level — otherwise `registerControl` on a
        // frozen default would mutate state shared with the
        // unmutated default.
        if (this.controlSpec === defaultControlSpec || Object.isFrozen(this.controlSpec)) {
            this.controlSpec = { ...this.controlSpec, __common: { ...this.controlSpec.__common } };
        }
        // Validate the candidate spec (the live spec plus the proposed
        // new entry). Validating the candidate, not the live spec, is
        // what lets us reject without leaving the caller in a half-
        // applied state.
        const candidate = { ...this.controlSpec, [name]: spec };
        const errors = validateControlSpec(candidate);
        if (errors.length > 0) {
            return TupleResponse.fail(ERR.INVALID_SPEC, errors);
        }
        this.controlSpec[name] = spec;
        return TupleResponse.ok(null);
    }

    // Parse the schemaText into an AST. Returns a TupleResponse:
    //   .error     0 on success, one of ERR.* otherwise
    //   .payload   the form model AST on success, null on failure
    //   .messages  diagnostic strings (errors and warnings)
    parse() {
        return runParse(this.schemaText, this.controlSpec, {
            maxInputLength: this.maxInputLength,
            maxNestingDepth: this.maxNestingDepth
        });
    }

    // Parse, then merge the form's discovered properties into the
    // __properties dictionary on the AST. Returns the same
    // TupleResponse shape as parse(); on success the merged
    // dictionary lives at payload.__properties.
    //
    // Merge model:
    //
    //   - The DSL's `__properties = [...]` block (if any) is the
    //     starting state. If absent, the start is `{}`. Either way
    //     the parser writes the merged result back to
    //     payload.__properties.
    //   - Each control with an eligible binding either ADDS a new
    //     entry (binding name not in the existing dict) or merges
    //     into the existing entry.
    //   - When the discovery's TYPE differs from the existing type,
    //     the discovery wins. The change is recorded.
    //   - When the control carries an explicit `init=` literal whose
    //     value differs from the existing default, the discovery
    //     wins. The change is recorded.
    //   - Without an explicit `init=`, the existing default is
    //     preserved (the author's intent for the empty case is
    //     respected).
    //
    // Round-trip story:
    //
    //   - The merged dictionary on the AST is what the consumer
    //     writes back to source. The next parse sees those values
    //     and reports an empty change list. Round trips are stable.
    //   - The change list rides out as a non-enumerable
    //     `__propertyChanges` array on the payload (so JSON dumps
    //     stay clean) and as human-readable strings appended to
    //     `result.messages`.
    //
    // process() re-parses on every call. AST walks are NEVER cached
    // in this package; see docs/architecture-no-ast-caching.md for
    // the full rule. There is no `processFromAst(ast)` shortcut, no
    // memoization layer, no "fast path" that detects the source has
    // not changed. A consumer that wants result caching wraps the
    // builder themselves; the package gives one straight answer per
    // call and the caller decides how often to call.
    process() {
        const result = this.parse();
        if (result.error !== ERR.OK) return result;
        // The merge step runs the property-collector walk and
        // attaches change metadata. It SHOULD never throw on a
        // well-formed AST, but a future edit could land an
        // exception inside the walk. Wrap it the same way runParse
        // wraps the parse step so a consumer's `result.error`
        // branch covers both code paths uniformly. Without the
        // wrap, an exception here would escape past TupleResponse
        // and break the "always returns an envelope" contract.
        try {
            const existing = result.payload.__properties;
            const { properties, changes } = mergeProperties(result.payload, existing);
            result.payload.__properties = properties;
            if (changes.length > 0) {
                Object.defineProperty(result.payload, '__propertyChanges', {
                    value: Object.freeze(changes.slice()),
                    enumerable: false,
                    configurable: true,
                    writable: false
                });
                const formatted = changes.map(formatChange);
                return TupleResponse.ok(result.payload, [...result.messages, ...formatted]);
            }
            return result;
        } catch (e) {
            const name = e?.name ?? 'Error';
            const msg  = e?.message ?? String(e);
            return TupleResponse.fail(ERR.INTERNAL_ERROR, [
                `process(): ${name}: ${msg}`
            ]);
        }
    }

    // Validate the control spec on its own, without parsing any
    // schema text. Useful for verifying a hand-written spec at
    // startup before any user input flows through it.
    validateSchema() {
        const errors = validateControlSpec(this.controlSpec);
        if (errors.length === 0) return TupleResponse.ok(null);
        return TupleResponse.fail(ERR.INVALID_SPEC, errors);
    }
}

function formatChange(c) {
    if (c.kind === 'type') {
        return `__properties['${c.name}']: type changed from '${c.from}' to '${c.to}' (form discovery overwrites declared type).`;
    }
    return `__properties['${c.name}']: default changed from ${formatDefaultValue(c.from)} to ${formatDefaultValue(c.to)} (init= literal on the control overwrites declared default).`;
}

// Default values from a parser-produced AST are scalars or string[]
// (per ALLOWED_DATA_TYPES) and JSON.stringify cleanly. A consumer-
// supplied `existing` __properties dictionary, however, can hand in
// a value JSON.stringify cannot serialise (BigInt, circular ref).
// This helper survives that case by falling back to a tagged
// `[unserialisable: <reason>]` form so the change message stays
// readable instead of crashing the success path.
function formatDefaultValue(v) {
    try {
        return JSON.stringify(v);
    } catch (e) {
        const reason = e && e.message ? e.message : 'unserialisable value';
        return `[unserialisable: ${reason}]`;
    }
}

export { TextFormBuilder };
