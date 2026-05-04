// Cross-reference and binding-policy validation. Runs after the AST
// has been built and after phase-2 fragment rewriting, in a single
// walk over the tree. Catches these classes of error:
//
//   - cross-references that don't resolve (option source the
//     control names, tooltip key the control points at,
//     content ref the label / display points at,
//     excluded-items ref the listManager points at)
//   - tooltip refs on container nodes (parallel to the control check)
//   - function-shaped bindings on controls that can't write back
//
// Reference policy: every `#name` reference resolves at parse time
// against names declared in the same .mmpform document. The only
// externally-resolvable reference is `{@function}`, which the
// consumer's renderer wires to a function registry at render time.
// `#name` typos never make it past validation; missing functions
// are a runtime concern.
//
// A failure here throws ParseError; the runParse wrapper converts
// it to a TupleResponse failure for the consumer.

import { ParseError, ERR } from '../tuple-response.js';

const CONTAINER_KINDS = new Set(['container', 'repeater', 'listManager']);

export function validateRefs(model) {
    const optionsDeclared  = new Set(Object.keys(model.optionSources));
    const tooltipsDeclared = new Set(Object.keys(model.tooltips ?? {}));
    const namedTextDeclared = new Set(Object.keys(model.namedText ?? {}));

    const checkTooltipRef = (node) => {
        if (node.tooltipRef && !tooltipsDeclared.has(node.tooltipRef)) {
            throw new ParseError(
                ERR.INVALID_REF,
                `Tooltip '${node.tooltipRef}' is not declared`,
                node.loc.line, node.loc.col
            );
        }
    };

    const visit = (node) => {
        if (!node) return;

        if (node.nodeKind === 'control') {
            if (node.optionsSource && !optionsDeclared.has(node.optionsSource)) {
                throw new ParseError(
                    ERR.INVALID_REF,
                    `Option source '#${node.optionsSource}' is not declared`,
                    node.loc.line, node.loc.col
                );
            }
            checkTooltipRef(node);
            // contentRef points at a named-text entry. Catching this
            // here (rather than letting rewrite-fragments silently
            // leave the label empty) gives a typo like
            // `[label(4,#intr0)]` for `intro` a real INVALID_REF
            // pointing at the source line and column.
            if (node.contentRef && !namedTextDeclared.has(node.contentRef)) {
                throw new ParseError(
                    ERR.INVALID_REF,
                    `Named text '#${node.contentRef}' is not declared`,
                    node.loc.line, node.loc.col
                );
            }
            // The function-binding form ({@name}) is only legal on
            // read-only controls. A function reference has nowhere
            // for the renderer to write a value back, so a
            // writeable control like `textfield` would have no way
            // to round-trip user input.
            if (node.binding && node.binding.startsWith('@') && !node.readOnly) {
                throw new ParseError(
                    ERR.INVALID_PARAM,
                    `Function binding '{${node.binding}}' requires a read-only control (e.g. display); '${node.controlType}' writes back`,
                    node.loc.line, node.loc.col
                );
            }
        }
        if (CONTAINER_KINDS.has(node.nodeKind)) {
            // tt="key" is accepted on every container shape too, so
            // the same cross-check has to run on container nodes or
            // a typo on a container would slip through.
            checkTooltipRef(node);
            // excluded=#name on listManager points at a static
            // option source whose values name the protected items.
            // A typo would silently drop the protection; this
            // check turns it into INVALID_REF.
            if (node.excludedRef && !optionsDeclared.has(node.excludedRef)) {
                throw new ParseError(
                    ERR.INVALID_REF,
                    `Excluded option source '#${node.excludedRef}' is not declared`,
                    node.loc.line, node.loc.col
                );
            }
            for (const h of node.headerControls) visit(h);
            if (node.panels) for (const p of node.panels) for (const r of p.rows) visit(r);
            if (node.rows)   for (const r of node.rows) visit(r);
        }
        if (node.nodeKind === 'row') {
            for (const c of node.controls) visit(c);
        }
    };
    visit(model.root);
}
