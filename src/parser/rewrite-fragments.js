// Phase-2 text rewriting. Phase 1 of the parse builds the AST and
// records every label, tooltip, and named-text body as raw strings
// (plus a list of pending labels). Phase 2 walks all of that text
// through parseDecorated() now that the colors map is complete, so
// every label / tooltip / named-text value comes out as a fully-
// resolved TextFragment[] with color references already looked up.
//
// Phase 2 also resolves named-object references inside option-source
// value lists. Phase 1 stashes each `#name` as a small `{__ref}`
// placeholder so this pass can report a proper INVALID_REF error
// (with the source line and column) when the name doesn't match any
// declared object.

import { ParseError, ERR } from '../tuple-response.js';
import { parseDecorated } from '../text-fragment.js';
import { safeGet } from '../safe-keys.js';

export function rewriteTextToFragments(state, model) {
    // Tooltips: raw strings -> TextFragment[]
    for (const [key, entry] of Object.entries(model._rawTooltips ?? {})) {
        model.tooltips[key] = parseDecorated(entry.value, model.colors, entry.line);
    }
    // Named-text variables: raw strings -> TextFragment[]
    for (const [key, entry] of Object.entries(model._rawNamedText ?? {})) {
        model.namedText[key] = parseDecorated(entry.value, model.colors, entry.line);
    }
    // Labels collected during phase 1.
    for (const { owner, raw, line } of state.pendingLabels) {
        owner.label = parseDecorated(raw, model.colors, line);
    }
    // Inline #refs in container title / description slots.
    inlineNamedTextRefs(model);

    // Resolve named-object references inside option-source value
    // lists. After this pass runs, every option-source value is a
    // usable scalar or object. Consumers never see the placeholder
    // shape.
    for (const src of Object.values(model.optionSources)) {
        if (!Array.isArray(src.values)) continue;
        src.values = src.values.map(v => {
            if (v && typeof v === 'object' && '__ref' in v) {
                // safeGet returns undefined for prototype-walking
                // names regardless of the map's prototype shape; the
                // model maps are also Object.create(null), so this
                // is belt-and-suspenders. Either layer alone catches
                // the bug; both layered means a future code edit
                // can't accidentally re-open it.
                const obj = safeGet(model.namedObjects, v.__ref);
                if (!obj) {
                    throw new ParseError(
                        ERR.INVALID_REF,
                        `Unknown named object '#${v.__ref}'`,
                        v.__refLine ?? 0, v.__refCol ?? 0
                    );
                }
                return obj;
            }
            return v;
        });
    }
}

function inlineNamedTextRefs(model) {
    // The `ref` fragment is internal. Phase 1 stashes one for every
    // inline `#name` reference; this pass either swaps it for the
    // resolved named-text body or throws INVALID_REF. Consumers never
    // see a `ref` fragment in the AST.
    const inlineRefs = (frags, ownerLoc) => {
        const result = [];
        for (const f of frags ?? []) {
            if (f.kind === 'ref') {
                const named = safeGet(model.namedText, f.refName);
                if (!named) {
                    throw new ParseError(
                        ERR.INVALID_REF,
                        `Named text '#${f.refName}' is not declared`,
                        ownerLoc?.line ?? 0, ownerLoc?.col ?? 0
                    );
                }
                for (const nf of named) result.push({ ...nf });
            } else {
                result.push(f);
            }
        }
        return result;
    };

    const transformContentRef = (ctl) => {
        // contentRef cross-checks run in validate.js (the canonical
        // cross-ref pass), so this rewrite stays guarded. A miss is
        // not an error here; validateRefs raises INVALID_REF after
        // phase 2 finishes.
        const body = ctl.contentRef ? safeGet(model.namedText, ctl.contentRef) : null;
        if (body) {
            ctl.label = body.map(f => ({ ...f }));
        }
    };

    const visit = (node) => {
        if (!node) return;
        if (node.nodeKind === 'container' || node.nodeKind === 'repeater' || node.nodeKind === 'listManager') {
            node.title       = inlineRefs(node.title, node.loc);
            node.description = inlineRefs(node.description, node.loc);
            for (const h of node.headerControls) visit(h);
            if (node.panels) for (const p of node.panels) {
                p.label = inlineRefs(p.label, node.loc);
                for (const r of p.rows) visit(r);
            }
            if (node.rows) for (const r of node.rows) visit(r);
        }
        if (node.nodeKind === 'row') {
            for (const c of node.controls) visit(c);
        }
        if (node.nodeKind === 'control') {
            transformContentRef(node);
            node.label = inlineRefs(node.label, node.loc);
            // Resolve explain= now that named text is available.
            // _rawExplain is only set when the source carried an
            // explain= parameter; otherwise the control never gets
            // the field and no scratch artefact leaks into the AST.
            if (node._rawExplain) {
                if (node._rawExplain.kind === 'inline') {
                    node.explain = parseDecorated(node._rawExplain.value, model.colors, node.loc?.line ?? 0);
                } else if (node._rawExplain.kind === 'ref') {
                    const named = safeGet(model.namedText, node._rawExplain.refName);
                    if (!named) {
                        throw new ParseError(
                            ERR.INVALID_REF,
                            `Named text '#${node._rawExplain.refName}' is not declared`,
                            node.loc?.line ?? 0, node.loc?.col ?? 0
                        );
                    }
                    node.explain = named.map(f => ({ ...f }));
                }
                delete node._rawExplain;
            }
        }
    };

    visit(model.root);
}
