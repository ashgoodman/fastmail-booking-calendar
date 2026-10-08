import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, effective, publicType, DEFAULT_TYPE } from '../src/config.js';
import { candidateSlots, freeSlots } from '../src/slots.js';
import { zonedToUtc } from '../src/time.js';
import { matchIdentity } from '../src/providers/fastmail.js';

const iso = (ms) => new Date(ms).toISOString();

function setup(typeOverrides = {}, now = Date.parse('2026-10-06T14:00:00Z')) {
  const c = validateConfig({
    timezone: 'Asia/Manila',
    types: [{
      ...DEFAULT_TYPE,
      minNoticeHours: 12,
      maxDaysAhead: 2,
      weekly: { wed: [['09:00', '11:00']], thu: [['09:00', '10:00']] },
      ...typeOverrides,
    }],
  });
  return { c, t: effective(c, c.types[0]), now };
}

test('slots follow weekly hours in the owner timezone and respect minimum notice', () => {
  // 22:00 Tuesday in Manila; 12 hours' notice means nothing before 10:00 Wednesday.
  const { t, now } = setup();
  assert.deepEqual(candidateSlots(t, now).map((s) => iso(s.start)), [
    '2026-10-07T02:00:00.000Z', '2026-10-07T02:30:00.000Z',
    '2026-10-08T01:00:00.000Z', '2026-10-08T01:30:00.000Z',
  ]);
});

test('busy time plus the buffer after a meeting removes overlapping slots', () => {
  const { t, now } = setup({ bufferAfterMinutes: 15 });
  const busy = [{ start: Date.parse('2026-10-07T02:40:00Z'), end: Date.parse('2026-10-07T03:00:00Z') }];
  const free = freeSlots(t, candidateSlots(t, now), busy).map((s) => iso(s.start));
  assert.ok(!free.includes('2026-10-07T02:30:00.000Z'));
  assert.ok(!free.includes('2026-10-07T02:00:00.000Z'), '02:00–02:30 plus 15 min buffer reaches 02:45');
});

test('earlier bookings keep their buffers even when the new slot has none before it', () => {
  const { t, now } = setup({ bufferAfterMinutes: 30 });
  const booked = [{ start: Date.parse('2026-10-08T01:00:00Z'), end: Date.parse('2026-10-08T01:30:00Z') }];
  const free = freeSlots(t, candidateSlots(t, now), [], booked).map((s) => iso(s.start));
  assert.ok(!free.includes('2026-10-08T01:30:00.000Z'));
});

test('the daily cap closes a day once reached', () => {
  const { t, now } = setup({ maxPerDay: 2 });
  const free = freeSlots(t, candidateSlots(t, now), [], [], { '2026-10-08': 2 }).map((s) => s.date);
  assert.ok(!free.includes('2026-10-08'));
});

test('days off remove every slot on that date', () => {
  const c = validateConfig({ timezone: 'Asia/Manila', blackoutDates: ['2026-10-07'], types: [{ ...DEFAULT_TYPE, minNoticeHours: 0, maxDaysAhead: 2, weekly: { wed: [['09:00', '11:00']] } }] });
  assert.equal(candidateSlots(effective(c, c.types[0]), Date.parse('2026-10-06T14:00:00Z')).length, 0);
});

test('wall-clock conversion handles daylight saving changes', () => {
  assert.equal(iso(zonedToUtc(2026, 3, 8, 3, 0, 'America/New_York')), '2026-03-08T07:00:00.000Z');
  assert.equal(iso(zonedToUtc(2026, 7, 1, 9, 0, 'Europe/London')), '2026-07-01T08:00:00.000Z');
});

test('a pre-meeting-types config is upgraded into one meeting type', () => {
  const c = validateConfig({ title: 'Old style', durationMinutes: 45, timezone: 'UTC' });
  assert.equal(c.types.length, 1);
  assert.equal(c.types[0].title, 'Old style');
  assert.equal(c.types[0].durationMinutes, 45);
});

test('links must be unique and not clash with built-in pages', () => {
  assert.throws(() => validateConfig({ types: [{ ...DEFAULT_TYPE }, { ...DEFAULT_TYPE, id: 'b' }] }), /use the link/);
  assert.throws(() => validateConfig({ types: [{ ...DEFAULT_TYPE, slug: 'admin' }] }), /link must be/);
});

test('name and email are always asked and required', () => {
  const c = validateConfig({ types: [{ ...DEFAULT_TYPE, fields: [{ id: 'topic', label: 'Topic', type: 'text' }] }] });
  const f = c.types[0].fields;
  assert.deepEqual(f.map((x) => x.id), ['name', 'email', 'topic']);
  assert.ok(f[0].required && f[1].required);
});

test('guests never see the Jitsi link before booking', () => {
  const c = validateConfig({ types: [{ ...DEFAULT_TYPE, video: 'jitsi' }] });
  assert.match(publicType(c, c.types[0]).location, /link comes with the confirmation/);
});

test('sending addresses match exactly or by wildcard identity', () => {
  const ids = [{ email: 'me@example.com' }, { email: '*@example.org' }];
  assert.ok(matchIdentity(ids, 'ME@example.com'));
  assert.ok(matchIdentity(ids, 'hello@example.org'));
  assert.equal(matchIdentity(ids, 'someone@else.net'), undefined);
});
