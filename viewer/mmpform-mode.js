// Ace mode for .mmpform — registers `ace/mode/mmpform` with the Ace
// runtime. Loaded as a regular <script> after ace.js so the calls to
// ace.define() reach the same module loader the editor uses.
//
// The token vocabulary mirrors highlighter.js's TextMate-style scope
// names so any author who reads the legacy CSS palette can map each
// scope class one-for-one. Where a stock Ace token name fits, we use
// it; the renderer auto-builds compound CSS classes (e.g.
// `keyword.control` → `ace_keyword ace_control`) which the rules at
// the bottom of viewer.css colour to match the existing palette.
//
// Adding a new token: pick the closest existing scope name, add a rule
// before the catch-all whitespace rule, and add a colour line to
// viewer.css if the stock theme's default is wrong.

(function () {
    if (typeof window.ace === 'undefined') {
        // Ace failed to load. Skip registration; the editor will fall
        // back to plain-text mode (still has undo/indent/search etc.).
        return;
    }

    ace.define(
        'ace/mode/mmpform_highlight_rules',
        ['require', 'exports', 'module', 'ace/lib/oop', 'ace/mode/text_highlight_rules'],
        function (require, exports) {
            'use strict';

            const oop = require('ace/lib/oop');
            const TextHighlightRules = require('ace/mode/text_highlight_rules').TextHighlightRules;

            // Top-level declaration keywords. These are language-level
            // (not per-control) and stay hard-coded — they're the
            // grammar's structural words, not vocabulary that consumers
            // extend.
            const declKeywords = [
                'columns', 'container', 'repeater', 'listManager',
                'tooltips', 'colors'
            ].join('|');

            // Control types and parameter names are derived from the
            // package's `defaultControlSpec` at instantiation time.
            // viewer.js stashes the spec on `window.__formBuilderDefaultSpec`
            // before calling editor.session.setMode(), and the
            // constructor below reads it to build the regex strings.
            // A consumer extending the spec via `registerControl`
            // gets the new type highlighted with no edit to this file.
            //
            // The fallback list captures the v1.1.0 default spec so
            // the highlighter still works when the global is missing
            // (loading order failure, lib not yet imported, etc.).
            // Keep the fallback in sync with src/control-spec.js
            // approximately; it's a safety net, not the source of
            // truth.
            const FALLBACK_CONTROL_TYPES = [
                'textfield', 'textarea', 'password',
                'number', 'float', 'slider',
                'check', 'toggle',
                'select', 'combo', 'radio', 'multiselect',
                'date', 'time', 'datetime', 'daterange',
                'file', 'fileSize', 'fileBrowser', 'directoryBrowser',
                'color', 'hidden', 'label', 'display'
            ];
            const FALLBACK_PARAM_KEYWORDS = [
                'in', 'when', 'tt', 'init', 'compute', 'panels', 'explain',
                'style', 'min', 'max', 'step', 'decimals',
                'format', 'placeholder', 'pattern', 'maxLength', 'minLength',
                'reveal', 'accept', 'maxBytes', 'tooltip', 'rows',
                'search', 'addLabel', 'commit', 'excluded', 'height',
                'units', 'defaultUnit', 'multiple',
                '__dataType'
            ];

            function deriveVocabulary() {
                const spec = (typeof window !== 'undefined') ? window.__formBuilderDefaultSpec : null;
                if (!spec || typeof spec !== 'object') {
                    return {
                        controlTypes:   FALLBACK_CONTROL_TYPES.join('|'),
                        paramKeywords:  FALLBACK_PARAM_KEYWORDS.join('|')
                    };
                }
                // Control-type names: every top-level key on the spec
                // except the cross-cutting `__common` block.
                const types = Object.keys(spec).filter(k => k !== '__common');
                // Param names: union of __common.params and every
                // per-control entry's params. Plus `in` (operator
                // keyword inside `when=` expressions, not a control
                // param but the highlighter treats it as one).
                const paramSet = new Set(['in']);
                const collectParams = (entry) => {
                    if (entry?.params && typeof entry.params === 'object') {
                        for (const name of Object.keys(entry.params)) paramSet.add(name);
                    }
                };
                collectParams(spec.__common);
                for (const k of types) collectParams(spec[k]);
                return {
                    controlTypes:  types.join('|'),
                    paramKeywords: [...paramSet].join('|')
                };
            }

            function MMPFormHighlightRules() {
                const { controlTypes, paramKeywords } = deriveVocabulary();
                this.$rules = {
                    start: [
                        // Line comments — anchored to start of line so a
                        // mid-line `#optName` (option-source reference)
                        // doesn't accidentally swallow the rest of the
                        // line as a comment.
                        { token: 'comment.line.number-sign', regex: /^\s*#.*$/ },

                        // Strings — double or single quoted. Backslash
                        // escapes consume the following char so an
                        // embedded \" doesn't close the string.
                        { token: 'string.quoted.double', regex: /"(?:\\.|[^"\\])*"/ },
                        { token: 'string.quoted.single', regex: /'(?:\\.|[^'\\])*'/ },

                        // Backtick-quoted decorator spans — `+b`, `i`,
                        // colour names. Highlighted as a markup token so
                        // a theme can render them differently from
                        // ordinary strings.
                        { token: 'markup.bold', regex: /`[^`\n]*`/ },

                        // {name:type} — typed binding. Splits the type
                        // suffix into its own token so themes can colour
                        // it like a primitive type. Must come BEFORE the
                        // generic {…} rule below, which would otherwise
                        // swallow the whole binding as one token.
                        {
                            regex: /(\{)([A-Za-z_][A-Za-z0-9_]*)(:)([A-Za-z_][A-Za-z0-9_]*)(\})/,
                            token: [
                                'variable.parameter',
                                'variable.parameter',
                                'keyword.operator',
                                'support.type',
                                'variable.parameter'
                            ]
                        },

                        // {binding} — data path the form reads/writes.
                        // {@functionName} is also caught here; the parser
                        // distinguishes by leading @ at AST time.
                        { token: 'variable.parameter', regex: /\{[^}\n]*\}/ },

                        // #optionSource — references an option source or
                        // named-text declaration. Has to come AFTER the
                        // line-comment rule so a leading-`#` line wins.
                        { token: 'entity.name.tag', regex: /#[A-Za-z_][A-Za-z0-9_]*/ },

                        // ISO-ish dates and date-times. Keep before the
                        // generic number rule so YYYY-MM-DD doesn't get
                        // tokenised as three numbers + dashes.
                        { token: 'constant.numeric.date', regex: /\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?)?\b/ },

                        // Plain numbers — integer or decimal, optional sign.
                        { token: 'constant.numeric', regex: /-?\d+(?:\.\d+)?\b/ },

                        // true / false — same scope as JS / YAML / JSON.
                        { token: 'constant.language.boolean', regex: /\b(?:true|false)\b/ },

                        // Top-level declarations — colours / containers /
                        // tooltips / etc. Bold + accent colour in the CSS.
                        { token: 'keyword.control', regex: new RegExp('\\b(?:' + declKeywords + ')\\b') },

                        // Control type names — textfield / select / …
                        { token: 'support.type', regex: new RegExp('\\b(?:' + controlTypes + ')\\b') },

                        // Parameter keywords — when= / init= / panels= / …
                        { token: 'keyword', regex: new RegExp('\\b(?:' + paramKeywords + ')\\b') },

                        // Operators (-> for option-source binding, the
                        // expression operators that show up in when=).
                        { token: 'keyword.operator', regex: /->|==|!=|<=|>=|&&|\|\||=/ },

                        // Brackets. Stock Ace already pairs and highlights
                        // these via the editor's bracket matcher.
                        { token: 'paren.lparen', regex: /[\[({]/ },
                        { token: 'paren.rparen', regex: /[\])}]/ },

                        // Punctuation — colon, comma, dash. Coloured the
                        // same as operators in the CSS so the eye groups
                        // them together.
                        { token: 'punctuation.operator', regex: /[:,]/ },
                        { token: 'punctuation', regex: /[-|]/ }
                    ]
                };
            }
            oop.inherits(MMPFormHighlightRules, TextHighlightRules);

            exports.MMPFormHighlightRules = MMPFormHighlightRules;
        }
    );

    ace.define(
        'ace/mode/mmpform',
        [
            'require', 'exports', 'module',
            'ace/lib/oop',
            'ace/mode/text',
            'ace/mode/mmpform_highlight_rules'
        ],
        function (require, exports) {
            'use strict';

            const oop = require('ace/lib/oop');
            const TextMode = require('ace/mode/text').Mode;
            const MMPFormHighlightRules = require('ace/mode/mmpform_highlight_rules').MMPFormHighlightRules;

            function Mode() {
                this.HighlightRules = MMPFormHighlightRules;
                this.lineCommentStart = '#';   // wires Ctrl+/ to comment with `#`
                this.$id = 'ace/mode/mmpform';
            }
            oop.inherits(Mode, TextMode);

            exports.Mode = Mode;
        }
    );
})();
