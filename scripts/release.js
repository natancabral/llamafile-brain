#!/usr/bin/env node
'use strict';

/**
 * Gera os instaladores (releases) do Llamafile Brain.
 *
 *   npm run release              # o que o seu sistema consegue gerar
 *   npm run release:linux        # Ubuntu/Debian (.deb), Fedora/openSUSE (.rpm), AppImage, .tar.gz  (x64)
 *   npm run release:win          # Windows 64 and 32 bit: installer (.exe) and portable
 *   npm run release:mac          # macOS Intel and Apple Silicon: .dmg and .zip   (macOS only)
 *   npm run release:all          # tries all three
 *   npm run release -- --dir     # only packs (no installer), for a quick test
 *
 * Os arquivos ficam em dist/ junto com SHA256SUMS.txt.
 * To build EVERYTHING at once without owning all three systems, use GitHub Actions (see docs/RELEASING.md).
 */
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const INSTALLER_RE = /\.(deb|rpm|AppImage|tar\.gz|exe|dmg|zip)$/;

function parseArgs(argv) {
  const a = { linux: false, win: false, mac: false, dir: false };
  for (const x of argv) {
    if (x === '--linux') a.linux = true;
    else if (x === '--win' || x === '--windows') a.win = true;
    else if (x === '--mac' || x === '--macos') a.mac = true;
    else if (x === '--dir') a.dir = true;
    else if (x === '--help' || x === '-h') a.help = true;
    else throw new Error(`Unknown option: ${x}`);
  }
  return a;
}

const currentTarget = (platform = process.platform) => ({ linux: 'linux', win32: 'win', darwin: 'mac' })[platform];

/** Which OS can build what. Returns { ok, errors[], warnings[] }. */
function checkPrereqs(target, platform = process.platform, has = () => false) {
  const errors = [];
  const warnings = [];
  if (target === 'mac' && platform !== 'darwin') {
    errors.push('The macOS package (.dmg) can only be built on a Mac. Use a Mac or GitHub Actions (docs/RELEASING.md).');
  }
  if (target === 'linux') {
    if (platform === 'win32') errors.push('Linux packages (.deb/.rpm) are not built on Windows. Use WSL (Ubuntu) or GitHub Actions.');
    else if (!has('rpmbuild')) {
      errors.push(
        'Falta o "rpmbuild" para gerar o .rpm (Fedora/openSUSE). Instale: ' +
          (platform === 'darwin' ? 'brew install rpm' : 'sudo apt install rpm   (Ubuntu/Debian)  |  sudo dnf install rpm-build   (Fedora)'),
      );
    }
  }
  if (target === 'win' && platform !== 'win32') {
    if (!has('wine')) {
      errors.push(
        'To build Windows from ' + (platform === 'darwin' ? 'macOS' : 'Linux') +
          ' Wine is required (e.g. sudo apt install wine64). Alternative: build on Windows or with GitHub Actions.',
      );
    } else warnings.push('Windows built through Wine: it works, but building on Windows or with GitHub Actions is better.');
  }
  return { ok: errors.length === 0, errors, warnings };
}

/** Arguments passed to electron-builder for a target. */
function builderArgs(target, { dir = false } = {}) {
  const args = [`--${target}`];
  if (target === 'win') args.push('--x64', '--ia32');
  if (target === 'mac') args.push('--x64', '--arm64');
  if (target === 'linux') args.push('--x64');
  if (dir) args.push('--dir');
  args.push('--publish', 'never');
  return args;
}

function listArtifacts(dir = DIST) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => INSTALLER_RE.test(f) && fs.statSync(path.join(dir, f)).isFile())
    .sort();
}

function sha256(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

function writeChecksums(dir = DIST) {
  const files = listArtifacts(dir);
  const lines = files.map((f) => `${sha256(path.join(dir, f))}  ${f}`);
  fs.writeFileSync(path.join(dir, 'SHA256SUMS.txt'), lines.join('\n') + (lines.length ? '\n' : ''));
  return files;
}

const hasCmd = (cmd) => spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }).status === 0;
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  if (args.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n/, '').replace(/^'use strict';\n\n\/\*\*?/m, ''));
    return;
  }
  let targets = ['linux', 'win', 'mac'].filter((t) => args[t]);
  if (!targets.length) targets = [currentTarget()];

  const bin = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
  if (!fs.existsSync(bin)) {
    console.error('electron-builder not found. Run first: npm install');
    process.exit(1);
  }

  fs.rmSync(DIST, { recursive: true, force: true });
  const failed = [];
  for (const t of targets) {
    const pre = checkPrereqs(t, process.platform, hasCmd);
    pre.warnings.forEach((w) => console.warn(`! ${w}`));
    if (!pre.ok) {
      pre.errors.forEach((e) => console.error(`x [${t}] ${e}`));
      failed.push(t);
      continue;
    }
    console.log(`\n=== Gerando ${t} ===`);
    const r = spawnSync(bin, builderArgs(t, args), { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
    if (r.status !== 0) failed.push(t);
  }

  const files = args.dir ? [] : writeChecksums();
  if (files.length) {
    console.log('\nArquivos em dist/:');
    for (const f of files) console.log(`  ${f}  (${mb(fs.statSync(path.join(DIST, f)).size)})`);
    console.log('  SHA256SUMS.txt');
  }
  if (failed.length) {
    console.error(`\nCould not build: ${failed.join(', ')}. What succeeded is in dist/.`);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { parseArgs, checkPrereqs, builderArgs, listArtifacts, writeChecksums, currentTarget };
