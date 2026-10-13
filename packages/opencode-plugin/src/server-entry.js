// Bundle entry for the OpenCode server plugin.
//
// OpenCode 2 reads exactly one thing from a plugin module: its default export, a
// definition object `{ id, setup }` (anything else fails with "Plugin must export a
// default definition with an id and an effect or setup function"). OpenCode 1 instead
// instantiated *every* export as a plugin factory, and bundling `remote.js` directly
// re-exported its `detectRemoteTrigger` helper, which aborted config loading there.
//
// Keep this file a single default re-export so the bundle's surface stays the one
// definition. `scripts/build-remote-bundles.mjs` enforces the bundle's export surface
// so a stray export cannot return unnoticed.
export { default } from './remote.js';
