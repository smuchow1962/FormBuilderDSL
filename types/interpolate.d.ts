/** FormBuilderDSL interpolate subpath — `{path}` and `{@fn}` substitution. */

export function interpolate(
    text: string | null | undefined,
    data?: Record<string, unknown>,
    functions?: Record<string, (data: Record<string, unknown>) => unknown>,
    options?: { strict?: boolean }
): string;
