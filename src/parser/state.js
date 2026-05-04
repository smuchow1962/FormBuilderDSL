// Parser state. A plain object passed by reference through every
// helper so they can read the spec and accumulate warnings plus the
// deferred label list without depending on a `this` context.
//
// Fields are intentionally minimal; everything else lives on the
// model object the helpers populate.

export function createParserState(spec, opts = {}) {
    return {
        spec,
        warnings: [],
        pendingLabels: [],
        // Optional caller-supplied caps. Undefined here means "use
        // the default in the relevant module" (e.g. parse-containers
        // falls back to MAX_NESTING_DEPTH when this is undefined).
        maxNestingDepth: opts.maxNestingDepth
    };
}
