#!/usr/bin/env node
'use strict';

/**
 * Starts the app the same way on Linux, macOS and Windows:   npm run start   |   yarn start
 *
 * On Linux, Electron's sandbox needs either a setuid-root `chrome-sandbox` helper or unprivileged user
 * namespaces. Neither is guaranteed (drives mounted `nosuid`, Ubuntu's AppArmor restriction, containers...),
 * and when both are missing Electron aborts with "The setuid sandbox is not running as root".
 * This launcher checks what the machine allows and only then falls back to --no-sandbox, without sudo.
 * macOS and Windows have no such problem, so electron is launched as-is.
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

/** True when the setuid helper can work: owned by root, setuid bit set, and not on a `nosuid` mount. */
function suidSandboxOk(helper, { stat = fs.statSync, mountOptions } = {}) {
  let st;
  try {
    st = stat(helper);
  } catch {
    return false;
  }
  if (st.uid !== 0 || !(st.mode & 0o4000)) return false;
  const opts = (mountOptions ?? defaultMountOptions)(helper);
  return !opts.split(',').includes('nosuid');
}
function defaultMountOptions(file) {
  const r = spawnSync('findmnt', ['-n', '-o', 'OPTIONS', '-T', file], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

/**
 * True when an unconfined program (like node_modules/electron) may create user namespaces.
 * A plain `unshare -U` probe is not enough: Ubuntu 24.04+ ships an AppArmor profile that lets `unshare` through
 * while blocking everything else (kernel.apparmor_restrict_unprivileged_userns=1), so the sysctls are checked too.
 */
function userNamespacesOk({ read = (f) => fs.readFileSync(f, 'utf8').trim(), probe = () => spawnSync('unshare', ['-U', 'true'], { stdio: 'ignore' }).status === 0 } = {}) {
  const val = (f) => {
    try {
      return Number(read(f));
    } catch {
      return null; // sysctl not present on this kernel
    }
  };
  if (val('/proc/sys/user/max_user_namespaces') === 0) return false;
  if (val('/proc/sys/kernel/unprivileged_userns_clone') === 0) return false; // Debian-style switch
  if (val('/proc/sys/kernel/apparmor_restrict_unprivileged_userns') === 1) return false; // Ubuntu 24.04+
  try {
    return probe();
  } catch {
    return false;
  }
}

/** Decides whether --no-sandbox is needed. Only ever true on Linux, and only when no sandbox can work. */
function needsNoSandbox({ platform = process.platform, args = [], env = process.env, suid, userns } = {}) {
  if (platform !== 'linux') return false;
  if (args.includes('--no-sandbox') || env.ELECTRON_DISABLE_SANDBOX) return false; // already handled by the caller
  const helper = path.join(root, 'node_modules', 'electron', 'dist', 'chrome-sandbox');
  const suidOk = suid ?? suidSandboxOk(helper);
  if (suidOk) return false;
  return !(userns ?? userNamespacesOk());
}

function main() {
  let electron;
  try {
    electron = require('electron'); // path to the binary (npm/yarn installed it)
  } catch {
    console.error('Electron is not installed. Run first: npm install (or yarn install)');
    process.exit(1);
  }
  const extra = process.argv.slice(2);
  const args = ['.', ...extra];
  if (needsNoSandbox({ args })) {
    console.warn('[llamafile-brain] No usable Chromium sandbox here (setuid helper unavailable and user namespaces blocked): starting with --no-sandbox.');
    args.push('--no-sandbox');
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // if set, electron would behave like plain node and never open the window
  const child = spawn(electron, args, { cwd: root, stdio: 'inherit', env, windowsHide: false });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig));
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

if (require.main === module) main();
module.exports = { needsNoSandbox, suidSandboxOk, userNamespacesOk };
