// Runs the real Worker locally (wrangler dev, stand-in calendar, throwaway database) and drives it over HTTP.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

const ROOT = new URL('../..', import.meta.url).pathname;
const WRANGLER = join(ROOT, 'node_modules', '.bin', 'wrangler');
const CONFIG = join(ROOT, 'wrangler.test.toml');
const KEY = 'integration-test-key';

let base;
let server;
let state;

const freePort = () => new Promise((resolve) => {
  const s = createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

before(async () => {
  // The example config with roomy rate limits, so the tests aren't throttled.
  writeFileSync(CONFIG, readFileSync(join(ROOT, 'wrangler.example.toml'), 'utf8')
    .replace('limit = 5, period = 60', 'limit = 1000, period = 60')
    .replace('limit = 60, period = 60', 'limit = 1000, period = 60'));
  state = mkdtempSync(join(tmpdir(), 'fbc-test-'));
  execFileSync(WRANGLER, ['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', state, '-c', CONFIG], { cwd: ROOT, stdio: 'ignore' });
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(WRANGLER, ['dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', state, '-c', CONFIG,
    '--var', 'PROVIDER:demo', '--var', `ADMIN_KEY:${KEY}`], { cwd: ROOT, stdio: 'ignore', detached: true });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${base}/api/config`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('wrangler dev did not start');
});

after(() => {
  if (server) try { process.kill(-server.pid); } catch {}
  rmSync(state, { recursive: true, force: true });
  rmSync(CONFIG, { force: true });
});

async function call(path, { method = 'GET', body, key } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  const r = await fetch(base + path, { method, headers, body: body && JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}

const allDay = Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [d, [['00:00', '24:00']]]));
const config = (overrides = {}) => ({
  bookingEnabled: true,
  hostName: 'Test Host',
  timezone: 'UTC',
  blackoutDates: [],
  types: [
    { id: 'quick', slug: 'quick', enabled: true, title: 'Quick chat', durationMinutes: 30, slotStepMinutes: 30, minNoticeHours: 0, maxDaysAhead: 14,
      weekly: allDay, busyCalendars: [], targetCalendar: 'work', video: 'jitsi', notify: 'invite', eventTitle: '{name} — {title}' },
    { id: 'long', slug: 'long-session', enabled: true, title: 'Long session', durationMinutes: 60, slotStepMinutes: 30, minNoticeHours: 0, maxDaysAhead: 14,
      weekly: allDay, busyCalendars: [], targetCalendar: 'personal', video: 'none', location: 'Phone', notify: 'email',
      fields: [{ id: 'topic', label: 'Topic', type: 'text', required: true }] },
  ],
  ...overrides,
});

const guest = (name, extra = {}) => ({ name, email: `${name.toLowerCase()}@example.com`, ...extra });
const slots = async (type) => (await call(`/api/slots?type=${type}`)).json.slots;

test('a new install is closed and the settings need the admin key', async () => {
  const pub = await call('/api/config');
  assert.equal(pub.json.bookingEnabled, false);
  assert.deepEqual(pub.json.types, []);
  assert.equal((await call('/api/admin/state')).status, 401);
  assert.equal((await call('/api/admin/state', { key: 'wrong' })).status, 401);
  const state = await call('/api/admin/state', { key: KEY });
  assert.equal(state.status, 200);
  assert.equal(state.json.provider, 'demo');
});

test('pages are served for the landing page, settings and meeting-type links', async () => {
  for (const path of ['/', '/admin/', '/quick', '/style.css']) assert.equal((await call(path)).status, 200, path);
  assert.equal((await call('/nope/deeper')).status, 404);
});

test('saving settings validates them', async () => {
  const bad = config();
  bad.types[1].slug = 'admin';
  assert.equal((await call('/api/admin/config', { method: 'PUT', key: KEY, body: bad })).status, 400);
  const saved = await call('/api/admin/config', { method: 'PUT', key: KEY, body: config() });
  assert.equal(saved.status, 200, saved.text);
  const pub = await call('/api/config');
  assert.deepEqual(pub.json.types.map((t) => t.slug), ['quick', 'long-session']);
  assert.match(pub.json.types[0].location, /link comes with the confirmation/);
  assert.deepEqual((await call('/api/types/long-session')).json.fields.map((f) => f.id), ['name', 'email', 'topic']);
  assert.equal((await call('/api/types/unknown')).status, 404);
});

test('booking a slot creates the event, a Jitsi link and the invite', async () => {
  const [first] = await slots('quick');
  const res = await call('/api/book', { method: 'POST', body: { type: 'quick', start: first, timezone: 'Europe/London', answers: guest('Ann') } });
  assert.equal(res.status, 200, res.text);
  assert.match(res.json.videoLink, /^https:\/\/meet\.jit\.si\/TestHostQuickChat-[a-z0-9]+$/);
  assert.ok(!(await slots('quick')).includes(first), 'booked slot is no longer offered');
  const again = await call('/api/book', { method: 'POST', body: { type: 'quick', start: first, answers: guest('Ben') } });
  assert.equal(again.status, 409);
  const admin = await call('/api/admin/bookings', { key: KEY });
  assert.equal(admin.json.bookings.length, 1);
  assert.equal(admin.json.bookings[0].videoLink, res.json.videoLink);
  assert.ok(admin.json.outbox.some((m) => m.kind === 'invite' && m.to === 'ann@example.com'));
});

test('two people booking the same slot at once: exactly one gets it', async () => {
  const [slot] = await slots('quick');
  const results = await Promise.all(['Cat', 'Dan', 'Eve'].map((n) =>
    call('/api/book', { method: 'POST', body: { type: 'quick', start: slot, answers: guest(n) } })));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409]);
});

test('bookings of one meeting type block overlapping times of another', async () => {
  const booked = (await call('/api/admin/bookings', { key: KEY })).json.bookings;
  const longSlots = (await slots('long-session')).map(Date.parse);
  for (const b of booked) {
    assert.ok(!longSlots.some((s) => s < b.end && s + 3600000 > b.start), 'a 60-minute slot overlaps an existing booking');
  }
});

test('required questions, made-up times and closed types are refused', async () => {
  const [slot] = await slots('long-session');
  const missing = await call('/api/book', { method: 'POST', body: { type: 'long-session', start: slot, answers: guest('Fay') } });
  assert.equal(missing.status, 400);
  assert.match(missing.json.error, /Topic is required/);
  const offGrid = new Date(Date.parse(slot) + 7 * 60000).toISOString();
  assert.equal((await call('/api/book', { method: 'POST', body: { type: 'long-session', start: offGrid, answers: guest('Fay', { topic: 'x' }) } })).status, 409);

  const ok = await call('/api/book', { method: 'POST', body: { type: 'long-session', start: slot, answers: guest('Fay', { topic: 'Pricing' }) } });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.emailSent, true);
  const email = (await call('/api/admin/bookings', { key: KEY })).json.outbox.find((m) => m.kind === 'email');
  assert.equal(email.to, 'fay@example.com');

  const closed = config();
  closed.types[0].enabled = false;
  await call('/api/admin/config', { method: 'PUT', key: KEY, body: closed });
  const [quickSlot] = (await call('/api/slots?type=quick')).json.slots;
  assert.equal(quickSlot, undefined);
  assert.equal((await call('/api/book', { method: 'POST', body: { type: 'quick', start: slot, answers: guest('Gus') } })).status, 403);
});
