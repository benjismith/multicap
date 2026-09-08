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

// Cross-validation: every phrase/sentence whose tokenized pinyin aligns one syllable per
// hanzi is evidence for the reading of each word it contains. A word record whose reading
// has no support while another reading has plenty is almost certainly a data error
// (e.g. 长大 recorded as chángdà while every sentence says zhǎng dà); the majority wins
// and the case is reported so the corpus can be fixed.
const MIN_VOTES = 5;
/** @type {Map<string, Map<string, number>>} */
const votes = new Map();
let contexts = 0;
for (const name of names) {
  let rec;
  try { rec = JSON.parse(fs.readFileSync(path.join(recordsDir, name), 'utf8')); } catch { continue; }
  if (!rec || (rec.type !== 'sentence' && rec.type !== 'phrase' && rec.type !== 'word')) continue;
  const hanzi = [...String(rec.text || '')].filter((c) => /\p{Script=Han}/u.test(c));
  const syl = String(rec.pinyin_tokenized || '').trim().split(/\s+/).filter(Boolean);
  if (hanzi.length < 2 || syl.length !== hanzi.length) continue;
  contexts++;
  for (let i = 0; i < hanzi.length; i++) {
    for (let len = 2; len <= MAX_LEN && i + len <= hanzi.length; len++) {
      const w = hanzi.slice(i, i + len).join('');
      if (w === rec.text) continue; // a record is not evidence for itself
      if (!words.has(w)) continue;
      const reading = syl.slice(i, i + len).join(' ').toLowerCase();
      let m = votes.get(w);
      if (!m) votes.set(w, (m = new Map()));
      m.set(reading, (m.get(reading) || 0) + 1);
    }
  }
}
// Neutral-tone vs full-tone spellings of the same syllable (bian / biān) are conventions,
// not errors, so they count as agreement. Different base letters or two different tone
// marks (guān / guàn) are real disagreements.
/** @param {string} syl */
const toneOf = (syl) => { const n = syl.normalize('NFD'); return /\u0304/.test(n) ? 1 : /\u0301/.test(n) ? 2 : /\u030c/.test(n) ? 3 : /\u0300/.test(n) ? 4 : 0; };
/** @param {string} syl */
const baseOf = (syl) => syl.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
/** @param {string} a @param {string} b readings as space-separated syllables */
const disagree = (a, b) => {
  const xs = a.split(' '); const ys = b.split(' ');
  if (xs.length !== ys.length) return true;
  return xs.some((x, i) => baseOf(x) !== baseOf(ys[i]) || (toneOf(x) && toneOf(ys[i]) && toneOf(x) !== toneOf(ys[i])));
};
// A syllable the character cannot have at all (然 as "ràn", 致 as "yǐn", 了 as "qǐ") is a
// certain error: fix it from any corpus evidence. A merely different reading is only
// overridden when the corpus is emphatic (MIN_VOTES contexts, MAJORITY of all votes),
// because sentences for rare words often repeat one mistake.
const MAJORITY = 0.8;
/** @param {string} c @param {string} syl */
const charCanRead = (c, syl) => { const list = chars.get(c); return !list || list.some((e) => !disagree(e.p, syl)); };
/** @type {string[]} */
const suspects = [];
/** @type {string[]} */
const unfixable = [];
let overridden = 0;
for (const [w, entry] of words) {
  if (entry.whole) continue;
  const cps = [...w];
  const impossible = entry.syl.some((syl, i) => !charCanRead(cps[i], syl));
  const m = votes.get(w);
  if (!m) { if (impossible) unfixable.push(`${w}\trecord: ${entry.syl.join(' ')}`); continue; }
  const own = entry.syl.join(' ').toLowerCase();
  const ranked = [...m].sort((a, b) => b[1] - a[1]);
  const [top, topVotes] = ranked[0];
  let total = 0;
  let ownVotes = 0;
  for (const [r, n] of m) { total += n; if (!disagree(r, own)) ownVotes += n; }
  if (!disagree(top, own)) continue;
  const emphatic = topVotes >= MIN_VOTES && topVotes / total >= MAJORITY && ownVotes === 0;
  if (!impossible && !emphatic) continue;
  suspects.push(`${w}\trecord: ${entry.syl.join(' ')}\tcorpus: ${top} (${topVotes}/${total} contexts${impossible ? ', impossible syllable' : ''})`);
  words.set(w, { syl: top.split(' '), rank: entry.rank, whole: false });
  overridden++;
}
suspects.sort();
unfixable.sort();
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(path.join(path.dirname(outFile), 'pinyin-suspects.txt'),
  `# Word records whose reading looks wrong. Overridden from the sentences/phrases containing the word when the\n# record uses a syllable the character cannot have, or when ${MIN_VOTES}+ contexts agree at ${MAJORITY * 100}%+ against it.\n` +
  suspects.join('\n') + '\n\n# Impossible syllable but no corpus evidence to fix it (record kept):\n' + unfixable.join('\n') + '\n');

// Characters that only appear inside words: derive a reading from the aligned syllable.
// Also count how often each reading occurs across all word entries: sense_rank orders
// meanings, not readings (好's rank-1 sense is hào "to like"), and the per-character
// fallback should show the reading a learner most often meets (hǎo).
let derivedChars = 0;
/** @type {Map<string, Map<string, number>>} */
const readingFreq = new Map();
for (const [text, w] of words) {
  if (w.whole) continue;
  const cps = [...text];
  cps.forEach((c, i) => {
    if (!chars.has(c)) { chars.set(c, [{ p: w.syl[i], rank: 999 }]); derivedChars++; }
    let f = readingFreq.get(c);
    if (!f) readingFreq.set(c, (f = new Map()));
    const key = baseOf(w.syl[i]) + '/' + toneOf(w.syl[i]);
    f.set(key, (f.get(key) || 0) + 1);
  });
}
/** Corpus frequency of a character reading (neutral-tone spellings count for the marked one too). @param {string} c @param {string} syl */
const freqOf = (c, syl) => {
  const f = readingFreq.get(c);
  if (!f) return 0;
  let n = 0;
  for (const [key, count] of f) { const [b, t] = key.split('/'); if (b === baseOf(syl) && (t === '0' || toneOf(syl) === 0 || Number(t) === toneOf(syl))) n += count; }
  return n;
};

/** @type {Record<string, string>} */
const wordOut = {};
for (const [text, w] of [...words].sort((a, b) => a[0].localeCompare(b[0]))) wordOut[text] = w.syl.join(' ');
// Standalone grammatical particles: when one of these is not part of a dictionary word, the
// particle reading is almost always the right one in subtitles, whatever the word-frequency
// order says (地 inside words is dì, but a lone 地 after an adverb is de).
/** @type {Record<string, string>} */
const STANDALONE_FIRST = { '地': 'de', '得': 'de', '了': 'le', '着': 'zhe', '的': 'de', '过': 'guo', '为': 'wèi', '吗': 'ma', '呢': 'ne', '吧': 'ba', '啊': 'a' };
/** @type {Record<string, string[]>} */
const charOut = {};
for (const [c, list] of [...chars].sort((a, b) => a[0].localeCompare(b[0]))) {
  const ordered = list.sort((a, b) => (freqOf(c, b.p) - freqOf(c, a.p)) || (a.rank - b.rank)).map((e) => e.p);
  const first = STANDALONE_FIRST[c];
  if (first && ordered.includes(first)) ordered.splice(0, 0, ...ordered.splice(ordered.indexOf(first), 1));
  charOut[c] = ordered;
}

const out = {
  meta: {
    built: new Date().toISOString(),
    source: 'DuiDuiDui records corpus (private)',
    words: Object.keys(wordOut).length,
    chars: Object.keys(charOut).length,
    maxLen: MAX_LEN,
    notes: 'words: text → space-separated syllables, one per character; chars: readings ordered by corpus frequency, then sense rank. Simplified Chinese only.',
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
console.log(`cross-validation: ${contexts} contexts; ${overridden} word readings overridden by corpus majority (see data/pinyin-suspects.txt)`);
console.log(`chars ${out.meta.chars} (${derivedChars} derived from words only)`);
console.log(`wrote ${outFile} (${(json.length / 1024 / 1024).toFixed(2)} MB) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
