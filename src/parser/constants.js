/**
 * Matches a panel marker line inside a multi-panel container.
 * Format: a number, a dot, a space, then the panel's label.
 * Example: `1. Sanctions & screening`.
 */
export const PANEL_RX = /^(?<num>\d+)\.\s+(?<label>.+)$/;

/**
 * Matches a "named text" declaration whose value starts with a backtick.
 * Named text is the DSL feature that lets an author give a chunk of
 * decorated text a name and reuse it later by writing `#name`.
 * Example: ``intro = `Plain label with *bold* story` ``.
 *
 * The parser detects this with a regex before the tokenizer touches the
 * line, because the tokenizer would otherwise choke on the backtick.
 */
export const BARE_NAMED_TEXT_RX =
    /^(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?<value>`.*)$/;
