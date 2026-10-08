import { DEFAULT_CONFIG, validateConfig, publicConfig, publicType, findType, isOpen, effective } from './config.js';
import { candidateSlots, freeSlots, horizon } from './slots.js';
import { isValidTimeZone } from './time.js';
import * as demo from './providers/demo.js';
import * as fastmail from './providers/fastmail.js';

const PROVIDERS = { demo, fastmail };

const json = (data, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function provider(env) {
  const p = PROVIDERS[env.PROVIDER];
  if (!p) throw new HttpError(500, `Unknown provider "${env.PROVIDER}"`);
  return p;
}

async function getConfig(env) {
  const row = await env.DB.prepare("SELECT v FROM settings WHERE k = 'config'").first();
  return validateConfig(row ? JSON.parse(row.v) : DEFAULT_CONFIG);
}

function getType(c, slug) {
  const t = findType(c, String(slug || ''));
  if (!t) throw new HttpError(404, 'That booking link does not exist.');
  return t;
}

// Bookings land on the target calendar, so it is always checked for busy time too.
function busyCalendarIds(t) {
  return [...new Set([...t.busyCalendars, t.targetCalendar].filter(Boolean))];
}

// Upcoming bookings made here, across every meeting type: their times keep buffers around them, and
// per-day counts of this type feed its daily cap. A booking on a calendar we just read whose event is
// gone (cancelled by the owner) is forgotten; one still being written gets a grace period.
async function getLedger(env, now, t, calendarIds, busy) {
  const { results } = await env.DB.prepare(
    'SELECT id, type_id, calendar_id, start_ms, end_ms, local_date, created_at FROM bookings WHERE end_ms > ?',
  ).bind(now).all();
  const live = [];
  const gone = [];
  for (const r of results) {
    const checkable = calendarIds.includes(r.calendar_id);
    const onCalendar = busy.some((b) => b.start <= r.start_ms && b.end >= r.end_ms);
    if (!checkable || onCalendar || now - r.created_at < 120000) live.push(r); else gone.push(r.id);
  }
  if (gone.length) {
    await env.DB.prepare('DELETE FROM bookings WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(gone)).run();
  }
  const counts = {};
  for (const r of live) if (r.type_id === t.id) counts[r.local_date] = (counts[r.local_date] || 0) + 1;
  return { counts, booked: live.map((r) => ({ start: r.start_ms, end: r.end_ms })) };
}

function timingSafeEqual(a, b) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

function requireAdmin(req, env) {
  const got = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!env.ADMIN_KEY || !got || !timingSafeEqual(got, env.ADMIN_KEY)) throw new HttpError(401, 'Wrong admin key');
}

async function rateLimit(req, limiter) {
  if (!limiter) return;
  const { success } = await limiter.limit({ key: req.headers.get('cf-connecting-ip') || 'unknown' });
  if (!success) throw new HttpError(429, 'Too many requests. Wait a minute and try again.');
}

async function availableSlots(env, c, t, now = Date.now()) {
  const e = effective(c, t);
  const { from, to } = horizon(e, now);
  const calendarIds = busyCalendarIds(t);
  const busy = await provider(env).busy(env, calendarIds, from, to);
  const ledger = await getLedger(env, now, t, calendarIds, busy);
  return freeSlots(e, candidateSlots(e, now), busy, ledger.booked, ledger.counts);
}

// An unguessable meet.jit.si room for one booking.
function jitsiLink(c, t) {
  const words = `${c.hostName} ${t.title}`.normalize('NFKD').replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1)).join('').slice(0, 40) || 'Meeting';
  const rand = [...crypto.getRandomValues(new Uint8Array(9))].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 14);
  return `https://meet.jit.si/${words}-${rand}`;
}

function fill(template, vars) {
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

function formatWhen(ms, tz, minutes) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' });
  return `${f.format(new Date(ms))} (${tz.replace(/_/g, ' ')}, ${minutes} min)`;
}

function cleanAnswers(t, input) {
  const answers = {};
  for (const f of t.fields) {
    let v = input?.[f.id];
    if (f.type === 'checkbox') v = v === true;
    else v = typeof v === 'string' ? v.trim() : '';
    if (f.required && (v === '' || v === false)) throw new HttpError(400, `${f.label} is required`);
    if (typeof v === 'string' && v.length > 2000) throw new HttpError(400, `${f.label} is too long`);
    if (f.type === 'email' && v && !/^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/.test(v)) throw new HttpError(400, `${f.label} is not a valid email address`);
    if (f.type === 'select' && v && !f.options.includes(v)) throw new HttpError(400, `${f.label} has an invalid choice`);
    answers[f.id] = v;
  }
  if (/[\r\n]/.test(answers.name) || /[\r\n]/.test(answers.email)) throw new HttpError(400, 'Invalid name or email');
  return answers;
}

async function book(req, env) {
  await rateLimit(req, env.BOOK_LIMITER);
  const body = await req.json().catch(() => null);
  if (!body || body.website) throw new HttpError(400, 'Invalid request');
  const c = await getConfig(env);
  const t = getType(c, body.type);
  if (!isOpen(c, t)) throw new HttpError(403, 'Bookings are closed');

  const start = Date.parse(body.start);
  const viewerTz = isValidTimeZone(body.timezone || '') ? body.timezone : c.timezone;
  const answers = cleanAnswers(t, body.answers);

  // The slot must be one the rules produce and still free right now.
  const slot = (await availableSlots(env, c, t)).find((s) => s.start === start);
  if (!slot) throw new HttpError(409, 'That time is no longer available. Please pick another.');

  // Claim the time atomically: a concurrent request for an overlapping slot inserts nothing.
  const bookingId = crypto.randomUUID();
  const claim = await env.DB.prepare(
    `INSERT INTO bookings (id, type_id, calendar_id, start_ms, end_ms, local_date, answers, notify, created_at)
     SELECT ?1, ?10, ?11, ?2, ?3, ?4, ?5, ?6, ?7
     WHERE NOT EXISTS (SELECT 1 FROM bookings WHERE start_ms < ?3 + ?8 AND end_ms > ?2 - ?9)`,
  ).bind(bookingId, slot.start, slot.end, slot.date, JSON.stringify(answers), t.notify, Date.now(),
    t.bufferAfterMinutes * 60000, t.bufferBeforeMinutes * 60000, t.id, t.targetCalendar).run();
  if (!claim.meta.changes) throw new HttpError(409, 'That time was just taken. Please pick another.');

  const p = provider(env);
  const acct = await p.account(env);
  const from = t.fromAddress || acct.email;
  const link = t.video === 'jitsi' ? jitsiLink(c, t) : '';
  const vars = { ...answers, title: t.title, host: c.hostName, when: formatWhen(start, viewerTz, t.durationMinutes), link };
  const details = t.fields
    .filter((f) => answers[f.id] !== '' && answers[f.id] !== false)
    .map((f) => `${f.label}: ${f.type === 'checkbox' ? 'Yes' : answers[f.id]}`)
    .join('\n');
  const joinLine = link ? `Join the video call: ${link}\n\n` : '';

  let event;
  try {
    event = await p.createEvent(env, {
      bookingId,
      calendarId: t.targetCalendar,
      start: slot.start,
      end: slot.end,
      timezone: c.timezone,
      title: fill(t.eventTitle, vars),
      description: `${joinLine}${t.description ? t.description + '\n\n' : ''}${details}`,
      location: link || t.location,
      url: link || undefined,
      organizer: { email: from, name: c.hostName },
      attendee: { email: answers.email, name: answers.name },
      notify: t.notify,
    });
  } catch (e) {
    await env.DB.prepare('DELETE FROM bookings WHERE id = ?').bind(bookingId).run();
    throw e;
  }

  let emailError = null;
  if (t.notify === 'email') {
    try {
      await p.sendEmail(env, {
        from,
        fromName: c.hostName,
        to: answers.email,
        subject: `Confirmed: ${t.title}`,
        // The join link always reaches the guest, even if the message doesn't mention {link}.
        text: fill(t.confirmationMessage, vars) + (link && !t.confirmationMessage.includes('{link}') ? `\n\nJoin the video call: ${link}` : ''),
      });
    } catch (e) {
      emailError = e.message;
      console.error('confirmation email failed', e);
    }
  }

  await env.DB.prepare('UPDATE bookings SET event_id = ?, email_error = ?, video_link = ? WHERE id = ?').bind(event.id, emailError, link || null, bookingId).run();

  return json({
    ok: true,
    start: new Date(slot.start).toISOString(),
    end: new Date(slot.end).toISOString(),
    notify: t.notify,
    emailSent: t.notify === 'email' && !emailError,
    videoLink: link || null,
  });
}

async function admin(req, env, path) {
  requireAdmin(req, env);
  const p = provider(env);

  if (path === '/api/admin/state' && req.method === 'GET') {
    const [account, calendars, identities, config] = await Promise.all([
      p.account(env), p.listCalendars(env), p.identities(env), getConfig(env),
    ]);
    return json({ provider: env.PROVIDER, account, calendars, identities, config });
  }
  if (path === '/api/admin/config' && req.method === 'PUT') {
    let c;
    try { c = validateConfig(await req.json()); } catch (e) { throw new HttpError(400, e.message); }
    const [identities, calendars] = await Promise.all([p.identities(env), p.listCalendars(env)]);
    const writable = calendars.filter((x) => x.writable).map((x) => x.id);
    for (const t of c.types) {
      if (t.fromAddress && p.matchIdentity && !p.matchIdentity(identities, t.fromAddress)) {
        throw new HttpError(400, `"${t.title}": ${t.fromAddress} is not one of your sending addresses`);
      }
      if (t.targetCalendar && !writable.includes(t.targetCalendar)) {
        throw new HttpError(400, `"${t.title}": bookings must go on a calendar you can write to`);
      }
    }
    await env.DB.prepare("INSERT INTO settings (k, v) VALUES ('config', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").bind(JSON.stringify(c)).run();
    return json({ ok: true, config: c });
  }
  if (path === '/api/admin/bookings' && req.method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM bookings WHERE end_ms > ? ORDER BY start_ms LIMIT 200').bind(Date.now()).all();
    const bookings = results.map((r) => ({
      bookingId: r.id, typeId: r.type_id, start: r.start_ms, end: r.end_ms, answers: JSON.parse(r.answers),
      eventId: r.event_id, notify: r.notify, emailError: r.email_error, videoLink: r.video_link,
    }));
    return json({ bookings, outbox: p.outbox ? await p.outbox(env) : null });
  }
  throw new HttpError(404, 'Not found');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (path === '/api/config' && req.method === 'GET') {
        return json(publicConfig(await getConfig(env)));
      }
      if (path.startsWith('/api/types/') && req.method === 'GET') {
        const c = await getConfig(env);
        return json(publicType(c, getType(c, decodeURIComponent(path.slice('/api/types/'.length)))));
      }
      if (path === '/api/slots' && req.method === 'GET') {
        await rateLimit(req, env.SLOTS_LIMITER);
        const c = await getConfig(env);
        const t = getType(c, url.searchParams.get('type'));
        if (!isOpen(c, t)) return json({ bookingEnabled: false, slots: [] });
        const slots = await availableSlots(env, c, t);
        return json({ bookingEnabled: true, durationMinutes: t.durationMinutes, slots: slots.map((s) => new Date(s.start).toISOString()) });
      }
      if (path === '/api/book' && req.method === 'POST') return await book(req, env);
      if (path.startsWith('/api/admin/')) return await admin(req, env, path);
      if (path.startsWith('/api/')) return json({ error: 'Not found' }, 404);
      // Any other page path is a meeting-type link: serve the booking page, which reads the path.
      if (req.method === 'GET' && /^\/[a-z0-9-]+$/.test(path)) {
        return env.ASSETS.fetch(new Request(new URL('/', url), req));
      }
      return new Response('Not found', { status: 404 });
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      // Only the owner sees the underlying calendar error.
      const detail = path.startsWith('/api/admin/') ? `: ${e.message}` : '. Please try again.';
      return json({ error: `Something went wrong talking to the calendar${detail}` }, 502);
    }
  },
};
