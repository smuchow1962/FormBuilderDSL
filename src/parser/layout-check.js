/**
 * Walks the form model and confirms that no row's controls add up wider
 * than the form's `columns` setting. The DSL's grid is `columns` units
 * wide; a row whose controls sum to more than that would overflow at
 * render time, so the parser rejects it before the AST goes anywhere.
 *
 * @param {{ columns: number, root: object }} model
 * @returns {string[]} one error message per oversized row; empty array if everything fits.
 */
export function checkLayout(model) {
    const errors = [];
    const checkRow = (row) => {
        let sum = 0;
        for (const c of row.controls) {
            if (c.nodeKind === 'control' && typeof c.width === 'number') sum += c.width;
        }
        if (sum > model.columns) {
            errors.push(
                `line ${row.loc.line}: row widths sum to ${sum}, exceeds columns: ${model.columns}`
            );
        }
    };
    const visit = (node) => {
        if (!node) return;
        if (node.nodeKind === 'container' || node.nodeKind === 'repeater' || node.nodeKind === 'listManager') {
            if (node.panels) for (const p of node.panels) for (const r of p.rows) visit(r);
            if (node.rows) for (const r of node.rows) visit(r);
        }
        if (node.nodeKind === 'row') {
            checkRow(node);
            for (const c of node.controls) visit(c);
        }
    };
    visit(model.root);
    return errors;
}
