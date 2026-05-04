// FormBuilderDSL public entry point.
//
// Everything a consumer needs is re-exported from this file. The package's
// `exports` map in package.json points here for the bare import
// (`@mmpworks/formbuilder-dsl`) and at individual files under `src/` for
// the subpath imports (`@mmpworks/formbuilder-dsl/expression`, etc.).
//
// If a name doesn't appear below, it isn't part of the public API.

export { TextFormBuilder } from './text-form-builder.js';
export { TupleResponse, ParseError, ERR, errorName } from './tuple-response.js';
export {
    defaultControlSpec,
    validateControlSpec,
    lookupType,
    isReserved,
    DEFAULT_DATA_TYPE_BY_CONTROL,
    ALLOWED_DATA_TYPES
} from './control-spec.js';
export {
    evaluateWhen,
    evaluateAst,
    parseWhen,
    DEFAULT_MAX_WHEN_SOURCE_LENGTH,
    DEFAULT_MAX_WHEN_TOKENS,
    FORBIDDEN_PATH_SEGMENTS
} from './expression.js';
export { DEFAULT_MAX_INPUT_LENGTH } from './parser/run-parse.js';
export { MAX_NESTING_DEPTH } from './parser/parse-containers.js';
export { interpolate } from './interpolate.js';
export { parseDecorated, renderFragments } from './text-fragment.js';
export { renderFormPreview } from './render-preview.js';
export { walkAst } from './walk-ast.js';
export { renderForm } from './render-form.js';
export {
    inferDataSchema,
    scaffoldDataObject,
    scaffoldDataClass,
    scaffoldTypeScript,
    scaffoldJsonSchema,
    TYPE_BY_CONTROL
} from './infer-schema.js';
export { collectProperties, mergeProperties, validateProperties, renderPropertiesBlock, diffSchemas } from './property-collector.js';

export { VERSION } from './version-generated.js';
