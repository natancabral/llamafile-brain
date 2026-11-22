#!/usr/bin/env node
'use strict';

/**
 * Installs what is missing for the optional features (Linux, macOS and Windows), ALWAYS asking for
 * permission before each installation.
 *
 *   npm run setup              asks item by item
 *   npm run setup -- --yes     accepts everything without asking
 *   npm run setup -- --check   only shows what is missing
 *
 * Items: OCR (tesseract + language data), scanned PDFs (poppler), old formats
 * .doc/.xls/.ppt/.rtf (LibreOffice) and, on Linux, the Electron sandbox permission.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const deps = require('../src/core/deps');
const I18N = require('../src/shared/i18n');
const label = (id) => I18N.t(PACKAGES[id].label, null, 'en');

const { PLATFORM, detectManager, installCommand, missingItems, PACKAGES } = deps;
const ROOT = path.resolve(__dirname, '..');

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (a) => {
      rl.close();
      resolve(/^(s|sim|y|yes)$/i.test(a.trim()));
    }),
  );
}

const run = (cmd) => {
  console.log(`$ ${cmd.join(' ')}`);
  return spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit', shell: PLATFORM === 'win32' }).status === 0;
};

async function main() {
  const args = process.argv.slice(2);
  const yes = args.includes('--yes') || args.includes('-y');
  const checkOnly = args.includes('--check');
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  console.log('Llamafile Brain — optional dependency check\n');
  const manager = detectManager();
  const miss = missingItems();
  const sandboxNeeded = !deps.sandboxStatus(ROOT).ok;

  if (!miss.length) console.log('OK: OCR, poppler and LibreOffice are already installed.');
  else console.log(`Missing: ${miss.map((m) => label(m)).join('\n         ')}`);
  if (checkOnly) process.exit(miss.length ? 1 : 0);

  if (miss.length && !manager) {
    const hint = {
      darwin: 'Install Homebrew (https://brew.sh) and run this command again.',
      win32: 'Install winget (App Installer from the Microsoft Store), Chocolatey or Scoop and run it again.',
      linux: 'Could not recognize your package manager (apt, dnf, pacman, zypper). Install manually: tesseract (+ language data), poppler and libreoffice.',
    }[PLATFORM];
    console.log(`\nNo package manager found. ${hint}`);
  } else {
    for (const item of miss) {
      const cmd = installCommand(item, manager, { root: isRoot });
      if (!cmd) {
        console.log(`\n${label(item)}: no package for ${manager}; install it manually.`);
        continue;
      }
      console.log(`\n${label(item)}\nCommand: ${cmd.join(' ')}`);
      if (!(yes || (await ask('Install now? [y/N] ')))) {
        console.log('Skipped.');
        continue;
      }
      if (!run(cmd)) console.log('The installation failed or was cancelled. You can try the command above manually.');
    }
  }

  if (sandboxNeeded) {
    console.log('\nLinux: Electron needs permission on chrome-sandbox (owner root + mode 4755) to run with the sandbox enabled.');
    if (yes || (await ask('Fix it now (uses sudo)? [y/N] '))) run(['node', path.join(__dirname, 'fix-sandbox.js')]);
    else console.log('Skipped. Alternative without sudo: npm run start:dev (or: yarn start:dev)');
  }

  const still = missingItems();
  console.log(still.length ? `\nStill missing: ${still.join(', ')}.` : '\nAll set.');
  if (PLATFORM === 'win32') console.log('Windows: if something just installed is not recognized, close and reopen the terminal.');
  if (still.includes('tesseract')) console.log('Note: OCR falls back to English if the Portuguese language data is not installed.');
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { detectManager, installCommand, PACKAGES, missingItems };
