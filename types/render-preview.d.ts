/** FormBuilderDSL render-preview subpath — ASCII visualisation of an AST. */

export type { FormModel } from './index.js';
import type { FormModel } from './index.js';

export interface RenderPreviewOpts {
    width?: number;
    showInit?: boolean;
    showWhen?: boolean;
}

export function renderFormPreview(
    ast: FormModel | null | undefined,
    opts?: RenderPreviewOpts
): string;
