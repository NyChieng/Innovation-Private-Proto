/**
 * Translation completeness (issue #5).
 *
 * Every string the interface passes to t() - or marks with msg() - must have
 * a Malay and a Chinese entry in FloraScan-Web-App/src/lib/locales.js, and
 * each translation must keep the same {placeholders} as the English, or a
 * name or a count silently disappears from the sentence.
 *
 * No server or browser needed:
 *   npm run test:i18n
 *
 * With --report it also lists JSX text that is not wrapped in t() at all,
 * which is how a screen added later gets caught still speaking only English.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(root, 'FloraScan-Web-App', 'src');
const REPORT = process.argv.includes('--report');

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(jsx?|mjs)$/.test(e.name) && e.name !== 'locales.js') files.push(p);
  }
})(src);

/** Read one JS string literal starting at text[i]; returns [value, end] or null. */
function literal(text, i) {
  const q = text[i];
  if (q !== "'" && q !== '"') return null;
  let out = '';
  for (let j = i + 1; j < text.length; j += 1) {
    const ch = text[j];
    if (ch === '\\') {
      const n = text[j + 1];
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
      j += 1;
      continue;
    }
    if (ch === q) return [out, j + 1];
    if (ch === '\n') return null;
    out += ch;
  }
  return null;
}

const used = new Map(); // key -> first place it was seen
const dynamic = [];

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const rel = path.relative(root, file);
  const re = /(?<![\w.$])(t|msg)\(\s*/g;
  let m;
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length;
    const lit = literal(text, start);
    if (!lit) {
      // t(label) with a variable is fine: the label is a key marked with
      // msg() where it is defined. What can never work is a key built at
      // run time - a template string, or 'text' + value - because no
      // dictionary entry can match it. Use {placeholders} instead.
      const arg = text.slice(start, start + 200).split(/[,)]/)[0];
      if (arg.startsWith('`') || /['"]\s*\+|\+\s*['"]/.test(arg)) {
        const line = text.slice(0, m.index).split('\n').length;
        dynamic.push(`${rel}:${line}  ${text.slice(m.index, m.index + 60).split('\n')[0]}`);
      }
      continue;
    }
    if (!used.has(lit[0])) {
      used.set(lit[0], `${rel}:${text.slice(0, m.index).split('\n').length}`);
    }
  }
}

const DICT = (await import(pathToFileURL(path.join(src, 'lib', 'locales.js')).href)).default;

const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort().join(',');

const missing = [];
const broken = [];
for (const [key, where] of used) {
  const entry = DICT[key];
  if (!entry || !entry[0] || !entry[1]) { missing.push(`${where}  ${JSON.stringify(key)}`); continue; }
  for (const [i, name] of [[0, 'ms'], [1, 'zh']]) {
    if (placeholders(entry[i]) !== placeholders(key)) {
      broken.push(`${name} ${JSON.stringify(key)} -> ${JSON.stringify(entry[i])}`);
    }
  }
}
const unused = Object.keys(DICT).filter((k) => !used.has(k));

let failed = 0;
const report = (label, list, fatal = true) => {
  if (!list.length) { console.log(`  \x1b[32mok\x1b[0m   ${label}`); return; }
  if (fatal) failed += 1;
  console.log(`  ${fatal ? '\x1b[31mFAIL\x1b[0m' : '\x1b[33mnote\x1b[0m'} ${label} (${list.length})`);
  for (const x of list.slice(0, REPORT ? Infinity : 40)) console.log('         ' + x);
  if (!REPORT && list.length > 40) console.log(`         ... and ${list.length - 40} more`);
};

console.log(`\n\x1b[1mTranslations\x1b[0m  ${used.size} strings in ${files.length} files, ${Object.keys(DICT).length} dictionary entries\n`);
report('every string has a Malay and a Chinese translation', missing);
report('every translation keeps the same {placeholders}', broken);
report('no t() key is built at run time', dynamic);
report('no dictionary entry is left over from a removed string', unused, false);

if (REPORT) {
  // JSX text with letters in it that is not inside {...}: a candidate for t().
  const bare = [];
  for (const file of files.filter((f) => f.endsWith('.jsx'))) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      for (const mm of line.matchAll(/>([^<>{}]*[A-Za-z]{2,}[^<>{}]*)</g)) {
        if (/^[\s&;#\w]*;$/.test(mm[1].trim())) continue;
        bare.push(`${path.relative(root, file)}:${i + 1}  ${mm[1].trim().slice(0, 70)}`);
      }
      for (const mm of line.matchAll(/\b(placeholder|title|aria-label|label|alt)="([^"]*[A-Za-z]{2,}[^"]*)"/g)) {
        bare.push(`${path.relative(root, file)}:${i + 1}  ${mm[1]}="${mm[2].slice(0, 60)}"`);
      }
    });
  }
  report('JSX text not passed through t()', bare, false);
}

console.log('');
if (failed) {
  console.log(`\x1b[31m${failed} translation check(s) failed.\x1b[0m`);
  process.exit(1);
}
console.log('\x1b[32mAll translation checks passed.\x1b[0m');
