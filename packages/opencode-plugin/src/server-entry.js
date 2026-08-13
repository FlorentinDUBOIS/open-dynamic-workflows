// Bundle entry for the OpenCode server plugin.
//
// OpenCode instantiates *every* export of a plugin module as a plugin factory, so this
// entry must expose the plugin and nothing else. Bundling `remote.js` directly re-exported
// its `detectRemoteTrigger` helper; OpenCode called it with the plugin input object, the
// helper returned null for that non-matching prompt, and the resulting `null.config()`
// aborted config loading — leaving Provider.list to fail with "null is not an object
// (evaluating 'n.provider')" and every session start to report "Unexpected server error".
//
// Keep this file a single default re-export. `scripts/build-remote-bundles.mjs` enforces
// the bundle's export surface so the failure cannot return unnoticed.
export { default } from './remote.js';
