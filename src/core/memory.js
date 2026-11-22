'use strict';

const { norm } = require('./db');
const { t: tr } = require('../shared/i18n');

/**
 * Memory is explicit: the app stores something only when the user asks
 * ("remember that ...", "lembre que ...", "recuerda que ...") and forgets only when asked
 * ("forget ...", "esqueça ...", "olvida ..."). English, Portuguese and Spanish are understood
 * regardless of the UI language. These commands are handled by code, not by the model, so a
 * small model can't misunderstand or silently store/remove things.
 */

const SHOW_RE = new RegExp(
  '^\\s*(' +
    // en
    "what\\s+(do|did)\\s+you\\s+(remember|know)(\\s+(about|of)\\s+me)?|what(?:'s|\\s+is)\\s+in\\s+(your\\s+|the\\s+|my\\s+)?memory|show\\s+(me\\s+)?(my\\s+|the\\s+)?memor(y|ies)|list\\s+(my\\s+|the\\s+)?memor(y|ies)|my\\s+memories|" +
    // pt
    'o\\s+que\\s+(voc[eê]|vc)\\s+(lembra|sabe)(\\s+(de|sobre)\\s+mim)?|mostre\\s+(a\\s+)?mem[óo]ria|liste\\s+(a\\s+)?mem[óo]ria|minhas\\s+mem[óo]rias|ver\\s+mem[óo]ria|' +
    // es
    'qu[eé]\\s+(recuerdas|sabes)(\\s+(de|sobre)\\s+m[ií])?|muestra\\s+(la\\s+)?memoria|lista\\s+(la\\s+)?memoria|mis\\s+recuerdos|ver\\s+memoria' +
    ')\\s*[?!.]*\\s*$',
  'i',
);
const REMEMBER_RE = new RegExp(
  '^\\s*(?:' +
    'remember(?:\\s+that)?|note(?:\\s+that)?|memorize|keep\\s+in\\s+mind(?:\\s+that)?|' + // en
    'lembre(?:-se)?(?:\\s+de)?|anote|guarde|memorize|' + // pt
    'recuerda(?:\\s+que)?|anota|guarda|memoriza' + // es
    ')\\b\\s*(?:que\\b|that\\b|isso\\b|disso\\b|:|-)?\\s*[:\\-]?\\s*([\\s\\S]+)$',
  'i',
);
const FORGET_RE = new RegExp(
  '^\\s*(?:' +
    '(?:forget|esque[çc]a(?:-se)?|olvida(?:te)?)(?:\\s+(?:about|de))?\\b|' +
    '(?:delete|remove|erase|apague|remova|delete|borra|elimina|quita)\\s+(?:from\\s+(?:the\\s+)?memory|da\\s+mem[óo]ria|a\\s+mem[óo]ria|de\\s+la\\s+memoria|la\\s+memoria)' +
    ')\\s*(?:that\\b|que\\b|:|-)?\\s*[:\\-]?\\s*([\\s\\S]+)$',
  'i',
);
const FORGET_ALL_RE = new RegExp(
  '^\\s*(?:' +
    'forget\\s+(?:everything|all)|(?:erase|clear|wipe|delete)\\s+(?:all\\s+)?(?:the\\s+|my\\s+)?memory|' +
    'esque[çc]a\\s+tudo|(?:apague|limpe|remova)\\s+(?:toda\\s+)?a\\s+mem[óo]ria|' +
    'olvida\\s+todo|(?:borra|elimina|limpia)\\s+(?:toda\\s+)?la\\s+memoria' +
    ')\\s*[.!]*\\s*$',
  'i',
);

/** @returns {{type:'show'|'remember'|'forget'|'forget_all', text?:string}|null} */
function parseMemoryCommand(input) {
  const s = String(input).trim();
  if (SHOW_RE.test(s)) return { type: 'show' };
  if (FORGET_ALL_RE.test(s)) return { type: 'forget_all' };
  let m = FORGET_RE.exec(s);
  if (m && m[1].trim()) return { type: 'forget', text: m[1].trim().replace(/[.!]+$/, '') };
  m = REMEMBER_RE.exec(s);
  if (m && m[1].trim().length >= 3) return { type: 'remember', text: m[1].trim() };
  return null;
}

function fmtList(list) {
  return list.map((m) => `- **#${m.id}** ${m.text}`).join('\n');
}

/** Runs a memory command against the DB. Returns the reply text (in the UI language). */
function handleMemoryCommand(cmd, db) {
  switch (cmd.type) {
    case 'remember': {
      const m = db.addMemory(cmd.text);
      return tr(m.duplicate ? 'memc.dup' : 'memc.saved', { id: m.id, text: m.text });
    }
    case 'show': {
      const list = db.listMemories();
      return list.length ? tr('memc.list', { n: list.length, list: fmtList(list) }) : tr('memc.empty');
    }
    case 'forget_all':
      return tr('memc.noWipe');
    case 'forget': {
      const idm = /^#?(\d+)$/.exec(cmd.text);
      if (idm) {
        const id = Number(idm[1]);
        const found = db.listMemories().find((m) => m.id === id);
        if (!found) return tr('memc.noId', { id });
        db.deleteMemory(id);
        return tr('memc.forgot', { id, text: found.text });
      }
      const found = db.findMemories(cmd.text);
      if (found.length === 0) return tr('memc.noMatch', { text: cmd.text });
      if (found.length > 1) return tr('memc.many', { n: found.length, text: cmd.text, id: found[0].id, list: fmtList(found) });
      db.deleteMemory(found[0].id);
      return tr('memc.forgot', { id: found[0].id, text: found[0].text });
    }
    default:
      return '';
  }
}

/**
 * Text block with the profile (always) and the memories (all of them if they fit the budget,
 * otherwise the ones matching the question plus the newest). Returns '' if there is nothing.
 */
function buildMemoryBlock(db, question, { profile = '', memoryEnabled = true, maxChars = 1500 } = {}) {
  const parts = [];
  if (profile && profile.trim()) parts.push(`User profile (fixed):\n${profile.trim().slice(0, 1500)}`);

  if (memoryEnabled) {
    const all = db.listMemories(); // newest first
    if (all.length) {
      let chosen;
      const total = all.reduce((n, m) => n + m.text.length + 3, 0);
      if (total <= maxChars) {
        chosen = all;
      } else {
        const seen = new Set();
        chosen = [];
        let used = 0;
        for (const m of [...db.searchMemories(question, 8), ...all]) {
          if (seen.has(m.id) || used + m.text.length + 3 > maxChars) continue;
          seen.add(m.id);
          chosen.push(m);
          used += m.text.length + 3;
        }
      }
      chosen = [...chosen].sort((a, b) => a.id - b.id);
      if (chosen.length) {
        parts.push(`Things the user asked you to remember (written by the user, in the first person):\n${chosen.map((m) => `- ${m.text}`).join('\n')}`);
      }
    }
  }
  return parts.join('\n\n');
}

module.exports = { parseMemoryCommand, handleMemoryCommand, buildMemoryBlock, norm };
