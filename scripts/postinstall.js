'use strict';
// After `npm install`: only WARNS about what is missing (never installs anything by itself and never fails).
try {
  const { missingItems } = require('./setup');
  const miss = missingItems();
  if (miss.length) {
    console.log(`\n[llamafile-brain] Optional features not installed yet: ${miss.join(', ')}.`);
    console.log('[llamafile-brain] Run "npm run setup" to install them (it asks permission before each item).\n');
  }
} catch {
  /* ignore */
}
