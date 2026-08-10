// Jest harness fix: realm-bind structuredClone.
//
// Jest runs each test file inside its own VM realm, but `jest-environment-node`
// hands the realm the HOST's `structuredClone`. Objects it produces therefore
// carry the host realm's `Object.prototype` / `Array.prototype`, not the test
// realm's. `assert.deepStrictEqual` (which is what `node:assert/strict`'s
// `deepEqual` resolves to) compares prototypes, so a perfectly correct clone
// fails with the famously unhelpful "Compared values have no visual difference".
//
// viewer/form-history.js's cloneForHistory() uses structuredClone, so every
// history snapshot assertion in tests/regression-r24.test.js hit this.
//
// The fix re-roots ONLY plain objects and arrays back onto the test realm's
// intrinsics. It deliberately does not touch Date / Map / Set / RegExp or any
// other exotic clone result: those stay foreign, so deepStrictEqual still
// catches a genuine prototype mismatch there. Nothing is weakened — this only
// removes an artifact of running the same code in two realms.
//
// A foreign %Object.prototype% is identified structurally: it is the only
// object in a clone graph whose own prototype is null and which is not an
// array. That test is realm-agnostic, unlike `instanceof`.

const hostStructuredClone = globalThis.structuredClone;

function reroot(value, seen) {
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return value;
    seen.add(value);

    if (Array.isArray(value)) {
        // Array.isArray is cross-realm safe.
        if (Object.getPrototypeOf(value) !== Array.prototype) {
            Object.setPrototypeOf(value, Array.prototype);
        }
    } else {
        const proto = Object.getPrototypeOf(value);
        // A plain object from any realm: its prototype is that realm's
        // Object.prototype, whose own prototype is null.
        if (proto !== null && Object.getPrototypeOf(proto) === null) {
            Object.setPrototypeOf(value, Object.prototype);
        }
    }

    for (const key of Object.keys(value)) reroot(value[key], seen);
    return value;
}

globalThis.structuredClone = function structuredCloneRealmBound(value, options) {
    return reroot(hostStructuredClone(value, options), new Set());
};
