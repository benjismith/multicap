// tools/build-pinyin.js — build data/pinyin.json from the DuiDuiDui records corpus.
//
//   node tools/build-pinyin.js [recordsDir] [outFile]
//
// Defaults: ~/dev/redthreadlabs/duiduidui-data/data/records → data/pinyin.json
//
// Keeps only what the overlay needs to annotate a Simplified Chinese line:
//   words  — text → syllables (space-separated, one per hanzi) for `word` and `phrase`
//            records made purely of hanzi, up to MAX_LEN characters. When a word has
//            several sense files with different readings, the lowest sense_rank wins.
//   chars  — hanzi → readings in sense order, from `character` records (one reading per
//            sense file, de-duplicated). Fallback for text no word entry covers.
// Erhua (…儿 written as one syllable ending in "r") is split so the syllable count still
// matches the character count; other mismatches are kept as a whole-word reading and
// counted in the report.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const recordsDir = process.argv[2] || path.join(os.homedir(), 'dev/redthreadlabs/duiduidui-data/data/records');
const outFile = process.argv[3] || path.join(__dirname, '..', 'data', 'pinyin.json');
const MAX_LEN = 6;
const HANZI_ONLY = /^\p{Script=Han}+$/u;

const t0 = Date.now();
const names = fs.readdirSync(recordsDir).filter((n) => n.endsWith('.json'));
console.log(`${names.length} record files in ${recordsDir}`);

/** @type {Map<string, {syl: string[], rank: number, whole: boolean}>} */
const words = new Map();
/** @type {Map<string, Array<{p: string, rank: number}>>} */
const chars = new Map();
const stats = { read: 0, parseErrors: 0, byType: {}, skippedNonHanzi: 0, skippedLong: 0, wordMismatch: 0, erhuaSplit: 0, wordReadingConflicts: 0 };
/** @type {string[]} */
const mismatchSamples = [];

for (const name of names) {
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(path.join(recordsDir, name), 'utf8'));
  } catch {
    stats.parseErrors++;
    continue;
  }
  stats.read++;
  const type = rec && rec.type;
  stats.byType[type] = (stats.byType[type] || 0) + 1;
  if (type !== 'character' && type !== 'word' && type !== 'phrase') continue;
  const text = typeof rec.text === 'string' ? rec.text.trim() : '';
  if (!text || !HANZI_ONLY.test(text)) { stats.skippedNonHanzi++; continue; }
  const cps = [...text];
  if (cps.length > MAX_LEN) { stats.skippedLong++; continue; }
  const raw = String(rec.pinyin_tokenized || rec.pinyin || '').trim();
  if (!raw) continue;
  const rank = typeof rec.sense_rank === 'number' ? rec.sense_rank : 99;

  if (type === 'character') {
    if (cps.length !== 1) continue;
    const list = chars.get(text) || [];
    if (!list.some((e) => e.p === raw)) list.push({ p: raw, rank });
    chars.set(text, list);
    continue;
  }

  let syl = raw.split(/\s+/).filter(Boolean);
  let whole = false;
  if (syl.length !== cps.length) {
    // 花儿 → "huār": one syllable for two characters; split the erhua "r" onto 儿.
    if (cps[cps.length - 1] === '儿' && syl.length === cps.length - 1 && /r$/.test(syl[syl.length - 1])) {
      const last = syl[syl.length - 1];
      syl = [...syl.slice(0, -1), last.slice(0, -1), 'r'];
      stats.erhuaSplit++;
    } else {
      stats.wordMismatch++;
      if (mismatchSamples.length < 12) mismatchSamples.push(`${text} → "${raw}"`);
      whole = true;
    }
  }
  const prev = words.get(text);
  if (prev) {
    if (prev.syl.join(' ') !== syl.join(' ')) stats.wordReadingConflicts++;
    if (rank < prev.rank) words.set(text, { syl, rank, whole });
  } else {
    words.set(text, { syl, rank, whole });
  }
}

// Characters that only appear inside words: derive a reading from the aligned syllable.
let derivedChars = 0;
for (const [text, w] of words) {
  if (w.whole) continue;
  const cps = [...text];
  cps.forEach((c, i) => {
    if (!chars.has(c)) { chars.set(c, [{ p: w.syl[i], rank: 999 }]); derivedChars++; }
  });
}

/** @type {Record<string, string>} */
const wordOut = {};
for (const [text, w] of [...words].sort((a, b) => a[0].localeCompare(b[0]))) wordOut[text] = w.syl.join(' ');
/** @type {Record<string, string[]>} */
const charOut = {};
for (const [c, list] of [...chars].sort((a, b) => a[0].localeCompare(b[0]))) charOut[c] = list.sort((a, b) => a.rank - b.rank).map((e) => e.p);

const out = {
  meta: {
    built: new Date().toISOString(),
    source: 'DuiDuiDui records corpus (private)',
    words: Object.keys(wordOut).length,
    chars: Object.keys(charOut).length,
    maxLen: MAX_LEN,
    notes: 'words: text → space-separated syllables, one per character (erhua split); chars: readings in sense order. Simplified Chinese only.',
  },
  words: wordOut,
  chars: charOut,
};
fs.mkdirSync(path.dirname(outFile), { recursive: true });
const json = JSON.stringify(out);
fs.writeFileSync(outFile, json);

console.log(`types: ${JSON.stringify(stats.byType)}`);
console.log(`read ${stats.read}, parse errors ${stats.parseErrors}, skipped non-hanzi ${stats.skippedNonHanzi}, skipped >${MAX_LEN} chars ${stats.skippedLong}`);
console.log(`words ${out.meta.words} (reading conflicts across senses: ${stats.wordReadingConflicts}, erhua splits: ${stats.erhuaSplit}, syllable/char mismatches kept whole: ${stats.wordMismatch})`);
if (mismatchSamples.length) console.log('  mismatch samples: ' + mismatchSamples.join(' | '));
console.log(`chars ${out.meta.chars} (${derivedChars} derived from words only)`);
console.log(`wrote ${outFile} (${(json.length / 1024 / 1024).toFixed(2)} MB) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
