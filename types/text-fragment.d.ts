/** FormBuilderDSL text-fragment subpath — decorated label parsing + rendering. */

/** Inline style applicable to any TextFragment kind. */
export interface TextStyle {
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strikethrough?: boolean;
    sizeStep?: number;
    fg?: { name: string | null; resolved: string | null };
    bg?: { name: string | null; resolved: string | null };
}

export interface TextFragmentText     { kind: 'text';     text: string;    style?: TextStyle }
export interface TextFragmentBinding  { kind: 'binding';  path: string;    style?: TextStyle }
export interface TextFragmentFunction { kind: 'function'; name: string;    style?: TextStyle }

/** Discriminated-union of every fragment shape parseDecorated emits. */
export type TextFragment =
    | TextFragmentText
    | TextFragmentBinding
    | TextFragmentFunction;

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
