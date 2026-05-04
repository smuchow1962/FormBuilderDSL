// @internal — IN-PACKAGE BARREL. NOT part of the public API.
//
// The two re-exports below are consumed by the package's own
// `text-form-builder.js` and by the test suite. Consumers should
// reach `parse` / `runParse` indirectly through `TextFormBuilder`'s
// `parse()` / `process()` methods, NOT by importing this file.
//
// The package's `exports` map in package.json does not list this
// module, so `import { runParse } from '@mmpworks/formbuilder-dsl/parser'`
// fails with "subpath not exported." A consumer who routes around
// the exports map by importing the file path directly
// (`'@mmpworks/formbuilder-dsl/src/parser.js'`) reaches the
// internal entry — that path is not stable and may narrow in a
// future major version. Use the public `TextFormBuilder` surface
// instead.
//
//   parse(input, spec)     pure function returning the AST. Throws
//                          ParseError on any failure.
//   runParse(input, spec)  the production entry. Validates the spec,
//                          calls parse(), runs layout-check, returns
//                          a TupleResponse so callers branch on
//                          .error rather than try/catching.
export { parse } from './parser/parse.js';
export { runParse } from './parser/run-parse.js';
