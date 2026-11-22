'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { findBin } = require('./bins');
const run0 = promisify(execFile);
const run = (cmd, args, opts) => run0(findBin(cmd) || cmd, args, opts);

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.webp']);

async function has(cmd) {
  try {
    await run(cmd, ['--version'], { timeout: 8000 });
    return true;
  } catch (e) {
    return e.code !== 'ENOENT' && e.code !== 'EACCES' && !/ENOENT/.test(String(e.message)); // exists but prints version on stderr/exit!=0
  }
}

/** Reports whether the optional OCR tools are installed. */
async function ocrStatus() {
  return { tesseract: await has('tesseract'), pdftoppm: await has('pdftoppm') };
}

async function ocrImage(file, { lang = 'por+eng', signal } = {}) {
  const opts = { maxBuffer: 32 * 1024 * 1024, timeout: 180000, signal };
  try {
    return (await run('tesseract', [file, 'stdout', '-l', lang], opts)).stdout;
  } catch (e) {
    // language data not installed (e.g. Windows without the "por" package): retry with English only
    if (lang !== 'eng' && /load.*lang|Failed loading|Error opening data file/i.test(`${e.stderr || ''}${e.message}`)) {
      return (await run('tesseract', [file, 'stdout', '-l', 'eng'], opts)).stdout;
    }
    throw e;
  }
}

/** Renders PDF pages with pdftoppm (poppler) and OCRs each one. */
async function ocrPdf(file, { lang = 'por+eng', maxPages = 30, signal } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lfb-ocr-'));
  try {
    await run('pdftoppm', ['-r', '150', '-l', String(maxPages), '-png', file, path.join(dir, 'p')], {
      timeout: 240000, signal,
    });
    const pages = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
    let out = '';
    for (const p of pages) {
      if (signal?.aborted) throw new Error('aborted');
      out += (await ocrImage(path.join(dir, p), { lang, signal })) + '\n\n';
    }
    return out;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { ocrStatus, ocrImage, ocrPdf, IMAGE_EXT };
