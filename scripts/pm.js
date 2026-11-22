'use strict';
/** Detects the package manager that launched the script (npm, yarn or pnpm). */
const ua = process.env.npm_config_user_agent || '';
const name = /^yarn\//.test(ua) ? 'yarn' : /^pnpm\//.test(ua) ? 'pnpm' : 'npm';
/** Command to show the user: "npm run setup" / "yarn setup" / "pnpm setup". */
const cmd = (script) => (name === 'npm' ? `npm run ${script}` : `${name} ${script}`);
/** Executable to spawn (Windows needs the .cmd shims). */
const bin = process.platform === 'win32' ? `${name}.cmd` : name;
module.exports = { name, cmd, bin };
