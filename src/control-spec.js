// Default control vocabulary. The parser is type-agnostic; it consults
// this registry to know what each type accepts, what defaults to apply,
// and what shapes are valid. Adding a control type is adding an entry.

// Allowed values for the universal __dataType override (and for the
// optional `:type` suffix on a control binding). The list is short on
// purpose. These are the primitive shapes a sink consumer can
// serialize without doing any extra coercion. List-of-strings comes
// from the per-control default table below (combo, multiselect), not
// from __dataType.
export const ALLOWED_DATA_TYPES = Object.freeze(['int', 'float', 'bool', 'string']);

// Default data type emitted into the __properties dictionary when a
// binding doesn't carry its own `:type` and the control doesn't declare
// __dataType. The processor uses this table; the parser stays neutral.
//
// Selection-style controls split by cardinality:
//   select / radio / combo   one chosen value (string)
//   multiselect              multi-pick (string[])
//
// `combo` is single-pick like select, but the chosen value can be
// either an entry from the option source or a value the user types
// freely. The data type is still string because the consumer reads
// one value off the binding.
export const DEFAULT_DATA_TYPE_BY_CONTROL = Object.freeze({
    textfield:        'string',
    textarea:         'string',
    password:         'string',
    number:           'int',
    float:            'float',
    slider:           'float',
    check:            'bool',
    toggle:           'bool',
    select:           'string',       // single chosen value from the option source
    combo:            'string',       // single chosen value (entered or picked)
    radio:            'string',       // single chosen value
    multiselect:      'string[]',     // multi-pick value list
    date:             'string',
    time:             'string',
    datetime:         'string',
    daterange:        'string',
    file:             'string',
    fileSize:         'string',
    fileBrowser:      'string',
    directoryBrowser: 'string',
    color:            'string',
    hidden:           'string',
    display:          'string',
    label:            null            // label has no binding; never collected
});

export const defaultControlSpec = Object.freeze({
    __common: {
        params: {
            when:       { type: 'expression', default: null },
            tt:         { type: 'string',     default: null },
            init:       { type: 'init',           default: null },
            // compute= names a function the renderer re-runs as data
            // changes. Only the {@fn} shape has semantics here:
            // a literal value is a no-op, and a {path} binding is more
            // naturally written as the control's own binding. The
            // dedicated 'computeFunction' type keeps the parser
            // honest with what the AST type promises.
            compute:    { type: 'computeFunction', default: null },
            explain:    { type: 'textOrRef',  default: null },
            // Universal override for the property's emitted data type.
            // When set, beats the control's default; loses to an inline
            // `:type` written directly on the binding (`{name:type}`).
            __dataType: { type: 'enum', values: ['int', 'float', 'bool', 'string'], default: null }
        }
    },

    // Text input
    textfield: {
        params: {
            maxLength:   { type: 'integer' },
            placeholder: { type: 'string' },
            pattern:     { type: 'string' }
        }
    },
    textarea: {
        params: {
            rows:        { type: 'integer', default: 4 },
            maxLength:   { type: 'integer' },
            placeholder: { type: 'string' }
        }
    },
    password: {
        secret: true,
        params: {
            reveal:    { type: 'boolean', default: false },
            minLength: { type: 'integer' }
        }
    },

    // Numeric
    number: {
        params: {
            min:  { type: 'number' },
            max:  { type: 'number' },
            step: { type: 'number', default: 1 }
        }
    },
    float: {
        params: {
            min:      { type: 'number' },
            max:      { type: 'number' },
            step:     { type: 'number',  default: 0.1 },
            decimals: { type: 'integer', default: 2 }
        }
    },
    slider: {
        params: {
            min:  { type: 'number' },
            max:  { type: 'number' },
            step: { type: 'number', default: 1 }
        }
    },

    // Boolean
    check:  { params: {} },
    toggle: { params: {} },

    // Choice (single value)
    select: { optionsRef: 'required', params: {} },
    combo:  { optionsRef: 'required', params: {} },
    radio:  { optionsRef: 'required', params: {} },

    // Choice (multiple values)
    multiselect: {
        optionsRef: 'required',
        params: {
            min: { type: 'integer' },
            max: { type: 'integer' }
        }
    },

    // Date and time
    date: {
        params: {
            min:    { type: 'date' },
            max:    { type: 'date' },
            format: { type: 'string' }
        }
    },
    time: {
        params: {
            format: { type: 'string' },
            step:   { type: 'integer' }
        }
    },
    datetime: {
        params: {
            min:    { type: 'date' },
            max:    { type: 'date' },
            format: { type: 'string' }
        }
    },
    daterange: {
        bindingShape: '{start,end}',
        params: {
            min: { type: 'date' },
            max: { type: 'date' }
        }
    },

    // Files / specialized
    file: {
        params: {
            accept:   { type: 'string' },
            maxBytes: { type: 'integer' }
        }
    },
    fileSize: {
        params: {
            // Units shown in the dropdown, in order.
            units:       { type: 'string', default: 'Kb,Mb,Gb,Tb' },
            // Unit applied if the binding's current value has no scale suffix.
            defaultUnit: { type: 'string', default: 'Mb' },
            // Number-input precision passed through to the amount field.
            step:        { type: 'number', default: 0.1 },
            min:         { type: 'number', default: 0 }
        }
    },
    fileBrowser: {
        params: {
            accept:    { type: 'string' },
            maxBytes:  { type: 'integer' },
            multiple:  { type: 'boolean', default: false }
        }
    },
    directoryBrowser: {
        params: {}
    },
    color:  { params: {} },
    hidden: {
        width: { default: 0 },
        params: {}
    },

    // Display-only
    label: {
        binding:    'forbidden',
        contentRef: 'allowed',         // #name pulls content from named text
        params: {
            style: {
                type:    'enum',
                values:  ['heading', 'note', 'divider', 'help'],
                default: 'note'
            }
        }
    },
    display: {
        readOnly:   true,
        contentRef: 'allowed',         // #name as alternative to {binding}
        params: {
            format: { type: 'string' }
        }
    }
});

const RESERVED = Object.freeze(new Set(['container', 'repeater', 'listManager', 'this']));

const ALLOWED_TYPES = Object.freeze(new Set([
    'string', 'integer', 'number', 'boolean', 'enum', 'date', 'expression',
    'init', 'computeFunction', 'textOrRef'
]));

// Two-value vocabulary. Every shipped control either needs a
// binding (`required`, the default) or refuses one (`forbidden`,
// used by `label`). The parser's two checks live in
// parse-controls.js and branch on these names directly; adding a
// third value would need a third check there too.
const ALLOWED_BINDING = Object.freeze(new Set(['required', 'forbidden']));
const ALLOWED_OPT_REF = Object.freeze(new Set(['required', 'allowed', 'forbidden']));

// validateControlSpec is a pure function. It runs once per parse();
// the spec is typically under 20 entries, so the validation cost is
// sub-millisecond. The result is intentionally not cached: a
// consumer may reuse the same spec object across multiple builders
// and mutate it between parses, and re-validating on every call
// keeps the result honest without any cache-invalidation logic.
export function validateControlSpec(spec) {
    return computeSpecErrors(spec);
}

function computeSpecErrors(spec) {
    const errors = [];

    if (spec == null || typeof spec !== 'object') {
        return ['controlSpec must be an object'];
    }

    for (const name of Object.keys(spec)) {
        if (name === '__common') {
            const common = spec.__common;
            if (common.params != null && typeof common.params !== 'object') {
                errors.push(`__common.params must be an object`);
            } else if (common.params != null) {
                // Type-check each universal param entry up front.
                // Catching a malformed __common entry here means
                // registerControl rejects a bad spec instead of
                // letting the failure surface at the first parse()
                // call that touches the param.
                for (const [paramName, paramSpec] of Object.entries(common.params)) {
                    validateParamEntry(`__common.${paramName}`, paramSpec, errors);
                }
            }
            continue;
        }

        if (RESERVED.has(name)) {
            errors.push(`Reserved name '${name}' cannot be used as a control type`);
            continue;
        }

        const entry = spec[name];
        if (!entry || typeof entry !== 'object') {
            errors.push(`Spec entry for '${name}' must be an object`);
            continue;
        }

        if (entry.binding != null && !ALLOWED_BINDING.has(entry.binding)) {
            errors.push(`Spec '${name}': binding must be 'required' or 'forbidden'`);
        }
        if (entry.optionsRef != null && !ALLOWED_OPT_REF.has(entry.optionsRef)) {
            errors.push(`Spec '${name}': optionsRef must be one of required|allowed|forbidden`);
        }
        // A `#name` reference on a control routes to either
        // `contentRef` (a named-text reference) or `optionsSource`
        // (an option-source reference). The dispatcher in
        // parse-controls.js routes to contentRef first when both
        // are 'allowed', leaving optionsRef silently shadowed.
        // Refuse the ambiguous shape at spec-validation time so a
        // future contributor declaring both gets a clean message
        // instead of a bug report from a consumer who can't get
        // their option source to fire.
        if (entry.contentRef === 'allowed'
                && entry.optionsRef != null
                && entry.optionsRef !== 'forbidden') {
            errors.push(`Spec '${name}': cannot declare both contentRef:'allowed' and optionsRef:'${entry.optionsRef}'; pick one (a #name reference can route to a named-text body or an option source, not both)`);
        }
        // `width` may be the string 'required' (default) or an object with a
        // numeric `default`. Anything else is a malformed entry; lookupType
        // would still accept it by accident, so catch it here.
        if (entry.width != null) {
            const widthOk = entry.width === 'required'
                || (typeof entry.width === 'object'
                    && typeof entry.width.default === 'number');
            if (!widthOk) {
                errors.push(`Spec '${name}': width must be 'required' or { default: <number> }`);
            }
        }
        if (entry.params == null || typeof entry.params !== 'object') {
            errors.push(`Spec '${name}' missing required 'params' object`);
            continue;
        }

        for (const [paramName, paramSpec] of Object.entries(entry.params)) {
            validateParamEntry(`${name}.${paramName}`, paramSpec, errors);
        }
    }

    return errors;
}

// Shared param-entry validator. Used both for per-control `params`
// entries and for the universal `__common.params` entries so the two
// surfaces report identical errors and stay in sync.
function validateParamEntry(label, paramSpec, errors) {
    if (paramSpec == null || typeof paramSpec !== 'object') {
        errors.push(`Spec '${label}' must be an object`);
        return;
    }
    if (paramSpec.type != null && !ALLOWED_TYPES.has(paramSpec.type)) {
        errors.push(`Spec '${label}': unknown param type '${paramSpec.type}'`);
    }
    if (paramSpec.type === 'enum' && !Array.isArray(paramSpec.values)) {
        errors.push(`Spec '${label}': enum param requires 'values' array`);
    }
}

// Compose the effective per-type policy and params (common merged in).
export function lookupType(spec, typeName) {
    // Own-property check. A spec object that inherits from
    // Object.prototype would otherwise expose `constructor`,
    // `toString`, and friends as if they were registered control
    // types. We only ever want what the consumer actually put on
    // the spec, never what the prototype chain happens to carry.
    if (spec == null || !Object.prototype.hasOwnProperty.call(spec, typeName)) {
        return null;
    }
    const entry = spec[typeName];
    if (!entry) return null;

    // __common is also read defensively. A spec that overrides only
    // per-control entries shouldn't accidentally pick up an
    // Object.prototype `__common` (none exists today, but the rule
    // matches the entry guard above so the file stays uniform).
    const commonParams = (Object.prototype.hasOwnProperty.call(spec, '__common')
        ? spec.__common
        : null)?.params ?? {};
    const ownParams = entry.params ?? {};

    return {
        binding:      entry.binding ?? 'required',
        widthPolicy:  entry.width ?? 'required',  // 'required' or { default: N }
        optionsRef:   entry.optionsRef ?? 'forbidden',
        contentRef:   entry.contentRef ?? 'forbidden',
        secret:       entry.secret ?? false,
        readOnly:     entry.readOnly ?? false,
        bindingShape: entry.bindingShape ?? null,
        params:       { ...commonParams, ...ownParams }
    };
}

export function isReserved(name) {
    return RESERVED.has(name);
}
