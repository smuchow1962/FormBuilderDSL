/** FormBuilderDSL public types (ESM). */

export class TextFormBuilder {
    constructor(options?: {
        schemaText?: string;
        controlSpec?: ControlSpec;
        /** Caps the DSL source string length. Defaults to {@link DEFAULT_MAX_INPUT_LENGTH} (1 MB). */
        maxInputLength?: number;
        /** Caps container nesting. Defaults to {@link MAX_NESTING_DEPTH} (16). Past this, the parser raises INVALID_LAYOUT. */
        maxNestingDepth?: number;
    });
    schemaText: string;
    controlSpec: ControlSpec;
    /**
     * Caller-supplied cap on the DSL source string length, in bytes
     * of the source string. `undefined` means "use the default" — the
     * parser falls back to {@link DEFAULT_MAX_INPUT_LENGTH} (1 MB) at
     * parse time. The instance field stays `undefined` (not the
     * default value) so a consumer can tell "I never set this" apart
     * from "I set it to the default."
     *
     * Note: `when=` expressions inside the form are independently
     * capped at {@link DEFAULT_MAX_WHEN_SOURCE_LENGTH} (8 KB) and
     * {@link DEFAULT_MAX_WHEN_TOKENS} tokens. Raising the input cap
     * does not raise the expression cap. A consumer hosting trusted
     * forms with very large `when=` strings calls `parseWhen` /
     * `evaluateWhen` directly with the per-call options.
     */
    maxInputLength: number | undefined;
    /**
     * Caller-supplied cap on container nesting depth. `undefined`
     * means "use the default" — the parser falls back to
     * {@link MAX_NESTING_DEPTH} (16) at parse time. Past the cap, the
     * parser raises INVALID_LAYOUT. Same "undefined-vs-default" rule
     * as `maxInputLength` above.
     */
    maxNestingDepth: number | undefined;
    setSchemaText(text: string): void;
    registerControl(name: string, spec: ControlSpecEntry): TupleResponse<null>;
    parse(): TupleResponse<FormModel | null>;
    process(): TupleResponse<FormModel | null>;
    validateSchema(): TupleResponse<null>;
}

export class TupleResponse<T = unknown> {
    error: number;
    payload: T | null;
    messages: string[];
    static ok<T>(payload: T, messages?: string[]): TupleResponse<T>;
    static fail(error: number, messages: string | string[]): TupleResponse<null>;
    isOk(): boolean;
}

export class ParseError extends Error {
    /**
     * @param code     One of the {@link ERR} numeric codes.
     * @param message  Human-readable diagnostic.
     * @param line     1-based source line; `0` when the error has no source position.
     * @param col      1-based column on `line`; `0` when no column.
     */
    constructor(code: number, message: string, line?: number, col?: number);
    code: number;
    line: number;
    col: number;
    /** Returns "line N, col M: message" when location is known, otherwise just the message. */
    toMessage(): string;
}

export const ERR: Readonly<{
    OK: 0;
    LEX_ERROR: 1;
    PARSE_ERROR: 2;
    UNKNOWN_TYPE: 3;
    INVALID_PARAM: 4;
    INVALID_REF: 5;
    INVALID_LAYOUT: 6;
    INVALID_SPEC: 7;
    /** Unexpected exception inside the parser; the message carries the
     * error name, message, and the first stack frame. */
    INTERNAL_ERROR: 8;
}>;

export function errorName(code: number): string;

export const defaultControlSpec: Readonly<ControlSpec>;
export function validateControlSpec(spec: unknown): string[];
export function lookupType(
    spec: ControlSpec,
    typeName: string
): ControlSpecEntry | null;

/**
 * The control-spec contract. The parser is type-agnostic and reads
 * everything it needs about a control type from this dictionary.
 * Adding a control type is adding an entry. The default vocabulary
 * lives in `defaultControlSpec`; consumers extend it via the
 * builder's `controlSpec` option or via `registerControl()`.
 *
 * Validation runs on every parse via `validateControlSpec`. The
 * runtime is the source of truth; the type below mirrors what the
 * validator accepts so a TypeScript consumer authoring a custom
 * spec gets compile-time help. A typo'd `optionRef` (instead of
 * `optionsRef`) fails the type check before it reaches the parser.
 */
export interface ControlSpec {
    /**
     * Optional shared block. Every control inherits the params
     * declared here. The default spec uses it for cross-cutting
     * params like `when`, `tt`, `init`, `compute`, `explain`, and
     * `__dataType`.
     */
    __common?: { params: Record<string, ParamSpec> };
    /** Per-type entries, keyed by control name. */
    [controlName: string]: ControlSpecEntry | undefined;
}

/**
 * One entry in the control spec. Every field is optional; the
 * defaults named below match the runtime fallback when the field is
 * absent.
 */
export interface ControlSpecEntry {
    /**
     * Whether the control needs a `{name}` data binding. Default:
     * `'required'`. Set `'forbidden'` for display-only controls
     * (label is the only shipped example).
     */
    binding?: 'required' | 'forbidden';
    /**
     * Width policy. `'required'` (default) means the control must
     * declare its own integer width. `{ default: N }` means the
     * width may be omitted; if omitted, `N` is used.
     */
    width?: 'required' | { default: number };
    /**
     * `#name` reference policy for an option-source. `'required'`
     * means the control must reference an option-source.
     * `'allowed'` means a reference is optional. `'forbidden'`
     * (default) means a reference is rejected.
     */
    optionsRef?: 'required' | 'allowed' | 'forbidden';
    /**
     * `#name` reference policy for a named-text body. `'allowed'`
     * routes any `#name` on the control to `contentRef` rather than
     * `optionsSource`. The validator refuses a spec that combines
     * `contentRef: 'allowed'` with an active `optionsRef`.
     */
    contentRef?: 'allowed' | 'forbidden';
    /** Mark the control's data as secret (sinks may redact). */
    secret?: boolean;
    /** Mark the control as read-only (renderer hint). */
    readOnly?: boolean;
    /** Documentation-only hint about the binding shape. */
    bindingShape?: string;
    /** Per-param schema. Empty means no type-specific config. */
    params: Record<string, ParamSpec>;
}

/**
 * One parameter declaration on a control entry. The `type` field
 * names a coercion the parser knows how to apply; `default` is the
 * value populated when the source omits the parameter.
 *
 * Built-in coercions:
 *   - `'string'`            quoted string
 *   - `'integer'`           non-negative integer (use `negativeOk` to admit negatives)
 *   - `'number'`            integer or float
 *   - `'boolean'`           `true` / `false`
 *   - `'enum'`              one of the strings in `values`
 *   - `'date'`              ISO date string
 *   - `'expression'`        raw `when=`-style string
 *   - `'init'`              literal value or `{binding}` / `{@function}`
 *   - `'computeFunction'`   only `{@function}` shape
 *   - `'textOrRef'`         decorated text or a `#name` reference
 */
export interface ParamSpec {
    type: 'string' | 'integer' | 'number' | 'boolean'
        | 'enum' | 'date' | 'expression' | 'init'
        | 'computeFunction' | 'textOrRef';
    /** Allowed values for `type: 'enum'`. */
    values?: readonly string[];
    /** Value populated when the source omits the parameter. */
    default?: unknown;
    /** Admit negative integers for `type: 'integer'`. */
    negativeOk?: boolean;
    /**
     * Custom error message used when this param's value fails the
     * type check. Replaces the parser's generic message ("Param 'X'
     * must be an integer") with the consumer's vocabulary ("Port
     * must be between 1 and 65535"). Same `INVALID_PARAM` error
     * code; only the message text changes.
     */
    message?: string;
}
export function isReserved(name: string): boolean;
export const DEFAULT_DATA_TYPE_BY_CONTROL: Readonly<Record<string, string | null>>;
export const ALLOWED_DATA_TYPES: readonly string[];

export const DEFAULT_MAX_WHEN_SOURCE_LENGTH: number;
export const DEFAULT_MAX_WHEN_TOKENS: number;
export const DEFAULT_MAX_INPUT_LENGTH: number;
/** Cap on container nesting depth before the parser raises INVALID_LAYOUT. */
export const MAX_NESTING_DEPTH: number;
export const FORBIDDEN_PATH_SEGMENTS: ReadonlySet<string>;

/**
 * AST node shapes for a parsed `when=` expression. The seven node
 * kinds correspond to the grammar's seven productions: boolean
 * combinators (`or`, `and`, `not`), comparisons (`eq`, `neq`),
 * membership (`in`), and the two leaf shapes (`path`, `lit`).
 *
 * Consumers caching the parse can hold a `WhenAst | null` and
 * walk it themselves; the package's `evaluateWhen(source, data)`
 * re-parses on every call (per the no-AST-caching rule documented
 * in `architecture-no-ast-caching.md`), so a hot-loop consumer
 * caches the AST themselves and writes their own evaluator.
 */
export type WhenAst =
    | { kind: 'or';   l: WhenAst; r: WhenAst }
    | { kind: 'and';  l: WhenAst; r: WhenAst }
    | { kind: 'not';  x: WhenAst }
    | { kind: 'eq';   l: WhenAst; r: WhenAst }
    | { kind: 'neq';  l: WhenAst; r: WhenAst }
    | { kind: 'in';   l: WhenAst; list: Array<WhenAst & { kind: 'lit' }> }
    | { kind: 'path'; path: string[] }
    | { kind: 'lit';  v: string | number | boolean };

/**
 * Parse a `when=` string into a small AST (or `null` for empty).
 *
 * @throws {ParseError} when `source` exceeds `maxSourceLength`,
 *         exceeds `maxTokens`, or contains a grammar error.
 *         Callers should wrap in try / catch or pre-validate length.
 */
export function parseWhen(
    source: string | null | undefined,
    options?: { maxSourceLength?: number; maxTokens?: number }
): WhenAst | null;

/**
 * Evaluate a `when=` string against trusted host data.
 *
 * @throws {ParseError} when `source` is malformed or exceeds a cap
 *         (parsing is delegated to {@link parseWhen}).
 */
export function evaluateWhen(
    source: string | null | undefined,
    data: Record<string, unknown>,
    options?: { maxSourceLength?: number; maxTokens?: number }
): boolean;

/**
 * Evaluate an already-parsed `when=` AST against trusted host data.
 * The escape hatch from the no-AST-caching rule: cache `parseWhen(source)`
 * once at form-load time and feed the AST through this on every
 * render. Avoids the per-call re-parse `evaluateWhen` does.
 */
export function evaluateAst(
    ast: WhenAst | null,
    data: Record<string, unknown>
): boolean;

export function interpolate(
    text: string | null | undefined,
    data?: Record<string, unknown>,
    functions?: Record<string, (data: Record<string, unknown>) => unknown>,
    options?: { strict?: boolean }
): string;

export function parseDecorated(
    text: string | null | undefined,
    colorsMap?: Record<string, string>,
    sourceLine?: number
): TextFragment[];

export function renderFragments(
    fragments: TextFragment[],
    data?: Record<string, unknown>,
    functions?: Record<string, (data: Record<string, unknown>) => unknown>,
    opts?: { mode?: 'plain' | 'html'; strict?: boolean }
): string;

export function renderFormPreview(ast: FormModel | null | undefined, opts?: RenderPreviewOpts): string;

/**
 * Emit `.mmpform` source text from a parsed AST. The inverse of
 * `TextFormBuilder.parse()`. Useful for editor tooling that
 * mutates the AST and writes the source back, for "diff between
 * two parsed forms" workflows that need a normalised text shape,
 * and for machine-generated forms that need hand-readable output.
 *
 * Round-trip preserves AST equivalence (parse → render → parse
 * produces an equivalent AST). Comments and incidental whitespace
 * are not preserved; the output uses 4-space indent and canonical
 * field ordering so two ASTs that differ only by formatting
 * produce identical text.
 */
export function renderForm(
    ast: FormModel | null | undefined,
    opts?: { indent?: string }
): string;

/**
 * Walk every node of an AST or subtree, calling `visitor(node)` on
 * each. Visit order is source order (parent before children). Visits
 * every container kind, every row, every panel, every control. Pass
 * a FormModel and the walk starts at `root`; pass any node directly
 * and the walk starts there.
 *
 * The visitor cannot stop the walk early or skip a subtree — the
 * contract is "every node visited once, no signalling." A consumer
 * that needs short-circuit walks throws from inside the visitor and
 * catches at the call site.
 */
export function walkAst(
    astOrNode: FormModel | ContainerNode | RowNode | ControlNode | PanelNode | null | undefined,
    visitor: (node: FormModel | ContainerNode | RowNode | ControlNode | PanelNode) => void
): void;

export interface RenderPreviewOpts {
    width?: number;
    showInit?: boolean;
    showWhen?: boolean;
}

/** One TextStyle bundle attached to any TextFragment kind. */
export interface TextStyle {
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strikethrough?: boolean;
    sizeStep?: number;
    fg?: { name: string | null; resolved: string | null };
    bg?: { name: string | null; resolved: string | null };
}

/** A `text` fragment carries literal characters. */
export interface TextFragmentText {
    kind: 'text';
    text: string;
    style?: TextStyle;
}

/** A `binding` fragment is a `{path}` placeholder the renderer resolves at runtime. */
export interface TextFragmentBinding {
    kind: 'binding';
    path: string;
    style?: TextStyle;
}

/** A `function` fragment is a `{@name}` reference resolved against the function registry. */
export interface TextFragmentFunction {
    kind: 'function';
    name: string;
    style?: TextStyle;
}

/**
 * Discriminated-union of every fragment shape a consumer reads.
 * Consumers narrow on `kind` to read the kind-specific field
 * (`text`, `path`, or `name`). The parser uses an internal `ref`
 * shape during phase 1 to mark unresolved `#name` references, but
 * phase 2 either resolves every `ref` to a named-text body or
 * throws `INVALID_REF`, so no `ref` fragment ever surfaces here.
 */
export type TextFragment =
    | TextFragmentText
    | TextFragmentBinding
    | TextFragmentFunction;

/**
 * Scalar value a named-object body can hold. Bodies are flat: no
 * nested arrays, no nested objects, no `#name` references in value
 * position. The parser raises PARSE_ERROR for anything outside this
 * union. (See "Named-object body rule" in docs/architecture.md.)
 *
 * Date literals in the source (`YYYY-MM-DD` or
 * `YYYY-MM-DDTHH:MM:SS`) arrive on the value side as the raw ISO
 * string, not a JavaScript `Date` instance. A consumer that needs
 * a `Date` parses the string itself.
 */
export type NamedObjectValue = string | number | boolean | null;

/**
 * One named-object literal declared at the top level. A flat record
 * of keys to scalar values. The primary-key marker (`!fieldName` in
 * source) is stored on a non-enumerable internal field and does not
 * appear in this surface; consumers iterate `NamedObject` like any
 * plain dictionary.
 */
export type NamedObject = Record<string, NamedObjectValue>;

/**
 * One option-source registry entry.
 *
 * - `static`: a literal value list (`name = ["a","b","c"] -> {x}`).
 *   `values` carries the resolved scalars (a `#ref` to a named-object
 *   resolves to the object during phase 2). `path` is absent.
 * - `dynamic`: a single binding (`name = {dataPath}` or `name =
 *   {@fn}`). `path` is the dotted data path or `@functionName`.
 *   `values` is absent.
 *
 * `bindings` lists each `-> {ident}` clause (static only; always
 * empty on dynamic). `binding` is a back-compat shim that points at
 * `bindings[0]` or `null`.
 */
export interface OptionSource {
    type: 'static' | 'dynamic';
    values?: Array<NamedObjectValue | NamedObject>;
    path?: string;
    bindings: string[];
    binding: string | null;
}

/**
 * The form-model AST returned inside `TupleResponse.payload` on a
 * successful `parse()` or `process()` call.
 *
 * Note on `columns`: typed `number | null` because the field is
 * `null` on the partially-built model the parser threads through its
 * own helpers. After a successful parse it is always a positive
 * integer (the parser raises `PARSE_ERROR` for a missing `columns:`
 * declaration and `INVALID_PARAM` for a value < 1). A consumer
 * reading `result.payload.columns` after `result.error === ERR.OK`
 * can treat it as `number`.
 *
 * Note on `tooltips` and `namedText`: stored as `TextFragment[]`
 * arrays after phase 2. The parser collects raw text in phase 1
 * and rewrites each entry into fragments in phase 2 so colour names
 * are resolved against the now-complete `colors` map. A consumer
 * passes the array straight to `renderFragments` to get plain or
 * HTML output.
 *
 * Note on `namedObjects`: each value is the parsed object literal,
 * a flat record of the keys the source declared. The primary-key
 * marker (`!fieldName` in the source) is parser-internal metadata
 * and is not part of the public surface.
 *
 * Note on `__propertyChanges`: present on the AST after `process()`
 * runs and the merge with the existing `__properties` block produced
 * any overwrites. Each entry records what was changed and from what
 * value. Stored as a non-enumerable property at runtime so JSON
 * dumps stay clean; the type marks it `ReadonlyArray` so consumers
 * read but don't mutate.
 *
 * Non-fatal warnings (empty option-source list, duplicate values,
 * empty entries) are surfaced through `result.messages` on a
 * successful parse — never through a field on the AST. The parser
 * uses an internal channel to carry warnings from `parse()` to
 * `runParse()`, but that channel is not part of the public
 * contract. Always read warnings from the envelope.
 */
export interface FormModel {
    version: number;
    columns: number | null;
    optionSources: Record<string, OptionSource>;
    tooltips: Record<string, TextFragment[]>;
    colors: Record<string, string>;
    namedText: Record<string, TextFragment[]>;
    namedObjects: Record<string, NamedObject>;
    root: ContainerNode | null;
    __properties?: Record<string, { type: string; default: unknown }> | null;
    __propertyChanges?: ReadonlyArray<PropertyChange>;
}

/**
 * Fields shared by every container-shaped node. Plain container,
 * repeater, and listManager all carry the same shape at runtime
 * (the parser initialises every field on every node). The three
 * variant interfaces narrow only the `nodeKind` discriminator and
 * the fields that are actually meaningful for that kind; the
 * shared fields live on `ContainerNodeBase` so the union shape is
 * structurally identical for a consumer who reads any field
 * without narrowing first.
 */
interface ContainerNodeBase {
    collapsible: boolean;
    title: TextFragment[];
    description: TextFragment[];
    tooltipRef: string | null;
    label: TextFragment[];
    headerControls: ControlNode[];
    panels: PanelNode[] | null;
    rows: RowNode[] | null;
    when: string | null;
    whenAst: WhenAst | null;
    minHeight: string | null;
    maxHeight: string | null;
    loc: SourceLoc;
    // Repeater / listManager fields. The parser initialises these
    // on every container kind; on plain containers they hold the
    // default values (null for arrayBinding and the list-manager
    // string fields, false for the booleans). A renderer reading a
    // plain-container `node.search` gets `false`; reading
    // `node.arrayBinding` gets `null`. The TypeScript shape matches
    // the runtime so a consumer narrowing on `nodeKind` doesn't
    // get a type error reading a field that exists.
    arrayBinding: string | null;
    itemMin: number | null;
    itemMax: number | null;
    search: boolean;
    filter: string | null;
    draggable: boolean;
    addLabel: string | null;
    commit: { kind: 'function'; name: string } | null;
    excludedRef: string | null;
}

/** A plain `[container(...)]` node. */
export interface PlainContainerNode extends ContainerNodeBase {
    nodeKind: 'container';
}

/**
 * A `[repeater({arr},min=N,max=M)]` node binding to an array of
 * items. `arrayBinding` is non-null on a parsed repeater (the
 * parser raises INVALID_PARAM for a bound-less form).
 */
export interface RepeaterNode extends ContainerNodeBase {
    nodeKind: 'repeater';
    arrayBinding: string;
}

/**
 * A `[listManager({arr},...)]` node. Same array binding as repeater
 * plus the list-manager-specific UX fields (`search`, `filter`, etc.)
 * that the renderer reads when present. `arrayBinding` is non-null
 * on a parsed listManager.
 */
export interface ListManagerNode extends ContainerNodeBase {
    nodeKind: 'listManager';
    arrayBinding: string;
}

/** Discriminated union of every container-shaped node. */
export type ContainerNode = PlainContainerNode | RepeaterNode | ListManagerNode;

/**
 * A row holds inline controls and may end with a nested container
 * (plain, repeater, or list-manager) the same way an HTML `<div>`
 * mixes inputs and child sections. The renderer discriminates each
 * entry by `nodeKind`; using `ContainerNode` here keeps the row's
 * "and a nested container" shape in sync with the top-level
 * container vocabulary so a contributor adding a new container
 * variant doesn't have to update both places.
 */
export interface RowNode {
    nodeKind: 'row';
    controls: Array<ControlNode | ContainerNode>;
    loc: SourceLoc;
}

export interface PanelNode {
    number: number;
    label: TextFragment[];
    width: number;
    rows: RowNode[];
}

export interface ControlNode {
    nodeKind: 'control';
    controlType: string;
    width: number | null;
    binding: string | null;
    bindingType: string | null;
    dataType: string | null;
    optionsSource: string | null;
    contentRef: string | null;
    params: Record<string, unknown>;
    secret: boolean;
    readOnly: boolean;
    when: string | null;
    whenAst: WhenAst | null;
    tooltipRef: string | null;
    init: { kind: 'literal' | 'binding' | 'function'; value?: unknown; path?: string; name?: string } | null;
    compute: { kind: 'function'; name: string } | null;
    explain: TextFragment[];
    label: TextFragment[];
    loc: SourceLoc;
}

export interface SourceLoc {
    line: number;
    col: number;
    length: number;
}

export const TYPE_BY_CONTROL: Readonly<
    Record<string, { jsType: string | null; defaultValue: string | null; tsType: string | null }>
>;

export function inferDataSchema(ast: FormModel | null | undefined): InferredSchema;
export interface InferredSchema {
    fields: Array<{ path: string; [k: string]: unknown }>;
    functions: Array<{ name: string; [k: string]: unknown }>;
    repeaters: unknown[];
    optionSources: unknown[];
    tooltips: string[];
}

export function scaffoldDataObject(
    schema: InferredSchema,
    opts?: { indent?: string }
): string;

export function scaffoldDataClass(
    schema: InferredSchema,
    className?: string,
    opts?: { indent?: string }
): string;

export function scaffoldTypeScript(
    schema: InferredSchema,
    ifaceName?: string
): string;

/**
 * Emit a JSON Schema (Draft 2020-12) document describing the data
 * shape this form binds. The output is a JS object the caller can
 * `JSON.stringify` and feed to Ajv / openapi-typescript / etc.
 * Repeater paths (`arr[].x`) become array-of-object branches.
 */
export function scaffoldJsonSchema(
    schema: InferredSchema,
    name?: string
): object;

export function collectProperties(ast: FormModel | null | undefined): Record<string, { type: string; default: unknown }>;

export interface PropertyChange {
    name: string;
    /** `'type'` for a type overwrite, `'default'` for an init-literal overwrite. */
    kind: 'type' | 'default';
    from: unknown;
    to: unknown;
}

export function mergeProperties(
    ast: FormModel | null | undefined,
    existing: Record<string, { type: string; default: unknown }> | null | undefined
): { properties: Record<string, { type: string; default: unknown }>; changes: PropertyChange[] };

export function validateProperties(ast: FormModel | null | undefined): string[];
export function renderPropertiesBlock(
    properties: Record<string, { type: string; default: unknown }>,
    opts?: { indent?: string }
): string;

/**
 * Compare two parsed forms and report what changed in their inferred
 * property dictionaries. Buckets by `added`, `removed`, and
 * `changed` (where each `changed` entry names the kind — `'type'`
 * or `'default'` — and the from/to values). Useful for migration
 * tools and "what changed in this revision" editor surfaces.
 */
export function diffSchemas(
    astA: FormModel | null | undefined,
    astB: FormModel | null | undefined
): {
    added:   Array<{ name: string; type: string; default: unknown }>;
    removed: Array<{ name: string; type: string; default: unknown }>;
    changed: Array<{ name: string; kind: 'type' | 'default'; from: unknown; to: unknown }>;
};

export const VERSION: string;
