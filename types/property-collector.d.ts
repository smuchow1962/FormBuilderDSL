/** FormBuilderDSL property-collector subpath — collect / validate `__properties`. */

export type { FormModel } from './index.js';
import type { FormModel } from './index.js';

export function collectProperties(
    ast: FormModel | null | undefined
): Record<string, { type: string; default: unknown }>;

export interface PropertyChange {
    name: string;
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

