/** FormBuilderDSL expression subpath — `when=` parsing + evaluation. */

export const DEFAULT_MAX_WHEN_SOURCE_LENGTH: number;
export const DEFAULT_MAX_WHEN_TOKENS: number;
export const FORBIDDEN_PATH_SEGMENTS: ReadonlySet<string>;

/**
 * AST node shapes for a parsed `when=` expression. Mirrors the
 * `WhenAst` union exported from the root package; consumers
 * importing only the `/expression` subpath get the same typed
 * shape. The seven node kinds correspond to the grammar's seven
 * productions.
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
 */
export function parseWhen(
    source: string | null | undefined,
    options?: { maxSourceLength?: number; maxTokens?: number }
): WhenAst | null;

/**
 * Evaluate a `when=` string against trusted host data.
 *
 * @throws {ParseError} when `source` is malformed or exceeds a cap.
 */
export function evaluateWhen(
    source: string | null | undefined,
    data: Record<string, unknown>,
    options?: { maxSourceLength?: number; maxTokens?: number }
): boolean;

/**
 * Evaluate an already-parsed `when=` AST. Escape hatch from the
 * no-AST-caching rule: cache parseWhen(source) at form-load time
 * and feed the AST through this on every render.
 */
export function evaluateAst(
    ast: WhenAst | null,
    data: Record<string, unknown>
): boolean;
