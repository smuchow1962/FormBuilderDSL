/** FormBuilderDSL infer-schema subpath — scaffold data shape from an AST. */

export type { FormModel } from './index.js';
import type { FormModel } from './index.js';

export interface InferredSchema {
    fields: Array<{ path: string; [k: string]: unknown }>;
    functions: Array<{ name: string; [k: string]: unknown }>;
    repeaters: unknown[];
    optionSources: unknown[];
    tooltips: string[];
}

export const TYPE_BY_CONTROL: Readonly<
    Record<string, { jsType: string | null; defaultValue: string | null; tsType: string | null }>
>;

export function inferDataSchema(ast: FormModel | null | undefined): InferredSchema;

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
