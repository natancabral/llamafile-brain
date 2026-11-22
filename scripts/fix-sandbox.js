#!/usr/bin/env node
'use strict';

/**
 * Linux: gives Electron the permission its sandbox needs (chrome-sandbox: owner root + mode 4755)
 * and, if you want, starts the app.
 *
 *   node scripts/fix-sandbox.js          -> only fixes the permissions
 *   node scripts/fix-sandbox.js --start  -> fixes them and runs `npm start`
 *
 * Works from any folder (uses the project's own location) and accepts paths with spaces.
 * Needs sudo (it will ask for your password). Run it again after every `npm install`.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sandbox = path.join(root, 'node_modules', 'electron', 'dist', 'chrome-sandbox');

if (process.platform !== 'linux') {
  console.log('This fix is only needed on Linux. Nothing to do.');
  process.exit(0);
}
if (!fs.existsSync(sandbox)) {
  console.error(`Could not find ${sandbox}\nRun first: npm install`);
  process.exit(1);
}

const run = (cmd, args) => {
  console.log(`$ ${[cmd, ...args].join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`Failed: ${cmd} ${args.join(' ')}`);
    process.exit(r.status || 1);
  }
};

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const sudo = (cmd, args) => (isRoot ? run(cmd, args) : run('sudo', [cmd, ...args]));

sudo('chown', ['root:root', sandbox]);
sudo('chmod', ['4755', sandbox]);
console.log('chrome-sandbox permissions fixed.');

if (process.argv.includes('--start')) {
  const r = spawnSync('npm', ['start'], { cwd: root, stdio: 'inherit' });
  process.exit(r.status || 0);
}
