import { Fragment, createElement } from 'react';
import DICT from './locales.js';

/**
 * Three interface languages, as the client asked: English, Malay and
 * Simplified Chinese (issue #5).
 *
 * The English text is the key. A screen calls t('Plant register') and gets
 * the English back unchanged, or the entry from locales.js in the chosen
 * language. Keeping the source text in the component means a screen still
 * reads naturally, and a string nobody has translated yet falls back to
 * English rather than showing a key like "nav.plants" to a visitor.
 *
 * tests/i18n.test.mjs fails the build if a string passed to t() has no Malay or
 * Chinese entry, so the fallback is a safety net, not the plan.
 *
 * What is translated is the interface. Records - species descriptions from
 * Wikipedia, field notes a botanist typed, server error messages - are shown
 * as they were written.
 */

export const LANGUAGES = [
  { code: 'en', label: 'English', short: 'EN', html: 'en', locale: 'en-GB' },
  { code: 'ms', label: 'Bahasa Melayu', short: 'BM', html: 'ms', locale: 'ms-MY' },
  { code: 'zh', label: '中文', short: '中文', html: 'zh-Hans', locale: 'zh-CN' },
];

const KEY = 'florascan.lang';
const COLUMN = { ms: 0, zh: 1 };

function initial() {
  try {
    const saved = localStorage.getItem(KEY);
    if (LANGUAGES.some((l) => l.code === saved)) return saved;
  } catch { /* storage blocked - fall through to the browser language */ }
  const nav = (navigator.languages || [navigator.language || 'en']).map((l) => String(l).toLowerCase());
  for (const l of nav) {
    if (l.startsWith('ms') || l.startsWith('id')) return 'ms';
    if (l.startsWith('zh')) return 'zh';
    if (l.startsWith('en')) return 'en';
  }
  return 'en';
}

let current = initial();

export const getLang = () => current;
export const langInfo = (code = current) => LANGUAGES.find((l) => l.code === code) || LANGUAGES[0];
/** The BCP 47 locale for Intl date and number formatting. */
export const locale = () => langInfo().locale;

/** Called by the store; components re-render because the store's value changes. */
export function setLang(code) {
  if (!LANGUAGES.some((l) => l.code === code)) return;
  current = code;
  try { localStorage.setItem(KEY, code); } catch { /* not fatal */ }
  document.documentElement.lang = langInfo(code).html;
}

/**
 * Translate, then fill in {placeholders}. A placeholder may be a React node -
 * a <strong> name, a link - in which case the result is an array of nodes
 * rather than a string, so a translation can move the bold word to wherever
 * its own grammar puts it.
 */
export function t(key, vars) {
  let text = key;
  if (current !== 'en') {
    const entry = DICT[key];
    if (entry && entry[COLUMN[current]]) text = entry[COLUMN[current]];
  }
  if (!vars) return text;

  const parts = text.split(/\{(\w+)\}/);
  const rich = parts.some((p, i) => i % 2 === 1 && vars[p] !== null && typeof vars[p] === 'object');
  if (!rich) return parts.map((p, i) => (i % 2 === 1 ? (vars[p] ?? '') : p)).join('');
  return parts.map((p, i) => (i % 2 === 1 ? createElement(Fragment, { key: i }, vars[p]) : p));
}

/**
 * Marks a string as a translation key without translating it - for labels
 * kept in a table and passed to t() later. It returns its argument, and is
 * there so tests/i18n.test.mjs can find the key, which it could not in a bare
 * t(label) call.
 */
export const msg = (key) => key;

document.documentElement.lang = langInfo().html;
