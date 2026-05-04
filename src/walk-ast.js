// walkAst(astOrNode, visitor)
//
// One canonical walker for every AST-traversing helper. Visits each
// node in the tree once, calling `visitor(node)` on every visit.
// The visitor sees nodes in source order: a container is visited
// before its rows, a row before its controls, a panel before the
// rows it contains, a header-control before the panels and rows
// that follow.
//
// What this is for: any consumer that wants to walk the AST without
// re-implementing the recursion through every node kind. The viewer
// uses this to seed reactive form data; the inferred-schema walker
// uses a similar shape internally; a downstream consumer building
// their own renderer can use it for the same job.
//
// What kinds the visitor sees: 'control', 'row', 'container',
// 'repeater', 'listManager', 'panel'. Panel nodes (the
// `panels=[1:8, 2:12]` shape) carry `rows`; the visit ordering
// is the panel itself, then each row inside it.
//
// What this does NOT do: it does not give the visitor a way to
// stop the walk early or skip a subtree. If a future caller needs
// that, return a sentinel from the visitor (`'stop'`, `'skip'`)
// and branch on it here. Today the simplest contract is "visits
// every node once, no signalling."
//
// Pass `null` or `undefined` and the function returns silently.
// Pass `{ root, ... }` (a FormModel) and the walk starts at root.
// Pass any node directly and the walk starts there. The flexibility
// lets a caller traverse a subtree without first extracting the
// model wrapper.

/**
 * Walk every node of an AST or subtree, calling `visitor(node)` on
 * each. Visit order is source order (parent before children).
 *
 * @param {object | null | undefined} astOrNode  a FormModel or any node
 * @param {(node: object) => void} visitor       called for every node
 */
export function walkAst(astOrNode, visitor) {
    if (!astOrNode || typeof visitor !== 'function') return;
    // Accept either a FormModel (with `.root`) or a bare node.
    const start = astOrNode.root ?? astOrNode;
    visit(start, visitor);
}

function visit(node, visitor) {
    if (!node) return;
    visitor(node);
    const kind = node.nodeKind;

    if (kind === 'control') return;

    if (kind === 'row') {
        // A row's controls array can hold control nodes OR nested
        // sub-containers (per the AST shape). Visit each item.
        if (node.controls) {
            for (const c of node.controls) visit(c, visitor);
        }
        return;
    }

    if (kind === 'container' || kind === 'repeater' || kind === 'listManager') {
        if (node.headerControls) {
            for (const c of node.headerControls) visit(c, visitor);
        }
        if (node.panels) {
            // Panels are plain `{number, label, width, rows}` objects
            // — they don't carry a nodeKind. Visit each panel and
            // recurse into its rows here rather than dispatching on
            // a kind that doesn't exist on the runtime shape. The
            // visitor still sees every panel.
            for (const p of node.panels) {
                visitor(p);
                if (p.rows) {
                    for (const r of p.rows) visit(r, visitor);
                }
            }
        }
        if (node.rows) {
            for (const r of node.rows) visit(r, visitor);
        }
        return;
    }

    // Unknown nodeKind: visited the node itself (callers may want
    // to know it exists), but we have no recursion rule for it.
    // A future kind needs to be added to the switch above.
}
