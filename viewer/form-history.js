// form-history.js — undo / redo stack for the rendered form's
// reactive data object.
//
// Each call to snapshot() with the current data captures it (deep-
// cloned) into a ring buffer. undo() walks left along the stack;
// redo() walks right. A new snapshot after an undo truncates the
// redo branch — same convention every text editor uses for its
// undo history.
//
// MAX_HISTORY caps the buffer so a long-lived editor session doesn't
// accumulate snapshots indefinitely. When the cap fires we drop the
// oldest non-seed entry (index 1), NOT the seed at index 0. The seed
// represents "the form's state when Process last ran"; pinning it
// means seekToSeed() always returns the right thing and the "edits
// since process" badge stays honest after long editing sessions.

export const MAX_HISTORY = 32;

// Field names the parser places non-enumerably on data items so they
// stay out of JSON. structuredClone iterates own *enumerable* string-
// keyed properties, so non-enumerable __pk is dropped naturally —
// the scrub below is defence-in-depth for the case where a consumer
// (or a future Vuetify integration) hands the history a plain object
// that already exposes __pk as enumerable.
//
// Source of truth for the marker name: src/parser/parse-toplevel.js
// re-attaches __pk as non-enumerable; viewer/render-vue.js's
// seedListManagerItem mirrors that.
const INTERNAL_KEYS = ['__pk'];

export function createFormHistory(initialState) {
    const stack = [cloneForHistory(initialState)];
    let cursor = 0;

    function snapshot(state) {
        const next = cloneForHistory(state);
        // Dedup against the *cursor*, not the stack tail. Without
        // this, the renderer's debounced onDataChange refires after
        // restoreInto mutates the live root (Vue's reactivity tick
        // sees the deep change), snapshot() truncates everything
        // ahead of cursor, and only THEN finds the dedup hit — by
        // which point the redo branch is already gone. Comparing
        // against stack[cursor] first means a "restore + re-snap of
        // the same state" is a true no-op.
        if (sameJson(stack[cursor], next)) return false;
        // Real edit — drop everything ahead of the cursor (a new
        // edit after an undo creates a new branch and the redo path
        // is gone, by design).
        if (cursor < stack.length - 1) {
            stack.length = cursor + 1;
        }
        stack.push(next);
        // Cap by dropping the oldest non-seed entry. The seed at
        // index 0 stays pinned forever so seekToSeed() always
        // returns the post-Process state and the "N edits since
        // process" badge counts from a fixed origin.
        if (stack.length > MAX_HISTORY) stack.splice(1, 1);
        cursor = stack.length - 1;
        return true;
    }

    function undo() {
        if (cursor <= 0) return null;
        cursor--;
        return cloneForHistory(stack[cursor]);
    }

    function redo() {
        if (cursor >= stack.length - 1) return null;
        cursor++;
        return cloneForHistory(stack[cursor]);
    }

    function reset(initialFresh) {
        stack.length = 0;
        stack.push(cloneForHistory(initialFresh));
        cursor = 0;
    }

    // Hard reset: jump cursor to seed (index 0) in O(1) and drop the
    // redo branch so the cursor can't walk forward through the pre-
    // reset edits. Returns the seed snapshot so the caller can apply
    // it to the live reactive root. Without this, a Reset would loop
    // through `undo()` MAX_HISTORY times — each call deep-cloning a
    // stack entry it then throws away — and the redo path would still
    // hold every pre-reset edit (so Ctrl+Y after Reset would walk
    // forward through them, contradicting the button's name).
    function seekToSeed() {
        if (stack.length === 0) return null;
        const seed = stack[0];
        stack.length = 1;
        cursor = 0;
        return cloneForHistory(seed);
    }

    function info() {
        return {
            canUndo:    cursor > 0,
            canRedo:    cursor < stack.length - 1,
            cursor,
            length:     stack.length,
            // Edits ahead of the seed snapshot. The "seed" is index 0;
            // every snapshot after it is one user edit. Used by the
            // viewer to paint a "N edits since last process" badge.
            editsAhead: cursor
        };
    }

    return { snapshot, undo, redo, reset, seekToSeed, info };
}

// Single entry point for "snapshot a state into the history."
// Pre-processes File / Blob / FileList values into JSON-serialisable
// markers (so two distinct file picks dedup as different — without
// the marker, JSON.stringify(File) returns "{}" and sameJson would
// silently drop the second pick). Then runs structuredClone for a
// deep copy. Then strips known internal markers as a defence-in-
// depth pass.
export function cloneForHistory(state) {
    const prepped = markFileLeaves(state);
    const cloned = structuredClone(prepped);
    scrubInternalKeys(cloned);
    return cloned;
}

// Walk the state replacing File / Blob / FileList leaves with
// JSON-serialisable markers. Returns a new tree (does NOT mutate
// `state`, which is still the live reactive root for the caller).
// Any value that isn't an array, plain object, File, Blob, or
// FileList passes through verbatim — primitives, Dates (which
// JSON.stringify handles natively), and so on stay as-is.
function markFileLeaves(value) {
    if (value == null || typeof value !== 'object') return value;
    if (typeof File !== 'undefined' && value instanceof File) {
        return { __file: true, name: value.name, size: value.size, type: value.type, lastModified: value.lastModified };
    }
    if (typeof FileList !== 'undefined' && value instanceof FileList) {
        const out = [];
        for (let i = 0; i < value.length; i++) out.push(markFileLeaves(value[i]));
        return { __fileList: true, files: out };
    }
    if (typeof Blob !== 'undefined' && value instanceof Blob) {
        return { __blob: true, size: value.size, type: value.type };
    }
    if (Array.isArray(value)) return value.map(markFileLeaves);
    // Plain object — walk its enumerable own keys.
    const out = {};
    for (const k of Object.keys(value)) out[k] = markFileLeaves(value[k]);
    return out;
}

function scrubInternalKeys(obj) {
    if (Array.isArray(obj)) {
        for (const item of obj) scrubInternalKeys(item);
        return;
    }
    if (obj && typeof obj === 'object') {
        for (const k of INTERNAL_KEYS) {
            if (k in obj) delete obj[k];
        }
        for (const k of Object.keys(obj)) scrubInternalKeys(obj[k]);
    }
}

// Cheapest reliable equality for plain reactive-data shapes (no
// functions, no DOM nodes, no cycles). cloneForHistory upstream
// has already replaced File/Blob/FileList leaves with markers so
// JSON.stringify reaches their content. Wraps in try defensively
// so an unexpected unserialisable value doesn't crash the snapshot
// path; on failure we conservatively report "different" so the
// snapshot proceeds.
function sameJson(a, b) {
    try { return JSON.stringify(a) === JSON.stringify(b); }
    catch { return false; }
}

// Merge snapshot values into target only where the target already
// has the key AND the value shape lines up. Used by live-preview
// re-process: the user edited the schema, the renderer re-mounted
// with a fresh data object seeded from the new schema's defaults,
// and we want to preserve the user's edits where the new schema
// still holds the binding.
//
// Rules:
//   - Keys the new schema removed silently disappear.
//   - Keys the new schema added keep their fresh defaults.
//   - Bindings whose schema flipped from object to primitive (or
//     primitive to object, or array to non-array) keep the new
//     seed instead of planting wrong-shape data — a textfield
//     becoming a daterange, say, must not inherit the old string
//     into `{start, end}`.
//   - Bindings the host marks as "skip" (computed values, anything
//     the host wants the new mount to own) keep the new seed.
//   - Arrays are length-aligned to the snapshot then walked
//     element-by-element (their contents are user-managed, not
//     schema-managed).
//
// `opts.skipBindings` is a Set of dotted binding paths the merge
// should leave alone. The host (viewer.js) walks the AST to collect
// every compute={@fn} binding into this set so the watchEffect's
// computed value isn't overwritten by stale snapshot data.
export function mergePreserveExisting(target, snapshot, opts = {}) {
    const skipBindings = opts.skipBindings ?? null;
    mergeWalk(target, snapshot, '', skipBindings);
}

function mergeWalk(target, snapshot, path, skipBindings) {
    if (Array.isArray(target) && Array.isArray(snapshot)) {
        if (target.length > snapshot.length) target.splice(snapshot.length);
        while (target.length < snapshot.length) {
            target.push(structuredClone(snapshot[target.length]));
        }
        for (let i = 0; i < snapshot.length; i++) {
            const sv = snapshot[i];
            const tv = target[i];
            if (sv && typeof sv === 'object' && tv && typeof tv === 'object'
                && Array.isArray(sv) === Array.isArray(tv)) {
                mergeWalk(tv, sv, path, skipBindings);
            } else if (shapesMatch(sv, tv)) {
                target[i] = sv;
            }
            // else: type-flipped — keep target's value (new seed).
        }
        return;
    }
    if (target && typeof target === 'object' && snapshot && typeof snapshot === 'object') {
        for (const key of Object.keys(snapshot)) {
            if (!(key in target)) continue;     // new schema didn't introduce this key
            const fullPath = path ? `${path}.${key}` : key;
            if (skipBindings && skipBindings.has(fullPath)) continue;     // host owns this
            const sv = snapshot[key];
            const tv = target[key];
            if (sv && typeof sv === 'object' && tv && typeof tv === 'object'
                && Array.isArray(sv) === Array.isArray(tv)) {
                mergeWalk(tv, sv, fullPath, skipBindings);
            } else if (shapesMatch(sv, tv)) {
                target[key] = sv;
            }
            // else: type-flipped (string ↔ object, array ↔ object, etc.)
            // keep the new seed; old value would never render correctly.
        }
    }
}

// True when the snapshot value can be assigned into the target's
// slot without breaking shape. Primitive ↔ primitive is fine; null
// ↔ anything is fine (null is a primitive that signals "no value");
// object ↔ object and array ↔ array are fine. Anything else is a
// type flip and the merge keeps the target's seed instead.
function shapesMatch(sv, tv) {
    if (sv === null || tv === null) return true;
    if (sv === undefined || tv === undefined) return true;
    const so = typeof sv === 'object';
    const to = typeof tv === 'object';
    if (so !== to) return false;
    if (!so) return true;
    return Array.isArray(sv) === Array.isArray(tv);
}

// Restore a snapshot into a reactive target in-place so Vue's
// reactivity tracking picks up every change. Walks the target +
// snapshot recursively: keys present in the snapshot get assigned;
// keys present in the target but absent from the snapshot get
// deleted; arrays are length-aligned then walked element-by-
// element. The target's identity is preserved — Vue's `reactive()`
// proxy stays the same object across undo/redo.
export function restoreInto(target, snapshot) {
    if (Array.isArray(target) && Array.isArray(snapshot)) {
        if (target.length > snapshot.length) target.splice(snapshot.length);
        for (let i = 0; i < snapshot.length; i++) {
            const sv = snapshot[i];
            const tv = target[i];
            if (sv && typeof sv === 'object' && tv && typeof tv === 'object'
                && Array.isArray(sv) === Array.isArray(tv)) {
                restoreInto(tv, sv);
            } else {
                target[i] = sv;
            }
        }
        return;
    }
    if (target && typeof target === 'object' && snapshot && typeof snapshot === 'object') {
        for (const key of Object.keys(target)) {
            if (!(key in snapshot)) delete target[key];
        }
        for (const key of Object.keys(snapshot)) {
            const sv = snapshot[key];
            const tv = target[key];
            if (sv && typeof sv === 'object' && tv && typeof tv === 'object'
                && Array.isArray(sv) === Array.isArray(tv)) {
                restoreInto(tv, sv);
            } else {
                target[key] = sv;
            }
        }
    }
    // Leaf-level assignment isn't possible without a parent — caller
    // hands us paired containers (the reactive root + a cloned root).
}
