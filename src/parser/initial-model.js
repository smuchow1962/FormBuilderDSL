/**
 * Returns an empty form model for the parser to fill in.
 *
 * The "form model" is FormBuilderDSL's AST (Abstract Syntax Tree). An
 * AST is just a tree of plain JavaScript objects that describes the
 * shape of the parsed source. The parser walks the input text and pokes
 * fields into the object this function returns.
 *
 * Fields that start with an underscore (_rawTooltips, _rawNamedText)
 * are scratch space the parser uses during phase 1 and deletes before
 * the model is handed back to the caller.
 *
 * the __properties object is a rollup/manifest of all discovered properties, their types, and default values
 * defined in the DSL. Since the parser is written in JavaScript, this
 * manifest exposes the AST's properties and types, allowing any language to use it for its own purposes.
 *
 * Every map keyed by a user-supplied identifier is built with
 * `Object.create(null)` so a `#__proto__`, `#constructor`, or
 * `#toString` lookup never reaches `Object.prototype`. The parser
 * also screens these names at write time via `assertSafeObjectKey`,
 * but null-prototype maps make the read-side guarantee structural
 * rather than convention-based.
 */
export function createInitialFormModel() {
    return {
        version: 1,
        columns: null,
        optionSources: Object.create(null),
        tooltips:      Object.create(null),
        colors:        Object.create(null),
        namedText:     Object.create(null),
        namedObjects:  Object.create(null),
        root: null,
        __properties: null,
        _rawTooltips:  Object.create(null),
        _rawNamedText: Object.create(null)
    };
}
