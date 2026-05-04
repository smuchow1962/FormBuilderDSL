// Control declarations and per-parameter coercion. Two public
// entry points:
//
//   parseRowItems(state, tk, row, line)
//     Read one or more `[decl]` items off the line into the row.
//     A row can hold multiple control declarations or one
//     container declaration (which gets its own body parsed by
//     parse-containers.js).
//
//   parseControlDecl(state, tk, line, opts?)
//     Read one `[type(...)]` declaration into a ControlNode.
//
// The per-control parameter coercion (`integer`, `string`,
// `expression`, `init`, etc.) lives at the bottom in
// parseTypedValue.

import { ParseError, ERR } from '../tuple-response.js';
import { T } from '../tokenizer.js';
import { lookupType } from '../control-spec.js';
import { parseWhen } from '../expression.js';
import { parseBindingPath, collectLabel } from './binding-helpers.js';
import { parseContainerDecl } from './parse-containers.js';
import { safeGet, assertSafeObjectKey } from '../safe-keys.js';
import { defaultMatchesType, coerceLiteral } from './literal-types.js';

export function parseRowItems(state, tk, row, line) {
    while (tk.peek().kind === T.LBRACKET) {
        const lookahead = tk.peek(1);
        const isContainer = (lookahead.kind === T.GT)
            || (lookahead.kind === T.IDENT
                && (lookahead.value === 'container'
                    || lookahead.value === 'repeater'
                    || lookahead.value === 'listManager'));

        if (isContainer) {
            const c = parseContainerDecl(state, tk, line);
            row.controls.push(c);
            // A row carries at most one container, and everything
            // past the container's closing `]` is its label text.
            // Stop reading items here.
            break;
        }

        const ctl = parseControlDecl(state, tk, line);
        row.controls.push(ctl);
    }
}

export function parseControlDecl(state, tk, line, opts = {}) {
    tk.expect(T.LBRACKET);
    const typeIdent = tk.expect(T.IDENT);
    const typeName = typeIdent.value;

    if (typeName === 'container' || typeName === 'repeater' || typeName === 'listManager') {
        throw new ParseError(
            ERR.PARSE_ERROR,
            `'${typeName}' is structural and cannot be used as a control here`,
            typeIdent.line, typeIdent.col
        );
    }

    const policy = lookupType(state.spec, typeName);
    if (!policy) {
        throw new ParseError(
            ERR.UNKNOWN_TYPE,
            `Unknown control type '${typeName}'`,
            typeIdent.line, typeIdent.col
        );
    }

    const ctl = {
        nodeKind: 'control',
        controlType: typeName,
        width: null,
        binding: null,
        bindingType: null,             // explicit `:type` from `{name:type}`; null if absent
        dataType: null,                // hoisted `__dataType=` override; null if absent
        optionsSource: null,
        contentRef: null,              // #name to a named-text entry (label / display)
        params: {},
        secret: policy.secret,
        readOnly: policy.readOnly,
        when: null,
        whenAst: null,
        tooltipRef: null,
        init: null,                    // { kind:'literal'|'binding'|'function', ... } | null
        compute: null,                 // { kind:'function', name }, reactive value computation
        explain: [],                   // TextFragment[] for collapsible help below the control
        label: [],                     // TextFragment[], filled in during phase 2
        loc: { line: typeIdent.line, col: typeIdent.col, length: 0 }
        // Note: `_rawExplain` is NOT initialised here. It is set by
        // the explain= hoist below, only when the source declares
        // an explain= value, and phase 2 deletes it before the AST
        // is handed back. Initialising it here would leak a
        // `_rawExplain: null` field on every control in the public
        // AST, which the type declaration does not promise.
    };

    if (tk.accept(T.LPAREN)) {
        // typeIdent passes through for future per-control diagnostics;
        // current params don't reference the control's source token but
        // a future param-spec extension might want to point error
        // messages back at the control name.
        parseControlParams(tk, ctl, policy, state, typeIdent);
        tk.expect(T.RPAREN);
    }

    tk.expect(T.RBRACKET);

    // Apply width policy.
    if (ctl.width == null) {
        if (policy.widthPolicy === 'required') {
            throw new ParseError(
                ERR.INVALID_PARAM,
                `Control '${typeName}' requires a width`,
                typeIdent.line, typeIdent.col
            );
        }
        if (typeof policy.widthPolicy === 'object' && 'default' in policy.widthPolicy) {
            ctl.width = policy.widthPolicy.default;
        }
    }

    // Apply binding policy.
    if (policy.binding === 'required' && ctl.binding == null) {
        throw new ParseError(
            ERR.INVALID_PARAM,
            `Control '${typeName}' requires a binding`,
            typeIdent.line, typeIdent.col
        );
    }
    if (policy.binding === 'forbidden' && ctl.binding != null) {
        throw new ParseError(
            ERR.INVALID_PARAM,
            `Control '${typeName}' must not have a binding`,
            typeIdent.line, typeIdent.col
        );
    }

    // Apply options-ref policy.
    if (policy.optionsRef === 'required' && ctl.optionsSource == null) {
        throw new ParseError(
            ERR.INVALID_PARAM,
            `Control '${typeName}' requires an options reference (#name)`,
            typeIdent.line, typeIdent.col
        );
    }
    if (policy.optionsRef === 'forbidden' && ctl.optionsSource != null) {
        throw new ParseError(
            ERR.INVALID_PARAM,
            `Control '${typeName}' must not have an options reference`,
            typeIdent.line, typeIdent.col
        );
    }

    // Apply param defaults.
    for (const [name, paramSpec] of Object.entries(policy.params)) {
        if (!(name in ctl.params) && 'default' in paramSpec) {
            ctl.params[name] = paramSpec.default;
        }
    }

    // Hoist universal params out of the params bag for AST clarity.
    // Each of these names is reserved across every control type; the
    // AST node has dedicated fields so renderers don't have to dig
    // through `params` to find them.
    if ('when' in ctl.params) {
        ctl.when = ctl.params.when;
        ctl.whenAst = ctl.when ? parseWhen(ctl.when) : null;
        delete ctl.params.when;
    }
    if ('tt' in ctl.params) {
        ctl.tooltipRef = ctl.params.tt;
        delete ctl.params.tt;
    }
    if ('init' in ctl.params) {
        ctl.init = ctl.params.init;   // null | { kind:'literal'|'binding'|'function', ... }
        delete ctl.params.init;
        // Type-check a literal init= against the declared binding
        // type. Block-side __properties defaults run the same rule
        // (parse-blocks.js calls defaultMatchesType for `{ type:
        // "int", default: ... }`); doing the same on init= keeps
        // the two literal-vs-type paths in sync. A typo like
        // `{count:int}` paired with `init="abc"` fires here at
        // parse time instead of mismatching at render time. The
        // _line / _col fields are parser bookkeeping and never
        // appear on the public AST — they get stripped after the
        // check.
        if (ctl.init && ctl.init.kind === 'literal' && ctl.bindingType) {
            const mismatch = defaultMatchesType(ctl.bindingType, ctl.init.value);
            if (mismatch) {
                throw new ParseError(
                    ERR.INVALID_PARAM,
                    `Param 'init' value ${JSON.stringify(ctl.init.value)} does not match binding type '${ctl.bindingType}' (${mismatch})`,
                    ctl.init._line ?? 0,
                    ctl.init._col  ?? 0
                );
            }
            // Canonicalise — `init="50"` on an int binding becomes
            // 50 so the AST's init.value matches the binding's type
            // regardless of the surface form the author wrote.
            ctl.init.value = coerceLiteral(ctl.bindingType, ctl.init.value);
            delete ctl.init._line;
            delete ctl.init._col;
        } else if (ctl.init && ctl.init.kind === 'literal') {
            delete ctl.init._line;
            delete ctl.init._col;
        }
    }
    if ('compute' in ctl.params) {
        ctl.compute = ctl.params.compute;   // typically { kind:'function', name }
        delete ctl.params.compute;
    }
    if ('explain' in ctl.params) {
        // Only hoist when the value is non-null. The __common spec
        // gives `explain` a default of `null`, which the param-default
        // pass writes back into ctl.params before this hoist runs.
        // Hoisting `null` here would create a `_rawExplain: null`
        // field that leaks into the public AST. The condition keeps
        // _rawExplain absent unless the source actually carried an
        // explain= value to defer.
        if (ctl.params.explain != null) {
            ctl._rawExplain = ctl.params.explain;   // resolved in phase 2
        }
        delete ctl.params.explain;
    }
    if ('__dataType' in ctl.params) {
        ctl.dataType = ctl.params.__dataType;   // null | 'int'|'float'|'bool'|'string'
        delete ctl.params.__dataType;
    }

    // Capture the label text. The label is everything from after
    // the closing `]` to either the next `[` or end-of-line. Some
    // callers (like parseContainerDecl when it's processing header
    // controls) need to reserve the trailing text for themselves;
    // they pass `opts.skipLabel` to suppress this step.
    if (!opts.skipLabel) {
        const rawLabel = tk.consumeLabelAndAdvance();
        if (rawLabel.length > 0) {
            // An inline STRING in the control's params (legal on
            // controls with contentRef:'allowed' — label, display)
            // already populated the label via collectLabel. Letting
            // post-bracket text run a second collectLabel would
            // silently last-wins-overwrite the inline content; raise
            // INVALID_PARAM so the author picks one source instead.
            if (ctl._inlineLabelLine != null) {
                throw new ParseError(
                    ERR.INVALID_PARAM,
                    `Inline label text and post-bracket label text both supplied on '${typeName}'; pick one (the inline string at line ${ctl._inlineLabelLine} or the trailing text)`,
                    typeIdent.line, typeIdent.col
                );
            }
            collectLabel(state, ctl, rawLabel, typeIdent.line);
        }
    }
    // Strip the parser-private marker so it doesn't leak into the AST.
    if ('_inlineLabelLine' in ctl) delete ctl._inlineLabelLine;

    return ctl;
}

function parseControlParams(tk, ctl, policy, state, _typeIdent) {
    // Each marker (width, binding, options/content ref) is allowed
    // at most once per declaration. Last-writer-wins would be a quiet
    // foot-gun: `[textfield(5,{a},{b})]` would silently keep `{b}` as
    // the binding and drop `{a}`. The early throw turns the typo into
    // an INVALID_PARAM with the offending token's line / column.
    let widthSet = false;
    let bindingSet = false;
    let refSet = false;
    // Track keyword-param names already seen on this declaration so a
    // typo like `[number(5,{x},min=1,min=2)]` raises INVALID_PARAM
    // instead of silently keeping the second value. Symmetric with
    // the duplicate-width / duplicate-binding / duplicate-ref checks.
    const keysSeen = new Set();
    let first = true;
    while (tk.peek().kind !== T.RPAREN) {
        if (!first) {
            tk.expect(T.COMMA);
            // Trailing comma allowed: `[number(5,{x},)]` is the same
            // as `[number(5,{x})]`. Matches the tooltips / colors /
            // __properties block grammar so authors learn one rule.
            if (tk.peek().kind === T.RPAREN) break;
        }
        first = false;
        const t = tk.peek();

        if (t.kind === T.INTEGER) {
            if (widthSet) {
                throw new ParseError(
                    ERR.INVALID_PARAM,
                    `Duplicate width on '${ctl.controlType}'; one bare integer allowed per declaration`,
                    t.line, t.col
                );
            }
            const width = tk.next().value;
            if (width < 0) {
                throw new ParseError(
                    ERR.INVALID_PARAM,
                    `Width must be 0 or greater on '${ctl.controlType}', got ${width}`,
                    t.line, t.col
                );
            }
            ctl.width = width;
            widthSet = true;
            continue;
        }
        if (t.kind === T.HASH_IDENT) {
            if (refSet) {
                throw new ParseError(
                    ERR.INVALID_PARAM,
                    `Duplicate '#${t.value}' reference on '${ctl.controlType}'; one #name allowed per declaration`,
                    t.line, t.col
                );
            }
            // Mutual-exclusion with an inline string already set as
            // the label content. Both fill the same slot (ctl.label
            // after phase 2); allowing both would be ambiguous.
            if (ctl._inlineLabelLine != null) {
                throw new ParseError(
                    ERR.INVALID_PARAM,
                    `Inline label text and a '#name' reference both supplied on '${ctl.controlType}'; pick one (the inline string at line ${ctl._inlineLabelLine} or #${t.value})`,
                    t.line, t.col
                );
            }
            tk.next();
            // A `#name` reference routes to either contentRef (a
            // named-text body, used by label / display) or
            // optionsSource (an option-source ref, used by select /
            // combo / radio / multiselect). The two surfaces are
            // mutually exclusive on a single control: control-spec.js
            // refuses a spec that declares contentRef:'allowed' and
            // an active optionsRef simultaneously, so this branch
            // only ever fires for one of the two paths at a time.
            if (policy.contentRef === 'allowed') {
                ctl.contentRef = t.value;
            } else {
                ctl.optionsSource = t.value;
            }
            refSet = true;
            continue;
        }
        if (t.kind === T.LCURLY) {
            if (bindingSet) {
                throw new ParseError(
                    ERR.INVALID_PARAM,
                    `Duplicate binding on '${ctl.controlType}'; one {binding} allowed per declaration`,
                    t.line, t.col
                );
            }
            tk.next();
            // parseBindingPath now does the per-segment
            // assertSafeObjectKey screen itself, so every binding-path
            // producer in the parser shares one rule. The previous
            // per-site loop here is gone.
            const parts = parseBindingPath(tk);
            // `this` is reserved. A bare `{this}` binding is
            // meaningless: bindings name objects or primitives, and
            // `this` alone is neither. The dotted form `{this.field}`
            // is legal inside a repeater scope (it names a primitive
            // on the current item) and infer-schema rewrites it to
            // the array-element path; only the bare single-segment
            // `this` is rejected here.
            if (parts.length === 1 && parts[0] === 'this') {
                throw new ParseError(
                    ERR.INVALID_PARAM,
                    `'this' is reserved and cannot be a bare binding name; bindings name objects or primitives (use 'this.field' inside a repeater for the current item's field)`,
                    t.line, t.col
                );
            }
            ctl.binding = parts.join('.');
            // Optional `:type` suffix on the binding, like
            // `{name:int}`. The parser only honours this on simple
            // single-segment bindings that aren't function
            // references. Dotted paths like `{customer.name}` and
            // function bindings like `{@compute}` stay free of
            // inline types, which keeps the property collector's
            // `\w+(:\w+)?` regex matching exactly the bindings it's
            // supposed to pick up.
            if (tk.peek().kind === T.COLON) {
                if (parts.length !== 1 || ctl.binding.startsWith('@')) {
                    const tc = tk.peek();
                    throw new ParseError(
                        ERR.PARSE_ERROR,
                        `Inline binding type ':type' is only allowed on a simple {name} binding`,
                        tc.line, tc.col
                    );
                }
                tk.next();   // consume ':'
                ctl.bindingType = tk.expect(T.IDENT).value;
            }
            tk.expect(T.RCURLY);
            bindingSet = true;
            continue;
        }
        if (t.kind === T.STRING) {
            // An inline quoted string in control params is valid only on
            // controls that accept a content reference (label, display).
            // The string IS the label content — same effect as putting the
            // text after the closing `]`, but inline so the author can
            // bundle a long help string with the rest of the params.
            // Routing through collectLabel means the string flows through
            // the same phase-2 fragment-rewrite pipeline that handles
            // colors / bindings / `{name}` placeholders, so authors learn
            // one rule for all label text.
            if (policy.contentRef !== 'allowed') {
                throw new ParseError(
                    ERR.INVALID_PARAM,
                    `Inline string parameter is not supported on '${ctl.controlType}'; put the label text after the closing ']' (e.g. '[${ctl.controlType}(5,{name})]  My label text')`,
                    t.line, t.col
                );
            }
            // Duplicate inline string in the same declaration. Check
            // BEFORE the inline-vs-#ref check so a second inline
            // string raises the right diagnostic instead of the
            // mutual-exclusion message.
            if (ctl._inlineLabelLine != null) {
                throw new ParseError(
                    ERR.INVALID_PARAM,
                    `Duplicate inline label text on '${ctl.controlType}'; one quoted string allowed per declaration`,
                    t.line, t.col
                );
            }
            // Mutual exclusion with an existing #ref. Both fill the
            // same slot (ctl.label after phase 2); allowing both
            // would be ambiguous.
            if (refSet) {
                throw new ParseError(
                    ERR.INVALID_PARAM,
                    `Inline label text and a '#name' reference both supplied on '${ctl.controlType}'; pick one`,
                    t.line, t.col
                );
            }
            tk.next();   // consume the STRING token
            collectLabel(state, ctl, t.value, t.line);
            // Track on the control so parseControlDecl's post-bracket
            // label pass can detect "inline + post-bracket" and refuse
            // it explicitly, and so the #ref handler can detect "inline
            // then #ref" symmetrically. Stripped after parseControlDecl
            // checks it; never leaks into the public AST.
            ctl._inlineLabelLine = t.line;
            continue;
        }
        if (t.kind === T.IDENT) {
            const key = tk.next().value;
            if (keysSeen.has(key)) {
                throw new ParseError(
                    ERR.INVALID_PARAM,
                    `Duplicate parameter '${key}=' on '${ctl.controlType}'; one value per parameter per declaration`,
                    t.line, t.col
                );
            }
            keysSeen.add(key);
            tk.expect(T.EQUALS);
            // Same screen as the container dispatcher. Without it, a
            // parameter name like `__proto__` would bracket-walk
            // through Object.prototype on the merged policy.params
            // (`{ ...common, ...own }` carries Object.prototype) and
            // hand parseTypedValue a truthy non-spec, which then
            // raises a confusing INVALID_SPEC. The screen turns the
            // input into a clean INVALID_PARAM at the offending key.
            assertSafeObjectKey(key, `parameter name on '${ctl.controlType}'`, t);
            const paramSpec = safeGet(policy.params, key);
            const value = parseTypedValue(tk, paramSpec, key, t);
            ctl.params[key] = value;
            continue;
        }
        throw new ParseError(
            ERR.PARSE_ERROR,
            `Unexpected token in control params: ${t.kind}`,
            t.line, t.col
        );
    }
}

// Pick the most specific error message available for a failed
// param. A custom control spec may declare `message: "..."` on the
// `ParamSpec` to say what the right value should look like in the
// consumer's vocabulary ("Port must be between 1 and 65535"); the
// fallback is the parser's generic message. Returns the chosen
// string for use as the second argument to `new ParseError`.
function paramErrorMessage(paramSpec, fallback) {
    return paramSpec?.message ?? fallback;
}

function parseTypedValue(tk, paramSpec, key, keyToken) {
    if (!paramSpec) {
        throw new ParseError(
            ERR.INVALID_PARAM,
            `Unknown parameter '${key}' for control`,
            keyToken.line, keyToken.col
        );
    }
    const t = tk.next();
    switch (paramSpec.type) {
        case 'integer':
            if (t.kind !== T.INTEGER) {
                throw new ParseError(ERR.INVALID_PARAM,
                    paramErrorMessage(paramSpec, `Param '${key}' must be an integer`),
                    t.line, t.col);
            }
            // Integer params default to non-negative. Every shipped
            // use site (textarea.rows, file.maxBytes, multiselect.min,
            // etc.) wants a count or a length, never a negative
            // number. A custom-control spec that legitimately wants
            // signed integers (a temperature offset, an array index
            // with -1 for "from end") opts in by setting
            // `negativeOk: true` on the param entry.
            if (t.value < 0 && paramSpec.negativeOk !== true) {
                throw new ParseError(
                    ERR.INVALID_PARAM,
                    paramErrorMessage(paramSpec, `Param '${key}' must be 0 or greater, got ${t.value}`),
                    t.line, t.col
                );
            }
            return t.value;
        case 'number':
            if (t.kind !== T.INTEGER && t.kind !== T.FLOAT) {
                throw new ParseError(ERR.INVALID_PARAM,
                    paramErrorMessage(paramSpec, `Param '${key}' must be a number`),
                    t.line, t.col);
            }
            return t.value;
        case 'boolean':
            if (t.kind !== T.IDENT || (t.value !== 'true' && t.value !== 'false')) {
                throw new ParseError(ERR.INVALID_PARAM,
                    paramErrorMessage(paramSpec, `Param '${key}' must be true or false`),
                    t.line, t.col);
            }
            return t.value === 'true';
        case 'string':
            if (t.kind !== T.STRING) {
                throw new ParseError(ERR.INVALID_PARAM,
                    paramErrorMessage(paramSpec, `Param '${key}' must be a quoted string`),
                    t.line, t.col);
            }
            return t.value;
        case 'date':
            if (t.kind === T.DATE)   return t.value;
            if (t.kind === T.STRING) return t.value;
            throw new ParseError(ERR.INVALID_PARAM,
                paramErrorMessage(paramSpec, `Param '${key}' must be a date (YYYY-MM-DD) or quoted string`),
                t.line, t.col);
        case 'enum': {
            const v = t.kind === T.STRING ? t.value
                   :  t.kind === T.IDENT  ? t.value
                   :  null;
            if (v == null || !paramSpec.values.includes(v)) {
                throw new ParseError(
                    ERR.INVALID_PARAM,
                    paramErrorMessage(paramSpec, `Param '${key}' must be one of: ${paramSpec.values.join(', ')}`),
                    t.line, t.col
                );
            }
            return v;
        }
        case 'textOrRef': {
            // Accepts an inline "string" (parsed as decorated
            // fragments later) or a #namedRef (resolved to
            // named-text fragments).
            if (t.kind === T.STRING)     return { kind: 'inline', value: t.value };
            if (t.kind === T.HASH_IDENT) return { kind: 'ref',    refName: t.value };
            throw new ParseError(
                ERR.INVALID_PARAM,
                `Param '${key}' must be a quoted string or #name reference`,
                t.line, t.col
            );
        }
        case 'init': {
            // Accepts a literal (string / int / float / bool / date)
            // or a {path} (data binding) or a {@fn} (function
            // reference). Float literals include the negative-leading
            // and leading-dot forms (`init=-0.5`, `init=.25`); the
            // tokenizer recognises both as FLOAT so they reach this
            // branch as a single token. Date literals are the bare
            // ISO forms accepted by the DATE token (YYYY-MM-DD or
            // YYYY-MM-DDTHH:MM:SS) — quote them as a string if a
            // different format is needed.
            if (t.kind === T.LCURLY) {
                const parts = parseBindingPath(tk);
                tk.expect(T.RCURLY);
                const path = parts.join('.');
                if (path.startsWith('@')) {
                    return { kind: 'function', name: path.slice(1) };
                }
                return { kind: 'binding', path };
            }
            // Literal values carry the source position on `_line` /
            // `_col`. The hoist in parseControlDecl strips those
            // helper fields before the AST is published, but keeps
            // them long enough to point a "literal type does not
            // match binding type" error at the right column. See the
            // init= hoist near the top of this file.
            const literal = (() => {
                if (t.kind === T.STRING)  return { kind: 'literal', value: t.value };
                if (t.kind === T.INTEGER) return { kind: 'literal', value: t.value };
                if (t.kind === T.FLOAT)   return { kind: 'literal', value: t.value };
                if (t.kind === T.DATE)    return { kind: 'literal', value: t.value };
                if (t.kind === T.IDENT && (t.value === 'true' || t.value === 'false')) {
                    return { kind: 'literal', value: t.value === 'true' };
                }
                return null;
            })();
            if (literal === null) {
                throw new ParseError(
                    ERR.INVALID_PARAM,
                    `Param 'init' must be a literal value or a {binding} / {@function}`,
                    t.line, t.col
                );
            }
            literal._line = t.line;
            literal._col  = t.col;
            return literal;
        }
        case 'computeFunction': {
            // compute= names a function the renderer re-runs when
            // data changes. Only the {@fn} shape is meaningful: a
            // literal would be a constant (no recomputation needed)
            // and a {path} binding is just a renamed alias for the
            // control's own binding. Reject everything else with a
            // clear message so the AST type promise (`{ kind:
            // 'function', name: string } | null`) holds.
            if (t.kind !== T.LCURLY) {
                throw new ParseError(
                    ERR.INVALID_PARAM,
                    `Param '${key}' must be a function reference of the form {@functionName}`,
                    t.line, t.col
                );
            }
            const parts = parseBindingPath(tk);
            tk.expect(T.RCURLY);
            const path = parts.join('.');
            if (!path.startsWith('@')) {
                throw new ParseError(
                    ERR.INVALID_PARAM,
                    `Param '${key}' must be a function reference; got '{${path}}'. Use '{@${path}}' instead.`,
                    t.line, t.col
                );
            }
            return { kind: 'function', name: path.slice(1) };
        }
        case 'expression':
            if (t.kind !== T.STRING) {
                throw new ParseError(ERR.INVALID_PARAM, `Param '${key}' must be a quoted expression string`, t.line, t.col);
            }
            return t.value;
        default:
            throw new ParseError(ERR.INVALID_SPEC, `Unsupported param type '${paramSpec.type}'`, t.line, t.col);
    }
}
