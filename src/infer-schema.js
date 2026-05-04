// inferDataSchema(ast). Walks the AST and reports every data property and
// every function reference that the form expects to find at render time.
//
// Then scaffoldDataObject() / scaffoldDataClass() / scaffoldTypeScript()
// turn the report into copy-paste-ready code for the consumer to fill in.
//
//   const schema = inferDataSchema(ast);
//   console.log(scaffoldDataClass(schema, 'TextFileFormData'));
//
// Repeater elements: bindings written as `{this.x}` inside a `[repeater({arr})]`
// scope are recorded as `arr[].x` paths so the scaffold produces an array of
// element objects. Otherwise paths nest like normal (`a.b.c` → `{ a:{ b:{ c }}}`).

import { isReservedObjectKey } from './safe-keys.js';

/** Maps control types to inferred JS / scaffold types (see `DEFAULT_DATA_TYPE_BY_CONTROL` for property defaults). */
export const TYPE_BY_CONTROL = Object.freeze({
    textfield:   { jsType: 'string',  defaultValue: "''",            tsType: 'string' },
    textarea:    { jsType: 'string',  defaultValue: "''",            tsType: 'string' },
    password:    { jsType: 'string',  defaultValue: "''",            tsType: 'string' },
    number:      { jsType: 'number',  defaultValue: '0',             tsType: 'number' },
    float:       { jsType: 'number',  defaultValue: '0.0',           tsType: 'number' },
    slider:      { jsType: 'number',  defaultValue: '0.0',           tsType: 'number' },
    check:       { jsType: 'boolean', defaultValue: 'false',         tsType: 'boolean' },
    toggle:      { jsType: 'boolean', defaultValue: 'false',         tsType: 'boolean' },
    select:      { jsType: 'string',  defaultValue: 'null',          tsType: 'string | null' },
    combo:       { jsType: 'string',  defaultValue: 'null',          tsType: 'string | null' },
    radio:       { jsType: 'string',  defaultValue: 'null',          tsType: 'string | null' },
    multiselect: { jsType: 'array',   defaultValue: '[]',            tsType: 'string[]' },
    date:        { jsType: 'string',  defaultValue: 'null',          tsType: 'string | null' },
    time:        { jsType: 'string',  defaultValue: 'null',          tsType: 'string | null' },
    datetime:    { jsType: 'string',  defaultValue: 'null',          tsType: 'string | null' },
    daterange:   { jsType: 'object',  defaultValue: '{ start: null, end: null }', tsType: '{ start: string | null; end: string | null }' },
    file:             { jsType: 'string',  defaultValue: 'null',          tsType: 'string | null' },
    fileSize:         { jsType: 'string',  defaultValue: "''",            tsType: 'string' },
    fileBrowser:      { jsType: 'string',  defaultValue: 'null',          tsType: 'string | null' },
    directoryBrowser: { jsType: 'string',  defaultValue: 'null',          tsType: 'string | null' },
    color:            { jsType: 'string',  defaultValue: "'#000000'",     tsType: 'string' },
    hidden:           { jsType: 'unknown', defaultValue: 'null',          tsType: 'unknown' },
    display:          { jsType: 'string',  defaultValue: "''",            tsType: 'string' },
    label:            { jsType: null,      defaultValue: null,            tsType: null }
});

const ARRAY_TYPE = Object.freeze({ jsType: 'array', defaultValue: '[]', tsType: 'unknown[]' });

// Triples for the four __dataType / inline {name:type} values.
// `collectProperties` already routes its type resolution through
// these names; this scaffolder honours the same overrides so the
// two helpers describe the same control the same way. A control
// declared as `[textfield(5,{count:int})]` collects as `'int'` and
// scaffolds as `number`, not the per-control textfield default of
// `string`.
const TYPE_BY_DATA_TYPE = Object.freeze({
    int:    { jsType: 'number',  defaultValue: '0',     tsType: 'number'  },
    float:  { jsType: 'number',  defaultValue: '0.0',   tsType: 'number'  },
    bool:   { jsType: 'boolean', defaultValue: 'false', tsType: 'boolean' },
    string: { jsType: 'string',  defaultValue: "''",    tsType: 'string'  }
});

// Resolve a control node to its triple. Specificity (highest first):
// inline `:type` on the binding, then __dataType= override, then
// the per-control fallback in TYPE_BY_CONTROL. Mirrors
// `property-collector.resolveControlPropertyType`.
function resolveControlType(ctl) {
    if (!ctl || typeof ctl !== 'object') return null;
    const explicit = ctl.bindingType ?? ctl.dataType;
    if (explicit && TYPE_BY_DATA_TYPE[explicit]) return TYPE_BY_DATA_TYPE[explicit];
    return TYPE_BY_CONTROL[ctl.controlType] ?? null;
}

export function inferDataSchema(ast) {
    if (!ast || !ast.root) return { fields: [], functions: [], repeaters: [], optionSources: [], tooltips: [] };

    const fields    = new Map();   // path → { type, sources: [...] }
    const functions = new Map();   // name → { contexts: [...], inferredReturns }
    const repeaters = [];          // [{ arrayPath }]

    const noteFunction = (name, ctx) => {
        if (!name) return;
        const e = functions.get(name) ?? { contexts: [], inferredReturns: 'unknown' };
        e.contexts.push(ctx);
        // Infer return type from context
        if (ctx.kind === 'option-source')      e.inferredReturns = 'array';
        else if (ctx.kind === 'display')       e.inferredReturns = 'string';
        else if (ctx.kind === 'init')          e.inferredReturns = ctx.expectedType ?? 'unknown';
        else if (ctx.kind === 'compute')       e.inferredReturns = ctx.expectedType ?? 'unknown';
        else if (ctx.kind === 'fragment')      e.inferredReturns = 'string';
        functions.set(name, e);
    };

    // `typeHint` is either a resolved type triple ({ jsType,
    // defaultValue, tsType }), the string 'array' (for the array
    // sentinel used by repeater bindings), a control-type string
    // (legacy callers; resolved through TYPE_BY_CONTROL), or null.
    // The control-site caller resolves through `resolveControlType`
    // so the inline `:type` and `__dataType=` overrides win over the
    // per-control fallback.
    const noteField = (path, typeHint, ctx) => {
        if (!path || path.startsWith('@')) return;
        const e = fields.get(path) ?? { type: null, sources: [] };
        if (e.type == null && typeHint) {
            let t;
            if (typeHint === 'array')                  t = ARRAY_TYPE;
            else if (typeof typeHint === 'string')     t = TYPE_BY_CONTROL[typeHint];
            else                                        t = typeHint;
            if (t) e.type = t;
        }
        // Keep the source descriptor's controlType field for back-
        // compat with consumers walking the .sources array; pull it
        // off ctx if the call site supplied one.
        const controlType = ctx?.controlType ?? (typeof typeHint === 'string' ? typeHint : null);
        e.sources.push({ controlType, ...ctx });
        fields.set(path, e);
    };

    const visitFragments = (frags, ctx) => {
        for (const f of frags ?? []) {
            if (f.kind === 'binding')  noteField(f.path, null, { ...ctx, src: 'fragment' });
            if (f.kind === 'function') noteFunction(f.name, { ...ctx, kind: 'fragment' });
        }
    };

    // Repeater scope: rewrite `this.x` paths to `<arrayBinding>[].x`
    const scopePath = (rawPath, scope) => {
        if (rawPath.startsWith('this.') && scope?.arrayPath) {
            return scope.arrayPath + '[].' + rawPath.slice(5);
        }
        return rawPath;
    };

    const visit = (node, scope) => {
        if (!node) return;

        if (node.nodeKind === 'control') {
            const ctx = { line: node.loc?.line, kind: 'control' };

            // Direct binding
            if (node.binding) {
                if (node.binding.startsWith('@')) {
                    noteFunction(node.binding.slice(1), { kind: 'display', line: ctx.line });
                } else {
                    // Resolve through bindingType / dataType / per-
                    // control fallback so the inferred shape matches
                    // what `collectProperties` produces for the same
                    // control. A typed binding like `{count:int}`
                    // scaffolds as `number`, not the textfield
                    // default `string`.
                    const resolved = resolveControlType(node);
                    noteField(scopePath(node.binding, scope), resolved, { ...ctx, controlType: node.controlType });
                }
            }
            // contentRef on a label or display control isn't a data
            // binding. The content lives in the named-text registry,
            // so the consumer doesn't need a property for it. Skip.

            // Init bindings / functions
            if (node.init?.kind === 'binding') {
                const tp = resolveControlType(node);
                noteField(scopePath(node.init.path, scope), null, {
                    line: ctx.line, kind: 'init', expectedType: tp?.jsType
                });
            } else if (node.init?.kind === 'function') {
                const tp = resolveControlType(node);
                noteFunction(node.init.name, {
                    line: ctx.line, kind: 'init', expectedType: tp?.jsType
                });
            }
            // Compute (reactive function)
            if (node.compute?.kind === 'function') {
                const tp = resolveControlType(node);
                noteFunction(node.compute.name, {
                    line: ctx.line, kind: 'compute', expectedType: tp?.jsType
                });
            }

            // Label fragments may carry bindings / functions
            visitFragments(node.label, { line: ctx.line, kind: 'label' });
            return;
        }

        if (node.nodeKind === 'row') {
            for (const c of node.controls) visit(c, scope);
            return;
        }

        if (node.nodeKind === 'container' || node.nodeKind === 'repeater' || node.nodeKind === 'listManager') {
            const ctx = { line: node.loc?.line, kind: node.nodeKind };
            visitFragments(node.title,       { ...ctx, kind: 'title' });
            visitFragments(node.description, { ...ctx, kind: 'description' });
            // Container nodes carry only a tooltipRef (a string key
            // into model.tooltips), not an inline tooltip array. The
            // tooltip text itself is visited when the model.tooltips
            // map is walked elsewhere; nothing to do here per node.
            visitFragments(node.label,       { ...ctx, kind: 'container-label' });

            // Repeater and listManager both bind an array and push a
            // new scope so child bindings (`{name}` etc.) infer as
            // properties of the array's item type, not as top-level
            // form fields.
            let childScope = scope;
            const isArrayHost = (node.nodeKind === 'repeater' || node.nodeKind === 'listManager');
            if (isArrayHost && node.arrayBinding) {
                const arrayPath = scopePath(node.arrayBinding, scope);
                noteField(arrayPath, 'array', ctx);
                repeaters.push({ arrayPath });
                childScope = { arrayPath };
            }

            for (const h of node.headerControls) visit(h, childScope);
            if (node.panels) for (const p of node.panels) {
                visitFragments(p.label, { line: ctx.line, kind: 'panel' });
                for (const r of p.rows) visit(r, childScope);
            }
            if (node.rows) for (const r of node.rows) visit(r, childScope);
        }
    };

    // Option sources: dynamic ones reference a data path or a function
    const optionSources = [];
    // Fallback uses Object.create(null) so the iteration shape
    // matches the parser-produced maps (also prototype-free). The
    // `??` branch only fires for callers passing a hand-built
    // partial AST; keeping the prototype-free shape there too means
    // a downstream walk doesn't have to re-screen for inherited keys.
    for (const [name, src] of Object.entries(ast.optionSources ?? Object.create(null))) {
        const entry = { name, kind: src.type };
        if (src.type === 'dynamic') {
            if (src.path?.startsWith('@')) {
                noteFunction(src.path.slice(1), { kind: 'option-source', sourceName: name });
                entry.functionName = src.path.slice(1);
            } else if (src.path) {
                noteField(src.path, 'array', { kind: 'option-source', sourceName: name });
                entry.dataPath = src.path;
            }
        } else {
            entry.values = src.values ?? [];
        }
        if (src.binding) {
            // Default-target hint: not strictly needed in the data shape, but record
            entry.defaultBinding = src.binding;
        }
        optionSources.push(entry);
    }

    // Tooltip fragments may reference data paths or functions
    for (const [key, frags] of Object.entries(ast.tooltips ?? {})) {
        visitFragments(frags, { kind: 'tooltip', tooltipKey: key });
    }

    visit(ast.root, null);

    // Sort each field's `sources` and each function's `contexts`
    // by source line so a consumer reading `[0]` gets the earliest
    // mention of the field. Without this, the visit order (which
    // walks tooltips before the form root) can put a tooltip
    // reference ahead of the control that uses the same field, and
    // `sources[0]` ends up pointing at the tooltip instead of the
    // control. Stable ordering across runs.
    const sortByLine = (a, b) => (a.line ?? 0) - (b.line ?? 0);

    return {
        fields: Array.from(fields.entries()).map(([path, info]) => ({
            path,
            type: info.type,
            sources: info.sources.slice().sort(sortByLine)
        })),
        functions: Array.from(functions.entries()).map(([name, info]) => ({
            name,
            inferredReturns: info.inferredReturns,
            contexts: info.contexts.slice().sort(sortByLine)
        })),
        repeaters,
        optionSources,
        tooltips: Object.keys(ast.tooltips ?? {})
    };
}

// ---------------------------------------------------------------
// Scaffolders. These turn the inferred schema into copy-paste code
// the consumer can drop into their host app.
// ---------------------------------------------------------------

export function scaffoldDataObject(schema, opts = {}) {
    const indent = opts.indent ?? '    ';
    const lines = ['{'];
    const root = buildNested(schema);
    emitObject(root, lines, 1, indent);
    lines.push('}');
    return lines.join('\n');
}

export function scaffoldDataClass(schema, className = 'FormData', opts = {}) {
    const indent = opts.indent ?? '    ';
    const lines = [];
    lines.push(`class ${className} {`);
    lines.push(`${indent}constructor() {`);
    const root = buildNested(schema);
    emitFieldAssignments(root, lines, 2, indent, 'this');
    lines.push(`${indent}}`);

    if (schema.functions.length > 0) {
        lines.push('');
        lines.push(`${indent}// Function references the form expects this object (or a registry) to provide.`);
        lines.push(`${indent}// Each is called with the data object at render time and should return the noted type.`);
        for (const fn of schema.functions) {
            const ret = fn.inferredReturns === 'array'  ? '[]'
                     :  fn.inferredReturns === 'string' ? "''"
                     :  'null';
            lines.push(`${indent}${fn.name}(data) { return ${ret}; }   // returns ${fn.inferredReturns}`);
        }
    }

    lines.push('}');
    return lines.join('\n');
}

export function scaffoldTypeScript(schema, ifaceName = 'FormData') {
    const lines = [];
    lines.push(`export interface ${ifaceName} {`);
    const root = buildNested(schema);
    emitTSFields(root, lines, 1, '    ');
    lines.push('}');

    if (schema.functions.length > 0) {
        lines.push('');
        lines.push(`export interface ${ifaceName}Functions {`);
        for (const fn of schema.functions) {
            const ret = fn.inferredReturns === 'array'  ? 'unknown[]'
                     :  fn.inferredReturns === 'string' ? 'string'
                     :  'unknown';
            lines.push(`    ${fn.name}: (data: ${ifaceName}) => ${ret};`);
        }
        lines.push('}');
    }
    return lines.join('\n');
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

// Convert flat `[{path, type}]` into a nested tree:
//   { kind: 'object', children: { foo: ..., bar: { kind: 'array-of', elementShape: {...} } } }
function buildNested(schema) {
    const root = { kind: 'object', children: Object.create(null) };
    for (const f of schema.fields) {
        placePath(root, f.path, f.type);
    }
    // Mark repeater paths as array-of-element
    for (const r of schema.repeaters) {
        // The path here is something like 'routes', already in the
        // map as type 'array'. The goal in this loop is to merge in
        // the element shape from any 'routes[].x' entries so the
        // scaffolder can emit `routes: [{ x: '' }]` instead of just
        // `routes: []`.
        const elementPaths = schema.fields.filter(f => f.path.startsWith(r.arrayPath + '[].'));
        if (elementPaths.length > 0) {
            const elementShape = { kind: 'object', children: Object.create(null) };
            for (const ef of elementPaths) {
                const subPath = ef.path.slice(r.arrayPath.length + 3);  // strip 'foo[].'
                placePath(elementShape, subPath, ef.type);
            }
            // Attach to the array node at r.arrayPath
            const arrayNode = lookupPath(root, r.arrayPath);
            if (arrayNode) {
                arrayNode.kind = 'array-of';
                arrayNode.elementShape = elementShape;
            }
        }
    }
    return root;
}

function placePath(root, path, type) {
    if (path.includes('[]')) return;  // handled in buildNested via repeaters
    const parts = path.split('.');
    // Defensive: a hand-built AST could in theory carry a binding
    // path with a prototype-walking segment. Skip the whole path
    // rather than write into the prototype chain. The parser rejects
    // these segments at parse time, so this guard only fires when a
    // consumer constructed the AST themselves.
    if (parts.some(isReservedObjectKey)) return;
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
        const seg = parts[i];
        if (!cur.children[seg]) cur.children[seg] = { kind: 'object', children: Object.create(null) };
        cur = cur.children[seg];
    }
    cur.children[parts[parts.length - 1]] = { kind: 'leaf', type };
}

function lookupPath(root, path) {
    const parts = path.split('.');
    let cur = root;
    for (const seg of parts) {
        if (isReservedObjectKey(seg)) return null;
        cur = cur?.children?.[seg];
        if (!cur) return null;
    }
    return cur;
}

function emitObject(node, lines, depth, indent) {
    const entries = Object.entries(node.children);
    entries.forEach(([key, child], i) => {
        const tail = i < entries.length - 1 ? ',' : '';
        const padded = indent.repeat(depth);
        if (child.kind === 'leaf') {
            const v = child.type?.defaultValue ?? 'null';
            lines.push(`${padded}${key}: ${v}${tail}`);
        } else if (child.kind === 'array-of') {
            lines.push(`${padded}${key}: [`);
            lines.push(`${indent.repeat(depth + 1)}{`);
            emitObject(child.elementShape, lines, depth + 2, indent);
            lines.push(`${indent.repeat(depth + 1)}}`);
            lines.push(`${padded}]${tail}`);
        } else {
            lines.push(`${padded}${key}: {`);
            emitObject(child, lines, depth + 1, indent);
            lines.push(`${padded}}${tail}`);
        }
    });
}

function emitFieldAssignments(node, lines, depth, indent, base) {
    for (const [key, child] of Object.entries(node.children)) {
        const padded = indent.repeat(depth);
        const ref = `${base}.${key}`;
        if (child.kind === 'leaf') {
            const v = child.type?.defaultValue ?? 'null';
            lines.push(`${padded}${ref} = ${v};`);
        } else if (child.kind === 'array-of') {
            lines.push(`${padded}${ref} = [{`);
            const elementLines = [];
            emitObject(child.elementShape, elementLines, depth + 1, indent);
            for (const l of elementLines) lines.push(l);
            lines.push(`${padded}}];`);
        } else {
            lines.push(`${padded}${ref} = {};`);
            emitFieldAssignments(child, lines, depth, indent, ref);
        }
    }
}

function emitTSFields(node, lines, depth, indent) {
    for (const [key, child] of Object.entries(node.children)) {
        const padded = indent.repeat(depth);
        if (child.kind === 'leaf') {
            const t = child.type?.tsType ?? 'unknown';
            lines.push(`${padded}${key}: ${t};`);
        } else if (child.kind === 'array-of') {
            lines.push(`${padded}${key}: {`);
            emitTSFields(child.elementShape, lines, depth + 1, indent);
            lines.push(`${padded}}[];`);
        } else {
            lines.push(`${padded}${key}: {`);
            emitTSFields(child, lines, depth + 1, indent);
            lines.push(`${padded}};`);
        }
    }
}

// ---------------------------------------------------------------
// JSON Schema (Draft 2020-12) export
//
// Walks the inferred schema's flat field list and emits a Draft
// 2020-12 document the rest of a consumer's toolchain (Ajv,
// openapi-typescript, OpenAPI generators) can consume directly.
// Repeater paths (`arr[].x`) become array-of-object branches.

/**
 * Emit a JSON Schema (Draft 2020-12) document describing the data
 * shape this form binds. The output is a JS object the caller can
 * `JSON.stringify` and feed to Ajv / openapi-typescript / etc.
 *
 * @param {InferredSchema} schema  result of `inferDataSchema(ast)`
 * @param {string} [name='FormData']  schema title; also used in `$id`
 * @returns {object} a JSON Schema document
 */
export function scaffoldJsonSchema(schema, name = 'FormData') {
    const root = { type: 'object', properties: {}, required: [] };
    for (const f of schema.fields ?? []) {
        seedJsonSchemaPath(root, f.path.split('.'), f.type);
    }
    return {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        $id: `urn:formbuilder-dsl:${name}`,
        title: name,
        ...root
    };
}

function seedJsonSchemaPath(root, parts, type) {
    // Reserved-segment screen, mirroring `placePath` above. The
    // parser-side guard (`assertSafeObjectKey`) makes a reserved
    // segment unreachable from a parser-produced AST. A consumer
    // handing in a hand-built AST could still slip one through;
    // refusing the path here keeps the JSON-Schema output free of
    // a `properties.__proto__` write into a plain-object map.
    if (parts.some(s => isReservedObjectKey(s.endsWith('[]') ? s.slice(0, -2) : s))) return;
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
        const seg = parts[i];
        // Repeater leg: `arr[]` becomes an array of objects.
        if (seg.endsWith('[]')) {
            const arrName = seg.slice(0, -2);
            cur.properties[arrName] ??= { type: 'array', items: { type: 'object', properties: {}, required: [] } };
            cur = cur.properties[arrName].items;
        } else {
            cur.properties[seg] ??= { type: 'object', properties: {}, required: [] };
            cur = cur.properties[seg];
        }
    }
    const leaf = parts[parts.length - 1];
    cur.properties[leaf] = jsonSchemaTypeFor(type);
    cur.required.push(leaf);
}

function jsonSchemaTypeFor(type) {
    if (!type) return { type: 'string' };
    switch (type.jsType) {
        case 'string':  return { type: 'string'  };
        case 'number':  return { type: 'number'  };
        case 'boolean': return { type: 'boolean' };
        case 'array':   return { type: 'array', items: { type: 'string' } };
        case 'object':  return { type: 'object' };
        default:        return { type: 'string' };
    }
}
