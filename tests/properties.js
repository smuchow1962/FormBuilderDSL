// Property-collector test suite — exercises the mmpform document
// processor's __properties pass.
//
// Every entry in __properties is { type, default }. Type resolution:
//   inline {name:type} > __dataType="..." > control's default type.
// Default resolution:
//   literal init="..." > zero value for the resolved type
//   (int/float→0, bool→false, string→"", string[]→[]).
//
// What this proves, in order:
//   1. process() returns an AST whose __properties dictionary contains
//      every {name} binding in the layout, each shaped {type, default}.
//   2. Documents WITHOUT init= fall back to per-type zero defaults.
//   3. Documents WITH literal init= use the init value as the default.
//   4. __dataType= on a control overrides the per-control default type
//      and the matching zero default applies.
//   5. Inline {name:type} beats __dataType beats control default.
//   6. validateProperties flags missing entries, wrong types, and wrong
//      defaults independently.
//   7. collectProperties does not mutate the AST.
//   8. process() ignores function bindings, dotted paths, this.x.
//   9. renderPropertiesBlock produces the canonical DSL block.
//  10. A __properties block round-trips through parse + process and is
//      always overwritten by the freshly-collected dictionary.
//
// Run with: node tests/properties.js

import {
    TextFormBuilder,
    ERR,
    errorName,
    collectProperties,
    validateProperties,
    renderPropertiesBlock
} from '../src/index.js';

function header(title) { console.log(`\n=== ${title} ===`); }
function fail(msg) { console.error(`FAIL: ${msg}`); process.exit(1); }
function assertEq(actual, expected, label) {
    const a = JSON.stringify(actual, sortKeys);
    const e = JSON.stringify(expected, sortKeys);
    if (a !== e) fail(`${label}: expected ${e}, got ${a}`);
}
function sortKeys(_, value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return Object.keys(value).sort().reduce((o, k) => { o[k] = value[k]; return o; }, {});
    }
    return value;
}
function assertTrue(cond, label) { if (!cond) fail(label); }

function processOk(schemaText) {
    const result = new TextFormBuilder({ schemaText }).process();
    if (result.error !== ERR.OK) {
        console.error(`process failed (${errorName(result.error)}):`);
        for (const m of result.messages) console.error('  -', m);
        fail('process unexpectedly errored');
    }
    return result.payload;
}

// ---------------------------------------------------------------
// 1. process() attaches __properties as { name: { type, default } }.
// ---------------------------------------------------------------
header('process() attaches __properties as {type, default} entries');
{
    const ast = processOk(`columns: 20

[container({title},{description})]

  - [textfield(10,{logDirectory})] Logging Directory
    | [textfield(6,{logFileTemplate})] File Name Template
  - [number(5,{port})] Port
  - [toggle(3,{rollingLogsEnabled})] Rolling Logs
  - [fileSize(6,{maxBytes})] Max Size
  - [float(5,{cpuShare})] CPU Share
`);

    assertTrue(ast.__properties != null, '__properties present');
    assertEq(ast.__properties, {
        logDirectory:        { type: 'string', default: '' },
        logFileTemplate:     { type: 'string', default: '' },
        port:                { type: 'int',    default: 0  },
        rollingLogsEnabled:  { type: 'bool',   default: false },
        maxBytes:            { type: 'string', default: '' },
        cpuShare:            { type: 'float',  default: 0  }
    }, 'every entry carries type + default');
    console.log('OK');
}

// ---------------------------------------------------------------
// 2. Without init=, every default is the per-type zero value.
// ---------------------------------------------------------------
header('Missing init= → per-type zero defaults');
{
    const ast = processOk(`columns: 20

levels = ["debug","info","warn"] -> {logLevel}
modes  = ["a","b","c"] -> {modesPicked}
tags   = ["red","green","blue"] -> {tagSet}

[container({t},{d})]

  - [number(5,{port})] Port
  - [float(5,{cpuShare})] CPU Share
  - [toggle(3,{enabled})] Enabled
  - [check(3,{verbose})] Verbose
  - [textfield(6,{userName})] Name
  - [fileSize(5,{maxBytes})] Max Size
  - [select(5,#levels,{logLevel})] Log Level
  - [combo(5,#tags,{tagSet})] Tags
  - [multiselect(5,#modes,{modesPicked})] Modes
`);

    assertEq(ast.__properties.port,        { type: 'int',      default: 0 },     'int default 0');
    assertEq(ast.__properties.cpuShare,    { type: 'float',    default: 0 },     'float default 0');
    assertEq(ast.__properties.enabled,     { type: 'bool',     default: false }, 'bool default false (toggle)');
    assertEq(ast.__properties.verbose,     { type: 'bool',     default: false }, 'bool default false (check)');
    assertEq(ast.__properties.userName,    { type: 'string',   default: '' },    'string default ""');
    assertEq(ast.__properties.maxBytes,    { type: 'string',   default: '' },    'fileSize default ""');
    assertEq(ast.__properties.logLevel,    { type: 'string',   default: '' },    'select picks one → string default ""');
    assertEq(ast.__properties.tagSet,      { type: 'string',   default: '' },    'combo picks or types one → string default ""');
    assertEq(ast.__properties.modesPicked, { type: 'string[]', default: [] },    'multiselect collects many → string[] default []');
    console.log('OK');
}

// ---------------------------------------------------------------
// 3. Literal init= fills in the default; type inferred as before.
// ---------------------------------------------------------------
header('Literal init= sets the property default');
{
    const ast = processOk(`columns: 20

[container({t},{d})]

  - [number(5,{port},init=8080)] Port
  - [toggle(3,{enabled},init=true)] Enabled
  - [textfield(6,{userName},init="anonymous")] User Name
  - [float(5,{cpuShare},init=0.5)] CPU Share
`);

    assertEq(ast.__properties.port,     { type: 'int',    default: 8080 },        'init=8080 → int default 8080');
    assertEq(ast.__properties.enabled,  { type: 'bool',   default: true },        'init=true → bool default true');
    assertEq(ast.__properties.userName, { type: 'string', default: 'anonymous' }, 'init="..." → string default');
    assertEq(ast.__properties.cpuShare, { type: 'float',  default: 0.5 },         'init=0.5 → float default 0.5');
    console.log('OK');
}

// ---------------------------------------------------------------
// 4. __dataType overrides the control's default TYPE; the default
//    value follows the new type's zero (since no init= was given).
// ---------------------------------------------------------------
header('__dataType overrides type — zero default tracks the new type');
{
    const ast = processOk(`columns: 12

[container({t},{d})]

  - [textfield(6,{userId},__dataType="int")] User ID
  - [number(3,{label},__dataType="string")] Label
  - [textfield(6,{flag},__dataType="bool")] Flag
  - [textfield(6,{ratio},__dataType="float")] Ratio
`);

    assertEq(ast.__properties.userId, { type: 'int',    default: 0 },     'textfield + __dataType=int  → 0');
    assertEq(ast.__properties.label,  { type: 'string', default: '' },    'number + __dataType=string  → ""');
    assertEq(ast.__properties.flag,   { type: 'bool',   default: false }, 'textfield + __dataType=bool → false');
    assertEq(ast.__properties.ratio,  { type: 'float',  default: 0 },     'textfield + __dataType=float → 0');
    console.log('OK');
}

// ---------------------------------------------------------------
// 5. Inline {name:type} beats __dataType beats control default.
// ---------------------------------------------------------------
header('Inline {name:type} beats __dataType beats default');
{
    const ast = processOk(`columns: 12

[container({t},{d})]

  - [number(5,{a})] Default
  - [number(5,{b},__dataType="string")] Override
  - [number(5,{c:bool},__dataType="string")] Inline wins
  - [number(5,{d:float},init=2.5)] Inline With Init
`);

    assertEq(ast.__properties.a, { type: 'int',    default: 0 },     'a uses control default + zero');
    assertEq(ast.__properties.b, { type: 'string', default: '' },    'b uses __dataType + zero');
    assertEq(ast.__properties.c, { type: 'bool',   default: false }, 'c uses inline :type, beats __dataType');
    assertEq(ast.__properties.d, { type: 'float',  default: 2.5 },   'd combines inline :type and init=');
    console.log('OK');
}

// ---------------------------------------------------------------
// 6. validateProperties reports missing entries, wrong types, and
//    wrong defaults independently.
// ---------------------------------------------------------------
header('validateProperties flags missing / wrong type / wrong default');
{
    const ast = processOk(`columns: 12

[container({t},{d})]

  - [number(5,{port},init=8080)] Port
  - [textfield(6,{userName})] User Name
`);

    // Drop one entry → missing diagnostic.
    const missing = { ...ast, __properties: { port: { type: 'int', default: 8080 } } };
    const e1 = validateProperties(missing);
    assertEq(e1.length, 1, 'one error for missing entry');
    assertTrue(e1[0].includes("'userName'"), 'missing diagnostic mentions userName');

    // Wrong type → type-mismatch diagnostic.
    const wrongType = {
        ...ast,
        __properties: {
            port:     { type: 'string', default: '' },
            userName: { type: 'string', default: '' }
        }
    };
    const e2 = validateProperties(wrongType);
    assertEq(e2.length, 1, 'one error for wrong type');
    assertTrue(e2[0].includes('.type'), 'mentions .type');
    assertTrue(e2[0].includes("'string'"), 'mentions wrong type');
    assertTrue(e2[0].includes("'int'"),    'mentions correct type');

    // Right type, wrong default → default-mismatch diagnostic.
    const wrongDefault = {
        ...ast,
        __properties: {
            port:     { type: 'int',    default: 22 },
            userName: { type: 'string', default: '' }
        }
    };
    const e3 = validateProperties(wrongDefault);
    assertEq(e3.length, 1, 'one error for wrong default');
    assertTrue(e3[0].includes('.default'), 'mentions .default');
    assertTrue(e3[0].includes('22'),       'mentions wrong default');
    assertTrue(e3[0].includes('8080'),     'mentions correct default');

    // Strip __properties entirely → "missing dictionary" diagnostic.
    const stripped = { ...ast };
    delete stripped.__properties;
    const e4 = validateProperties(stripped);
    assertEq(e4.length, 1, 'one error for missing dictionary');
    assertTrue(e4[0].includes('__properties'), 'diagnostic mentions __properties');
    console.log('OK');
}

// ---------------------------------------------------------------
// 7. collectProperties is pure — does not mutate the AST.
// ---------------------------------------------------------------
header('collectProperties is pure');
{
    const builder = new TextFormBuilder({
        schemaText: `columns: 10

[container({t},{d})]

  - [textfield(6,{userName})] Name
`
    });
    const parsed = builder.parse();
    assertEq(parsed.error, ERR.OK, 'parse OK');
    assertTrue(parsed.payload.__properties == null, 'parse() does not attach __properties');

    const props = collectProperties(parsed.payload);
    assertEq(props, { userName: { type: 'string', default: '' } }, 'collectProperties returns dictionary');
    assertTrue(parsed.payload.__properties == null, 'collectProperties did not mutate AST');
    console.log('OK');
}

// ---------------------------------------------------------------
// 8. process() ignores function bindings, dotted paths, this.x.
// ---------------------------------------------------------------
header('process() ignores ineligible bindings');
{
    const ast = processOk(`columns: 20

[container({t},{d})]

  - [display(8,{@formatStatus})] Status
  - [textfield(6,{userName})] User
  - [repeater({routes},min=1)] Routes
      - [textfield(6,{this.match})] Match
        | [textfield(6,{this.target})] Target
`);
    const keys = Object.keys(ast.__properties).sort();
    assertEq(keys, ['userName'], 'only the simple-name control binding becomes a property');
    assertEq(ast.__properties.userName, { type: 'string', default: '' }, 'userName carries type + default');
    console.log('OK');
}

// ---------------------------------------------------------------
// 9. renderPropertiesBlock produces the canonical DSL text.
// ---------------------------------------------------------------
header('renderPropertiesBlock canonical text');
{
    const text = renderPropertiesBlock({
        port:     { type: 'int',      default: 8080 },
        userName: { type: 'string',   default: 'anonymous' },
        active:   { type: 'bool',     default: false },
        modes:    { type: 'string[]', default: ['a', 'b'] }
    });
    const expected = [
        '__properties = [',
        '    "active" = { type: "bool", default: false },',
        '    "modes" = { type: "string[]", default: ["a", "b"] },',
        '    "port" = { type: "int", default: 8080 },',
        '    "userName" = { type: "string", default: "anonymous" }',
        ']'
    ].join('\n');
    assertEq(text, expected, 'sorted, indented, full {type, default} entries');

    assertEq(renderPropertiesBlock({}), '__properties = []', 'empty dict');
    console.log('OK');
}

// ---------------------------------------------------------------
// 10. process() merges the explicit __properties block with the
//     form's discoveries. Discovered type overwrites declared type;
//     init= literal overwrites declared default; everything else
//     in the declared block survives.
// ---------------------------------------------------------------
header('__properties block round-trips through parse + process (merge model)');
{
    const src = `columns: 12

__properties = [
    "port" = { type: "string", default: "wrong" },
    "userName" = { type: "string", default: "" }
]

[container({t},{d})]

  - [number(5,{port},init=22)] Port
  - [textfield(6,{userName})] User Name
`;

    // Parse alone preserves the hand-written block as-is.
    const parsed = new TextFormBuilder({ schemaText: src }).parse();
    assertEq(parsed.error, ERR.OK, 'parse OK');
    assertEq(parsed.payload.__properties, {
        port:     { type: 'string', default: 'wrong' },
        userName: { type: 'string', default: '' }
    }, 'parser stores the block as-is');

    // process() merges. port: type changes to 'int' (discovery
    // wins), default changes to 22 (init= literal). userName: type
    // matches; no init=, default stays as declared.
    const processed = new TextFormBuilder({ schemaText: src }).process();
    assertEq(processed.error, ERR.OK, 'process OK');
    assertEq(processed.payload.__properties, {
        port:     { type: 'int',    default: 22 },
        userName: { type: 'string', default: '' }
    }, 'process() merges discoveries over the declared block');

    // The change list is on the AST as a non-enumerable field plus
    // human-readable strings in messages.
    const changes = processed.payload.__propertyChanges;
    assertTrue(Array.isArray(changes), 'change list present');
    assertEq(changes.length, 2, 'two changes for port (type + default)');
    assertTrue(
        processed.messages.some(m => /port.*type.*string.*int/.test(m)),
        'type change in messages'
    );

    // The merged block round-trips through render -> parse -> render
    // and produces identical text both times. The next process()
    // sees no further changes.
    const text1 = renderPropertiesBlock(processed.payload.__properties);
    const reparsed = new TextFormBuilder({
        schemaText: `columns: 12

${text1}

[container({t},{d})]

  - [number(5,{port},init=22)] Port
  - [textfield(6,{userName})] User Name
`
    }).process();
    assertEq(reparsed.error, ERR.OK, 'reparse OK');
    const text2 = renderPropertiesBlock(reparsed.payload.__properties);
    assertEq(text2, text1, 'render -> parse -> render is stable');
    assertTrue(
        reparsed.payload.__propertyChanges == null,
        'second process() reports no further changes'
    );
    console.log('OK');
}

// ---------------------------------------------------------------
// 10b. process() with NO __properties block discovers everything
//      from the form (existing dict starts empty).
// ---------------------------------------------------------------
header('process() without explicit block discovers from the form');
{
    const src = `columns: 12

[container({t},{d})]

  - [number(5,{port},init=22)] Port
  - [textfield(6,{userName})] User Name
`;
    const processed = new TextFormBuilder({ schemaText: src }).process();
    assertEq(processed.error, ERR.OK, 'process OK');
    assertEq(processed.payload.__properties, {
        port:     { type: 'int',    default: 22 },
        userName: { type: 'string', default: '' }
    }, 'process() discovered everything');
    // No declared dict -> no overwrites -> no changes.
    assertTrue(
        processed.payload.__propertyChanges == null,
        'no change list on a clean discovery'
    );
    console.log('OK');
}

// ---------------------------------------------------------------
// 10c. A declared property the form does not bind survives the merge.
// ---------------------------------------------------------------
header('process() preserves declared sink-only properties');
{
    const src = `columns: 12

__properties = [
    "sinkOnly" = { type: "string", default: "kept" },
    "port"     = { type: "int",    default: 8080 }
]

[container({t})]

  - [number(5,{port},init=22)] Port
`;
    const processed = new TextFormBuilder({ schemaText: src }).process();
    assertEq(processed.error, ERR.OK, 'process OK');
    assertEq(processed.payload.__properties, {
        sinkOnly: { type: 'string', default: 'kept' },
        port:     { type: 'int',    default: 22 }
    }, 'sinkOnly stays; port default overwritten by init=22');
    console.log('OK');
}

console.log('\nAll property tests passed.\n');
