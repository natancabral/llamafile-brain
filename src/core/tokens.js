'use strict';

/** Quick token estimate (no tokenizer): ~3.5 characters per token for prose/code. */
const estimateTokens = (text) => Math.ceil(String(text || '').length / 3.5);

module.exports = { estimateTokens };
