// Fastmail provider. Calendars over CalDAV (app password), mail over JMAP (API token with Email +
// Email submission scopes). Secrets: FASTMAIL_USER, FASTMAIL_APP_PASSWORD, FASTMAIL_API_TOKEN.

import { partsInTz } from '../time.js';

const DAV = 'https://caldav.fastmail.com';
const JMAP_SESSION = 'https://api.fastmail.com/jmap/session';

function basic(env) {
  return 'Basic ' + btoa(`${env.FASTMAIL_USER}:${env.FASTMAIL_APP_PASSWORD}`);
}

async function dav(env, method, path, body, headers = {}) {
  const r = await fetch(DAV + path, {
    method,
    headers: { authorization: basic(env), 'content-type': 'application/xml; charset=utf-8', ...headers },
    body,
  });
  const text = await r.text();
  if (r.status === 401) throw new Error('Fastmail rejected the app password');
  if (!r.ok) throw new Error(`Fastmail CalDAV ${method} ${r.status}`);
  return text;
}

function home(env) {
  return `/dav/calendars/user/${encodeURIComponent(env.FASTMAIL_USER).replace(/%40/g, '@')}/`;
}

function xmlText(s) {
  return s.replace(/^<!\[CDATA\[|\]\]>$/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

export async function account(env) {
  return { email: env.FASTMAIL_USER };
}

export async function listCalendars(env) {
  const xml = await dav(env, 'PROPFIND', home(env),
    '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:displayname/><d:resourcetype/><c:supported-calendar-component-set/><d:current-user-privilege-set/></d:prop></d:propfind>',
    { depth: '1' });
  const out = [];
  for (const resp of xml.split(/<\/?[a-zA-Z]+:response>/)) {
    if (!/<[a-zA-Z]+:calendar\s*\/>/.test(resp)) continue;
    if (!/comp name="VEVENT"/.test(resp)) continue;
    const id = resp.match(/href>[^<]*\/([^/<]+)\/<\//)?.[1];
    if (!id) continue;
    const name = xmlText(resp.match(/displayname>([\s\S]*?)<\/[a-zA-Z]+:displayname>/)?.[1] || id);
    const writable = /<[a-zA-Z]+:(write|write-content|all)\s*\/>/.test(resp);
    out.push({ id: decodeURIComponent(id), name, writable });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const icsTime = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');

function parseIcsUtc(s) {
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
}

function parseDuration(s) {
  const m = s.match(/^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return NaN;
  const [, w, d, h, mi, se] = m.map((x) => +x || 0);
  return ((((w * 7 + d) * 24 + h) * 60 + mi) * 60 + se) * 1000;
}

// Busy time from a CALDAV:free-busy-query per calendar. "Free" events are excluded by the server.
export async function busy(env, calendarIds, from, to) {
  const body = `<?xml version="1.0"?><c:free-busy-query xmlns:c="urn:ietf:params:xml:ns:caldav"><c:time-range start="${icsTime(from)}" end="${icsTime(to)}"/></c:free-busy-query>`;
  const results = await Promise.all(calendarIds.map((id) => dav(env, 'REPORT', `${home(env)}${encodeURIComponent(id)}/`, body, { depth: '1' })));
  const out = [];
  for (const ics of results) {
    for (const line of ics.replace(/\r?\n[ \t]/g, '').split(/\r?\n/)) {
      const m = line.match(/^FREEBUSY(;[^:]*)?:(.+)$/);
      if (!m || /FBTYPE=FREE\b/.test(m[1] || '')) continue;
      for (const period of m[2].split(',')) {
        const [a, b] = period.trim().split('/');
        const start = parseIcsUtc(a);
        const end = b.startsWith('P') ? start + parseDuration(b) : parseIcsUtc(b);
        if (Number.isFinite(start) && Number.isFinite(end)) out.push({ start, end });
      }
    }
  }
  return out;
}

function esc(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function param(s) {
  return `"${String(s).replace(/["\r\n]/g, '')}"`;
}

// Folds content lines at 75 octets (RFC 5545 §3.1) without splitting UTF-8 characters.
function fold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const parts = [];
  let cur = '';
  for (const ch of line) {
    if (enc.encode(cur + ch).length > (parts.length ? 74 : 75)) { parts.push(cur); cur = ''; }
    cur += ch;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}

function localStamp(ms, tz) {
  const p = partsInTz(ms, tz);
  const z = (n) => String(n).padStart(2, '0');
  return `${p.y}${z(p.m)}${z(p.d)}T${z(p.hh)}${z(p.mm)}${z(p.ss)}`;
}

// Creates the booking. In 'invite' mode Fastmail emails the guest an invite from the organizer
// address; in 'email' mode SCHEDULE-AGENT=CLIENT stops Fastmail sending one, so ours is the only mail.
export async function createEvent(env, e) {
  const uid = `${e.bookingId}@booking-calendar`;
  const attendeeParams = [`CN=${param(e.attendee.name)}`, 'ROLE=REQ-PARTICIPANT', 'PARTSTAT=NEEDS-ACTION'];
  if (e.notify === 'invite') attendeeParams.push('RSVP=TRUE');
  else attendeeParams.push('SCHEDULE-AGENT=CLIENT');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//booking-calendar//EN', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${icsTime(Date.now())}`,
    `DTSTART;TZID=${e.timezone}:${localStamp(e.start, e.timezone)}`,
    `DTEND;TZID=${e.timezone}:${localStamp(e.end, e.timezone)}`,
    `SUMMARY:${esc(e.title)}`,
    e.description ? `DESCRIPTION:${esc(e.description)}` : null,
    e.location ? `LOCATION:${esc(e.location)}` : null,
    e.url ? `URL:${e.url}` : null,
    `ORGANIZER;CN=${param(e.organizer.name || e.organizer.email)}:mailto:${e.organizer.email}`,
    `ATTENDEE;${attendeeParams.join(';')}:mailto:${e.attendee.email}`,
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean).map(fold);
  await dav(env, 'PUT', `${home(env)}${encodeURIComponent(e.calendarId)}/${e.bookingId}.ics`, lines.join('\r\n') + '\r\n', {
    'content-type': 'text/calendar; charset=utf-8',
    'if-none-match': '*',
  });
  return { id: uid };
}

let sessionCache = null;

async function jmap(env, calls) {
  const h = { authorization: `Bearer ${env.FASTMAIL_API_TOKEN}`, 'content-type': 'application/json' };
  if (!sessionCache) {
    const r = await fetch(JMAP_SESSION, { headers: h });
    if (r.status === 401) throw new Error('Fastmail rejected the API token');
    if (!r.ok) throw new Error(`Fastmail JMAP session ${r.status}`);
    const s = await r.json();
    sessionCache = { apiUrl: s.apiUrl, accountId: s.primaryAccounts['urn:ietf:params:jmap:submission'] || s.primaryAccounts['urn:ietf:params:jmap:mail'] };
  }
  const r = await fetch(sessionCache.apiUrl, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:submission'],
      methodCalls: calls.map(([name, args, id]) => [name, { accountId: sessionCache.accountId, ...args }, id]),
    }),
  });
  if (!r.ok) throw new Error(`Fastmail JMAP ${r.status}`);
  const out = (await r.json()).methodResponses;
  for (const [name, res] of out) if (name === 'error') throw new Error(`Fastmail JMAP error: ${res.type}`);
  return out;
}

export async function identities(env) {
  const [[, res]] = await jmap(env, [['Identity/get', {}, 'i']]);
  return res.list.map((i) => ({ id: i.id, email: i.email, name: i.name }));
}

// An identity matches exactly, or as a wildcard like *@example.com.
export function matchIdentity(list, email) {
  const lower = email.toLowerCase();
  return list.find((i) => i.email.toLowerCase() === lower)
    || list.find((i) => i.email.startsWith('*@') && lower.endsWith(i.email.slice(1).toLowerCase()));
}

export async function sendEmail(env, { from, fromName, to, subject, text }) {
  const [[, idr], [, mbr]] = await jmap(env, [['Identity/get', {}, 'i'], ['Mailbox/get', { properties: ['role'] }, 'm']]);
  const identity = matchIdentity(idr.list, from);
  if (!identity) throw new Error(`${from} is not a sending identity on this Fastmail account`);
  const drafts = mbr.list.find((x) => x.role === 'drafts')?.id;
  const sent = mbr.list.find((x) => x.role === 'sent')?.id;
  const res = await jmap(env, [
    ['Email/set', { create: { e: {
      mailboxIds: { [drafts]: true },
      keywords: { $draft: true, $seen: true },
      from: [{ name: fromName || identity.name || '', email: from }],
      to: [{ email: to }],
      subject,
      bodyValues: { b: { value: text } },
      textBody: [{ partId: 'b', type: 'text/plain' }],
    } } }, 'c'],
    ['EmailSubmission/set', {
      create: { s: { identityId: identity.id, emailId: '#e' } },
      onSuccessUpdateEmail: { '#s': { [`mailboxIds/${drafts}`]: null, [`mailboxIds/${sent}`]: true, 'keywords/$draft': null } },
    }, 's'],
  ]);
  const failed = res.find(([, r]) => r.notCreated);
  if (failed) throw new Error(`Fastmail did not send: ${JSON.stringify(Object.values(failed[1].notCreated)[0])}`);
}
