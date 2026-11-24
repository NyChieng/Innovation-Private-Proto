import { locale, msg, t } from './i18n.js';

/*
 * The label maps are getters, so each read returns the label in the language
 * chosen now rather than the one in force when this module first loaded.
 * Object.entries() still works on them - it calls the getters.
 */

const conservation = (label, short, threat) => ({ get label() { return t(label); }, short, threat });

export const CONSERVATION = {
  NE: conservation(msg('Not evaluated'), 'NE', false),
  DD: conservation(msg('Data deficient'), 'DD', false),
  LC: conservation(msg('Least concern'), 'LC', false),
  NT: conservation(msg('Near threatened'), 'NT', false),
  VU: conservation(msg('Vulnerable'), 'VU', true),
  EN: conservation(msg('Endangered'), 'EN', true),
  CR: conservation(msg('Critically endangered'), 'CR', true),
  EW: conservation(msg('Extinct in the wild'), 'EW', true),
  EX: conservation(msg('Extinct'), 'EX', true),
};

const status = (label, cls) => ({ get label() { return t(label); }, cls });

export const STATUS = {
  pending: status(msg('Pending review'), 'badge-warn'),
  approved: status(msg('Published'), 'badge-ok'),
  rejected: status(msg('Returned'), 'badge-danger'),
  archived: status(msg('Archived'), 'badge-neutral'),
};

/** { key: 'English label' } -> the same keys, read back translated. */
function translated(map) {
  const out = {};
  for (const [k, v] of Object.entries(map)) {
    Object.defineProperty(out, k, { get: () => t(v), enumerable: true });
  }
  return out;
}

export const HEALTH = translated({
  healthy: msg('Healthy'), fair: msg('Fair'), poor: msg('Poor'), dead: msg('Dead'),
});

export const LIFE_STAGE = translated({
  seedling: msg('Seedling'), sapling: msg('Sapling'), mature: msg('Mature'),
});

export const GROWTH_FORM = translated({
  tree: msg('Tree'), shrub: msg('Shrub'), herb: msg('Herb'), palm: msg('Palm'),
  climber: msg('Climber'), epiphyte: msg('Epiphyte'), parasite: msg('Parasite'),
});

// Role labels come from the database. These are the ones the seed and the
// schema write, so they can be translated; a role added later shows as named.
msg('Administrator'); msg('Ranger'); msg('Botanist / Officer'); msg('Botanist/Officer'); msg('Senior Botanist');

/** A role label from the database, translated when it is one of ours. */
export const roleLabel = (label) => (label ? t(label) : label);

// Fixed sentences the API writes into a response, rather than an error.
msg('Location withheld');
msg('The exact location of this species is not published, to protect it from collection.');
msg('Niah National Park');

/** Text the server wrote, translated when it is one of the fixed sentences. */
export const fromServer = (text) => (text ? t(text) : text);

export const titleCase = (s) =>
  String(s || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// One formatter per language, made the first time it is needed.
const formatters = new Map();
function formatter(kind) {
  const key = kind + ':' + locale();
  if (!formatters.has(key)) {
    formatters.set(key, new Intl.DateTimeFormat(locale(), kind === 'time'
      ? { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }
      : { day: 'numeric', month: 'short', year: 'numeric' }));
  }
  return formatters.get(key);
}

export const formatDate = (iso) => (iso ? formatter('date').format(new Date(iso)) : '--');
export const formatDateTime = (iso) => (iso ? formatter('time').format(new Date(iso)) : '--');

export function relativeTime(iso) {
  if (!iso) return '--';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return t('just now');
  if (mins < 60) return t('{n} min ago', { n: mins });
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs === 1 ? t('{n} hour ago', { n: hrs }) : t('{n} hours ago', { n: hrs });
  const days = Math.round(hrs / 24);
  if (days < 7) return days === 1 ? t('{n} day ago', { n: days }) : t('{n} days ago', { n: days });
  if (days < 31) {
    const w = Math.round(days / 7);
    return w === 1 ? t('{n} week ago', { n: w }) : t('{n} weeks ago', { n: w });
  }
  return formatDate(iso);
}

export const num = (n) => (n === null || n === undefined ? '--' : Number(n).toLocaleString(locale()));

export function coords(lat, lon) {
  if (lat === null || lat === undefined || lon === null || lon === undefined) return null;
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(5)}° ${ns}, ${Math.abs(lon).toFixed(5)}° ${ew}`;
}

export const measure = (v, unit) => (v === null || v === undefined ? null : `${v} ${unit}`);

/**
 * Where a role should land after signing in - where its work is. Decided by
 * permission, like everything else, so a renamed role still lands right.
 */
export function homeFor(user) {
  if (!user) return '/';
  const has = (code) => !!user.permissions?.includes(code);
  if (has('user.manage')) return '/staff/users';
  // A senior botanist reviews records rather than registering them.
  if (has('plant.approve') && !has('plant.create')) return '/staff/review';
  if (has('plant.view_all') || has('plant.create')) return '/staff/plants';
  // A ranger: in charge when a sensor raises an alert.
  if (has('sensor.view')) return '/staff/iot';
  return '/staff/me';
}
