'use strict';

/** Finds external tools (tesseract, pdftoppm, soffice) in PATH and in the usual install folders. */
const fs = require('node:fs');
const path = require('node:path');

const WIN_DIRS = () => {
  const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean);
  const out = [];
  for (const base of pf) {
    out.push(path.join(base, 'Tesseract-OCR'), path.join(base, 'LibreOffice', 'program'));
    try {
      for (const d of fs.readdirSync(base)) if (/^poppler/i.test(d)) out.push(path.join(base, d, 'Library', 'bin'), path.join(base, d, 'bin'));
    } catch {
      /* ignore */
    }
  }
  const winget = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
  try {
    if (winget) for (const d of fs.readdirSync(winget)) if (/poppler/i.test(d)) out.push(path.join(winget, d));
  } catch {
    /* ignore */
  }
  return out;
};
const MAC_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/Applications/LibreOffice.app/Contents/MacOS'];

function candidates(name) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  if (process.platform === 'win32') dirs.push(...WIN_DIRS());
  if (process.platform === 'darwin') dirs.push(...MAC_DIRS);
  return dirs.flatMap((d) => exts.map((e) => path.join(d, name + e)));
}

/** Absolute path of the tool, or null. Not cached (PATH may change after an install). */
function findBin(...names) {
  for (const name of names) {
    for (const c of candidates(name)) {
      try {
        if (fs.statSync(c).isFile()) return c;
      } catch {
        /* next */
      }
    }
  }
  return null;
}

module.exports = { findBin };
