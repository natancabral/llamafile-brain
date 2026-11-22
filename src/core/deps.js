'use strict';

/** Optional dependencies (OCR, poppler, LibreOffice) and the sandbox fix: detection and install commands. */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { findBin } = require('./bins');

const PLATFORM = process.platform;

const has = (cmd) => spawnSync(PLATFORM === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }).status === 0;

function detectManager(platform = PLATFORM, exists = has) {
  if (platform === 'darwin') return exists('brew') ? 'brew' : null;
  if (platform === 'win32') return ['winget', 'choco', 'scoop'].find(exists) || null;
  return ['apt-get', 'dnf', 'pacman', 'zypper'].find(exists) || null;
}

/** Package names/commands per item and package manager. */
const PACKAGES = {
  tesseract: {
    label: 'dep.tesseract',
    'apt-get': ['tesseract-ocr', 'tesseract-ocr-por'],
    dnf: ['tesseract', 'tesseract-langpack-por'],
    pacman: ['tesseract', 'tesseract-data-por'],
    zypper: ['tesseract-ocr', 'tesseract-ocr-traineddata-portuguese'],
    brew: ['tesseract', 'tesseract-lang'],
    winget: ['UB-Mannheim.TesseractOCR'],
    choco: ['tesseract'],
    scoop: ['tesseract'],
  },
  poppler: {
    label: 'dep.poppler',
    'apt-get': ['poppler-utils'],
    dnf: ['poppler-utils'],
    pacman: ['poppler'],
    zypper: ['poppler-tools'],
    brew: ['poppler'],
    winget: ['oschwartz10612.Poppler'],
    choco: ['poppler'],
    scoop: ['poppler'],
  },
  libreoffice: {
    label: 'dep.libreoffice',
    'apt-get': ['libreoffice-writer', 'libreoffice-calc', 'libreoffice-impress'],
    dnf: ['libreoffice-writer', 'libreoffice-calc', 'libreoffice-impress'],
    pacman: ['libreoffice-fresh'],
    zypper: ['libreoffice-writer', 'libreoffice-calc', 'libreoffice-impress'],
    brew: ['libreoffice'], // cask
    winget: ['TheDocumentFoundation.LibreOffice'],
    choco: ['libreoffice-fresh'],
    scoop: ['libreoffice'],
  },
};

/** Builds the command line to install `item` with `manager`. */
/** `elevate`: 'sudo' (terminal) or 'pkexec' (graphical password prompt, used by the app). */
function installCommand(item, manager, { root = false, platform = PLATFORM, elevate = 'sudo' } = {}) {
  const pkgs = PACKAGES[item][manager];
  if (!pkgs) return null;
  const sudo = platform === 'linux' && !root ? [elevate] : [];
  switch (manager) {
    case 'apt-get': return [...sudo, 'apt-get', 'install', '-y', ...pkgs];
    case 'dnf': return [...sudo, 'dnf', 'install', '-y', ...pkgs];
    case 'pacman': return [...sudo, 'pacman', '-S', '--noconfirm', '--needed', ...pkgs];
    case 'zypper': return [...sudo, 'zypper', 'install', '-y', ...pkgs];
    case 'brew': return item === 'libreoffice' ? ['brew', 'install', '--cask', ...pkgs] : ['brew', 'install', ...pkgs];
    case 'winget': return ['winget', 'install', '-e', '--id', pkgs[0], '--accept-package-agreements', '--accept-source-agreements'];
    case 'choco': return ['choco', 'install', '-y', ...pkgs];
    case 'scoop': return ['scoop', 'install', ...pkgs];
    default: return null;
  }
}


/** Items still missing: 'tesseract' (also when the Portuguese language data is missing), 'poppler', 'libreoffice'. */
function missingItems() {
  const miss = [];
  const tess = findBin('tesseract');
  if (!tess) miss.push('tesseract');
  else {
    const r = spawnSync(tess, ['--list-langs'], { encoding: 'utf8' });
    if (!/^por$/m.test(`${r.stdout}\n${r.stderr}`)) miss.push('tesseract');
  }
  if (!findBin('pdftoppm')) miss.push('poppler');
  if (!findBin('soffice', 'libreoffice')) miss.push('libreoffice');
  return miss;
}

/** Linux only: chrome-sandbox precisa ser de root com o bit setuid. */
function sandboxPath(root) {
  return path.join(root, 'node_modules', 'electron', 'dist', 'chrome-sandbox');
}
function sandboxStatus(root) {
  if (PLATFORM !== 'linux') return { applicable: false, ok: true };
  const p = sandboxPath(root);
  try {
    const st = fs.statSync(p);
    return { applicable: true, ok: st.uid === 0 && (st.mode & 0o4000) !== 0, path: p };
  } catch {
    return { applicable: false, ok: true };
  }
}
/** Command that fixes the sandbox permissions. */
function sandboxCommand(root, { root: isRoot = false, elevate = 'sudo' } = {}) {
  const p = sandboxPath(root);
  const pre = isRoot ? [] : [elevate];
  return [...pre, 'sh', '-c', 'chown root:root "$0" && chmod 4755 "$0"', p];
}

module.exports = { PLATFORM, has, detectManager, PACKAGES, installCommand, missingItems, sandboxStatus, sandboxCommand, sandboxPath };
