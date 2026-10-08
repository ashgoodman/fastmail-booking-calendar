import { isValidTimeZone, hm } from './time.js';

export const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// Paths a meeting-type link may not take.
const RESERVED_SLUGS = new Set(['admin', 'api', 'style', 'style.css', 'index', 'index.html', 'favicon.ico', 'robots.txt']);

export const DEFAULT_TYPE = {
  id: 'meeting',
  slug: 'meeting',
  enabled: true,
  title: '30-minute meeting',
  description: '',
  location: '',
  // 'jitsi': every booking gets its own meet.jit.si room link.
  video: 'none',
  durationMinutes: 30,
  slotStepMinutes: 30,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  minNoticeHours: 12,
  maxDaysAhead: 21,
  maxPerDay: 0,
  weekly: {
    sun: [], mon: [['09:00', '17:00']], tue: [['09:00', '17:00']], wed: [['09:00', '17:00']],
    thu: [['09:00', '17:00']], fri: [['09:00', '17:00']], sat: [],
  },
  busyCalendars: [],
  targetCalendar: '',
  eventTitle: '{name} — {title}',
  fields: [
    { id: 'name', label: 'Your name', type: 'text', required: true },
    { id: 'email', label: 'Email', type: 'email', required: true },
    { id: 'notes', label: 'Anything I should know?', type: 'textarea', required: false },
  ],
  // 'invite': the calendar server emails a calendar invite from fromAddress.
  // 'email': we send our own confirmation email from fromAddress instead. Never both.
  notify: 'invite',
  fromAddress: '',
  confirmationMessage: 'Hi {name},\n\nYou are booked for {title} on {when}.\n\nSee you then.',
};

export const DEFAULT_CONFIG = {
  bookingEnabled: false,
  hostName: '',
  timezone: 'UTC',
  blackoutDates: [],
  types: [DEFAULT_TYPE],
};

const TYPE_KEYS = Object.keys(DEFAULT_TYPE);
const FIELD_TYPES = ['text', 'email', 'tel', 'textarea', 'select', 'checkbox'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

function int(v, min, max, name) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max}`);
  return n;
}

function str(v, max, name) {
  if (typeof v !== 'string' || v.length > max) throw new Error(`${name} must be text up to ${max} characters`);
  return v;
}

// Before meeting types existed the config was a single flat type; lift it into types[0].
function upgrade(input) {
  if (Array.isArray(input?.types)) return input;
  const type = {};
  for (const k of TYPE_KEYS) if (input && k in input) type[k] = input[k];
  return {
    bookingEnabled: input?.bookingEnabled,
    hostName: input?.hostName,
    timezone: input?.timezone,
    blackoutDates: input?.blackoutDates,
    types: [{ ...DEFAULT_TYPE, ...type }],
  };
}

function validateType(input, live, n) {
  const t = { ...DEFAULT_TYPE, ...input };
  const where = `"${t.title || `Meeting type ${n}`}"`;
  const out = {
    id: str(t.id, 60, 'id'),
    slug: str(t.slug, 41, 'link').toLowerCase(),
    enabled: !!t.enabled,
    title: str(t.title, 120, 'title').trim(),
    description: str(t.description, 2000, 'description'),
    location: str(t.location, 300, 'location'),
    video: t.video,
    durationMinutes: int(t.durationMinutes, 5, 480, `${where}: meeting length`),
    slotStepMinutes: int(t.slotStepMinutes, 5, 480, `${where}: start times every`),
    bufferBeforeMinutes: int(t.bufferBeforeMinutes, 0, 240, `${where}: buffer before`),
    bufferAfterMinutes: int(t.bufferAfterMinutes, 0, 240, `${where}: buffer after`),
    minNoticeHours: int(t.minNoticeHours, 0, 24 * 60, `${where}: minimum notice`),
    maxDaysAhead: int(t.maxDaysAhead, 1, 90, `${where}: how far ahead`),
    maxPerDay: int(t.maxPerDay, 0, 100, `${where}: max per day`),
    weekly: {},
    busyCalendars: [],
    targetCalendar: str(t.targetCalendar, 300, 'targetCalendar'),
    eventTitle: str(t.eventTitle, 200, 'event title'),
    fields: [],
    notify: t.notify,
    fromAddress: str(t.fromAddress, 200, 'send-from address').trim(),
    confirmationMessage: str(t.confirmationMessage, 4000, 'confirmation message'),
  };
  if (!out.title) throw new Error(`Meeting type ${n} needs a title`);
  if (!SLUG_RE.test(out.slug) || RESERVED_SLUGS.has(out.slug)) {
    throw new Error(`${where}: the link must be lowercase letters, numbers and dashes (not "${out.slug}")`);
  }
  if (!['invite', 'email'].includes(out.notify)) throw new Error('notify must be invite or email');
  if (!['none', 'jitsi'].includes(out.video)) throw new Error('video must be none or jitsi');

  for (const day of DAYS) {
    const wins = Array.isArray(t.weekly?.[day]) ? t.weekly[day] : [];
    out.weekly[day] = wins.map(([s, e]) => {
      if (!TIME_RE.test(s) || !TIME_RE.test(e) || hm(s) >= hm(e)) throw new Error(`${where}: invalid hours ${s}–${e} on ${day}`);
      return [s, e];
    }).sort((a, b) => hm(a[0]) - hm(b[0]));
  }

  for (const id of Array.isArray(t.busyCalendars) ? t.busyCalendars : []) out.busyCalendars.push(str(id, 300, 'busyCalendars'));
  if (live && out.enabled && !out.targetCalendar) throw new Error(`${where}: choose the calendar that receives bookings`);

  const seen = new Set();
  for (const f of Array.isArray(t.fields) ? t.fields : []) {
    const id = str(f.id, 40, 'question id');
    if (!/^[a-z][a-z0-9_]*$/.test(id) || seen.has(id)) throw new Error(`${where}: question id "${id}" must be unique lowercase letters/digits/_`);
    seen.add(id);
    if (!FIELD_TYPES.includes(f.type)) throw new Error(`${where}: question ${id} has unknown type ${f.type}`);
    const field = { id, label: str(f.label, 200, 'question').trim(), type: f.type, required: !!f.required };
    if (!field.label) throw new Error(`${where}: every question needs some text`);
    if (f.type === 'select') {
      field.options = (Array.isArray(f.options) ? f.options : []).map((o) => str(o, 200, 'choice'));
      if (!field.options.length) throw new Error(`${where}: the choice question "${field.label}" needs choices`);
    }
    out.fields.push(field);
  }
  // name + email are always collected: the confirmation needs them.
  for (const [id, type, label] of [['email', 'email', 'Email'], ['name', 'text', 'Your name']]) {
    const f = out.fields.find((x) => x.id === id);
    if (f) { f.required = true; f.type = type; } else out.fields.unshift({ id, label, type, required: true });
  }
  return out;
}

// Validates a full config from the settings page. Throws with a readable message.
export function validateConfig(raw) {
  const c = { ...DEFAULT_CONFIG, ...upgrade(raw) };
  const out = {
    bookingEnabled: !!c.bookingEnabled,
    hostName: str(c.hostName ?? '', 120, 'your name'),
    timezone: c.timezone ?? 'UTC',
    blackoutDates: [],
    types: [],
  };
  if (!isValidTimeZone(out.timezone)) throw new Error('timezone is not a valid IANA zone');
  for (const d of Array.isArray(c.blackoutDates) ? c.blackoutDates : []) {
    if (!DATE_RE.test(d)) throw new Error(`invalid day off ${d}`);
    out.blackoutDates.push(d);
  }
  const types = Array.isArray(c.types) ? c.types : [];
  if (types.length > 50) throw new Error('up to 50 meeting types');
  const slugs = new Set();
  const ids = new Set();
  types.forEach((t, i) => {
    const v = validateType(t, out.bookingEnabled, i + 1);
    if (slugs.has(v.slug)) throw new Error(`Two meeting types use the link "${v.slug}"`);
    if (ids.has(v.id)) throw new Error(`Two meeting types share the id "${v.id}"`);
    slugs.add(v.slug);
    ids.add(v.id);
    out.types.push(v);
  });
  return out;
}

export function findType(c, slug) {
  return c.types.find((t) => t.slug === slug) || null;
}

export function isOpen(c, t) {
  return !!(c.bookingEnabled && t?.enabled);
}

// A type with the account-wide settings folded in, which is what slot maths needs.
export function effective(c, t) {
  return { ...t, timezone: c.timezone, blackoutDates: c.blackoutDates };
}

// How the location reads to guests before they book.
function guestLocation(t) {
  return t.video === 'jitsi' ? 'Video call (Jitsi) — your link comes with the confirmation' : t.location;
}

// What the public landing page may see.
export function publicConfig(c) {
  return {
    bookingEnabled: c.bookingEnabled,
    hostName: c.hostName,
    types: c.bookingEnabled
      ? c.types.filter((t) => t.enabled).map((t) => ({ slug: t.slug, title: t.title, description: t.description, durationMinutes: t.durationMinutes, location: guestLocation(t) }))
      : [],
  };
}

// What a meeting type's booking page may see.
export function publicType(c, t) {
  return {
    bookingEnabled: isOpen(c, t),
    hostName: c.hostName,
    timezone: c.timezone,
    slug: t.slug,
    title: t.title,
    description: t.description,
    durationMinutes: t.durationMinutes,
    minNoticeHours: t.minNoticeHours,
    maxDaysAhead: t.maxDaysAhead,
    location: guestLocation(t),
    fields: t.fields,
  };
}
