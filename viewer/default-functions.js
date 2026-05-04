// Default function registry for the viewer's Render Preview.
//
// The Vue renderer reads functions from window.formFunctions (or an opts.functions
// passed to mountVueRenderer). Add an entry here for any {@functionName}
// reference your form expects — the function is called with the live data
// object whenever any of its read fields change.
//
// In a real app, this file is replaced (or augmented) by the consumer's
// real function implementations. For viewer/preview purposes, these are
// reasonable defaults that exercise the coupling features.

export const defaultFunctions = {
    // logOutputType drives the file extension. Used by the sink-text-file
    // sample as: [combo(...,{logExtension},compute={@extFromOutput})]
    extFromOutput(data) {
        const map = { text: 'log', csv: 'csv', ndjson: 'ndjson' };
        return map[data.logOutputType] ?? data.logExtension ?? 'log';
    },

    // Example placeholder for tooltip/text interpolation:
    // "{@formatRetention}" inside a tooltip will resolve via this.
    formatRetention(data) {
        const days = data.retentionDays;
        if (days == null) return '';
        if (days === 1) return '1 day';
        return `${days} days`;
    },

    // The naming-convention card uses {templateName} / {pattern} / {ext}
    // as data placeholders, not functions. Add formatStatus / etc. here
    // if your form references those.
};

// Expose globally so the renderer can find the default registry
// without having to import this file from inside render-vue.js.
// Spread order matters: defaults go first, then any consumer-
// supplied registry pre-populated on `window.formFunctions` wins.
window.formFunctions = { ...defaultFunctions, ...(window.formFunctions ?? {}) };

// Public registration API. The previous shape (write directly to
// window.formFunctions) has a load-order footgun: a consumer
// setting the global AFTER this script loads silently overwrote
// the defaults. The registration call below is the load-order-safe
// path — it merges into the existing object instead of replacing
// it, so script order does not matter. The direct-write path still
// works for callers who set the global before the viewer loads.
//
// Usage:
//   <script src="default-functions.js"></script>
//   <script>
//     window.registerFormFunction('myFn', (data) => data.x * 2);
//   </script>
window.registerFormFunction = function registerFormFunction(name, fn) {
    if (typeof name !== 'string' || !name) {
        throw new TypeError('registerFormFunction: name must be a non-empty string');
    }
    if (typeof fn !== 'function') {
        throw new TypeError(`registerFormFunction: fn for '${name}' must be a function`);
    }
    window.formFunctions = window.formFunctions ?? {};
    window.formFunctions[name] = fn;
};
