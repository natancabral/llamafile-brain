#!/usr/bin/env node
'use strict';
/**
 * Regenerates every icon from the SVGs in assets/:
 *   build/icon.png            1024 px (window icon, deb/rpm/AppImage fallback)
 *   build/icons/<size>.png    Linux set (16 ... 1024 px)
 *   build/icon.ico            Windows (16 ... 256 px, multi-resolution)
 *   build/icon.icns           macOS (16 ... 1024 px, with the standard safe margin)
 *   assets/icon-512.png, assets/logo.png
 *
 * Needs: rsvg-convert (librsvg) and ImageMagick (convert).
 *   Linux:   sudo apt install librsvg2-bin imagemagick
 *   macOS:   brew install librsvg imagemagick
 *   Windows: use WSL, or run it on Linux/macOS (the generated files are committed to the repo)
 * The .icns file is written by this script (no iconutil needed), so it works on every OS.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const abs = (p) => path.join(root, p);
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if (r.error || r.status !== 0) {
    console.error(`Failed: ${cmd}. Install librsvg and ImageMagick.`);
    process.exit(1);
  }
};
const svgToPng = (svg, size, out) => run('rsvg-convert', ['-w', String(size), '-h', String(size), svg, '-o', out]);

fs.mkdirSync(abs('build/icons'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lfb-icons-'));

// main + Linux set
svgToPng('assets/icon.svg', 1024, 'build/icon.png');
const linuxSizes = [16, 24, 32, 48, 64, 96, 128, 256, 512, 1024];
for (const s of linuxSizes) svgToPng('assets/icon.svg', s, `build/icons/${s}x${s}.png`);
svgToPng('assets/icon.svg', 512, 'assets/icon-512.png');
run('rsvg-convert', ['-w', '920', 'assets/logo.svg', '-o', 'assets/logo.png']);

// Windows
run('convert', ['build/icon.png', '-define', 'icon:auto-resize=256,128,64,48,32,16', 'build/icon.ico']);

// macOS: the artwork sits inside a transparent margin (about 80% of the canvas), like native macOS icons
const macBase = path.join(tmp, 'mac-1024.png');
run('rsvg-convert', ['-w', '824', '-h', '824', 'assets/icon.svg', '-o', path.join(tmp, 'mac-824.png')]);
run('convert', [path.join(tmp, 'mac-824.png'), '-background', 'none', '-gravity', 'center', '-extent', '1024x1024', macBase]);
// icns chunk types that carry PNG data -> pixel size
const ICNS = [['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024], ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]];
const chunks = ICNS.map(([type, px]) => {
  const f = path.join(tmp, `m${px}.png`);
  if (!fs.existsSync(f)) run('convert', [macBase, '-resize', `${px}x${px}`, f]);
  const data = fs.readFileSync(f);
  const head = Buffer.alloc(8);
  head.write(type, 0, 'ascii');
  head.writeUInt32BE(data.length + 8, 4);
  return Buffer.concat([head, data]);
});
const body = Buffer.concat(chunks);
const header = Buffer.alloc(8);
header.write('icns', 0, 'ascii');
header.writeUInt32BE(body.length + 8, 4);
fs.writeFileSync(abs('build/icon.icns'), Buffer.concat([header, body]));
fs.rmSync(tmp, { recursive: true, force: true });
console.log('Icons updated: build/icon.png, build/icons/*, build/icon.ico, build/icon.icns');
