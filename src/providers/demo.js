// Stand-in calendar for trying the flow without a real account. Busy time is made up but stable
// per day; bookings and outgoing mail are kept in the database instead of reaching a calendar or inbox.

const CALENDARS = [
  { id: 'work', name: 'Work', writable: true },
  { id: 'personal', name: 'Personal', writable: true },
  { id: 'holidays', name: 'Holidays', writable: false },
];

const DAY = 86400000;

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export async function account() {
  return { email: 'you@example.com', demo: true };
}

export async function identities() {
  return [
    { email: 'you@example.com', name: 'You' },
    { email: 'bookings@example.com', name: 'Bookings' },
  ];
}

export async function listCalendars() {
  return CALENDARS;
}

export async function busy(env, calendarIds, from, to) {
  const out = [];
  for (let day = Math.floor(from / DAY) * DAY; day < to; day += DAY) {
    for (const id of calendarIds) {
      const h = hash(`${id}:${day}`);
      if (id === 'holidays') {
        if (h % 13 === 0) out.push({ start: day, end: day + DAY });
        continue;
      }
      // 1–2 made-up meetings a day, 30–90 minutes, anywhere in the UTC day.
      for (let i = 0; i < 1 + (h % 2); i++) {
        const hh = hash(`${id}:${day}:${i}`);
        const start = day + (hh % 48) * 1800000;
        out.push({ start, end: start + (1 + (hh % 3)) * 1800000 });
      }
    }
  }
  const { results } = await env.DB.prepare(
    `SELECT start_ms, end_ms FROM demo_events WHERE start_ms < ? AND end_ms > ? AND calendar_id IN (SELECT value FROM json_each(?))`,
  ).bind(to, from, JSON.stringify(calendarIds)).all();
  for (const r of results) out.push({ start: r.start_ms, end: r.end_ms });
  return out;
}

async function record(env, msg) {
  await env.DB.prepare('INSERT INTO demo_outbox (created_at, data) VALUES (?, ?)').bind(Date.now(), JSON.stringify(msg)).run();
}

export async function createEvent(env, e) {
  const id = `demo-${e.bookingId}`;
  await env.DB.prepare('INSERT INTO demo_events (id, calendar_id, start_ms, end_ms, data) VALUES (?, ?, ?, ?, ?)')
    .bind(id, e.calendarId, e.start, e.end, JSON.stringify(e)).run();
  if (e.notify === 'invite') {
    await record(env, { kind: 'invite', from: e.organizer.email, to: e.attendee.email, subject: `Invitation: ${e.title}` });
  }
  return { id };
}

export async function deleteEvent(env, id) {
  await env.DB.prepare('DELETE FROM demo_events WHERE id = ?').bind(id).run();
}

export async function sendEmail(env, msg) {
  await record(env, { kind: 'email', ...msg });
}

export async function outbox(env) {
  const { results } = await env.DB.prepare('SELECT data FROM demo_outbox ORDER BY id DESC LIMIT 20').all();
  return results.map((r) => JSON.parse(r.data));
}
