/**
 * open-dynamic-workflows — OpenCode plugin.
 *
 * Deliberately SELF-CONTAINED (node builtins + fetch only) so it works both as
 * an npm plugin (`"plugin": ["odw-opencode"]` in opencode.json) and as a
 * drop-in file in ~/.config/opencode/plugins/.
 *
 * Hooks used (verified against @opencode-ai/plugin 1.2.x):
 *  - "chat.message": trigger detection ("workflow"/"ultracode" intent) → plan via daemon
 *  - tool: odw_plan / odw_run / odw_status / odw_workflows custom tools
 *  - event: surface daemon progress into the session
 *
 * Slash commands ship separately as markdown in commands/ (see package README).
 *
 * @type {import('@opencode-ai/plugin').Plugin}
 */
export const OdwPlugin = async (_input) => {
  throw new Error('not implemented (P4)');
};

export default OdwPlugin;
