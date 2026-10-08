// Fastmail provider tests against canned server responses shaped like Fastmail's real ones.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fastmail from '../src/providers/fastmail.js';

const env = { FASTMAIL_USER: 'owner@example.com', FASTMAIL_APP_PASSWORD: 'app-pass', FASTMAIL_API_TOKEN: 'api-token' };
const HOME = '/dav/calendars/user/owner@example.com/';

let calls;
let replies;
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  replies = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body });
    const next = replies.shift();
    if (!next) throw new Error(`unexpected fetch ${init.method} ${url}`);
    return new Response(typeof next.body === 'string' ? next.body : JSON.stringify(next.body), { status: next.status || 200 });
  };
});

afterEach(() => { globalThis.fetch = realFetch; });

const calendar = (id, name, privileges, comps = 'VEVENT') => `
  <d:response>
    <d:href>${HOME}${id}/</d:href>
    <d:propstat><d:prop>
      <d:displayname><![CDATA[${name}]]></d:displayname>
      <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
      <c:supported-calendar-component-set><c:comp name="${comps}"/></c:supported-calendar-component-set>
      <d:current-user-privilege-set>${privileges.map((p) => `<d:privilege><d:${p}/></d:privilege>`).join('')}</d:current-user-privilege-set>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>`;

test('listCalendars reads names, ids and write access, and skips non-calendars', async () => {
  replies.push({ status: 207, body: `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
    <d:response><d:href>${HOME}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
    ${calendar('B2C1', 'Work &amp; Clients', ['read', 'write'])}
    ${calendar('a9f0', 'Public Holidays', ['read'])}
    ${calendar('t0d0', 'Tasks', ['read', 'write'], 'VTODO')}
    <d:response><d:href>${HOME}Inbox/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:schedule-inbox/></d:resourcetype></d:prop></d:propstat></d:response>
  </d:multistatus>` });
  const cals = await fastmail.listCalendars(env);
  assert.deepEqual(cals, [
    { id: 'a9f0', name: 'Public Holidays', writable: false },
    { id: 'B2C1', name: 'Work & Clients', writable: true },
  ]);
  assert.equal(calls[0].method, 'PROPFIND');
  assert.equal(calls[0].url, `https://caldav.fastmail.com${HOME}`);
  assert.equal(calls[0].headers.authorization, 'Basic ' + btoa('owner@example.com:app-pass'));
  assert.equal(calls[0].headers.depth, '1');
});

test('busy parses free-busy replies: folded lines, durations, several periods, and skips FREE', async () => {
  replies.push({ body: [
    'BEGIN:VCALENDAR', 'BEGIN:VFREEBUSY',
    'FREEBUSY:20261009T020000Z/20261009T023000Z,20261009T060000Z/PT1H',
    'FREEBUSY;FBTYPE=BUSY-TENTATIVE:20261010T010000Z/20261010T013000Z',
    'FREEBUSY;FBTYPE=FREE:20261011T010000Z/20261011T020000Z',
    'FREEBUSY:20261012T0100',
    ' 00Z/20261012T013000Z',
    'END:VFREEBUSY', 'END:VCALENDAR', ''].join('\r\n') });
  replies.push({ body: 'BEGIN:VCALENDAR\r\nBEGIN:VFREEBUSY\r\nEND:VFREEBUSY\r\nEND:VCALENDAR\r\n' });
  const from = Date.parse('2026-10-08T00:00:00Z');
  const to = Date.parse('2026-10-20T00:00:00Z');
  const busy = await fastmail.busy(env, ['cal-1', 'cal 2'], from, to);
  const iso = busy.map((b) => [new Date(b.start).toISOString(), new Date(b.end).toISOString()]);
  assert.deepEqual(iso, [
    ['2026-10-09T02:00:00.000Z', '2026-10-09T02:30:00.000Z'],
    ['2026-10-09T06:00:00.000Z', '2026-10-09T07:00:00.000Z'],
    ['2026-10-10T01:00:00.000Z', '2026-10-10T01:30:00.000Z'],
    ['2026-10-12T01:00:00.000Z', '2026-10-12T01:30:00.000Z'],
  ]);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.method === 'REPORT'));
  assert.equal(calls[1].url, `https://caldav.fastmail.com${HOME}cal%202/`);
  assert.match(calls[0].body, /<c:time-range start="20261008T000000Z" end="20261020T000000Z"\/>/);
});

test('a rejected app password gives a clear error', async () => {
  replies.push({ status: 401, body: '' });
  await assert.rejects(fastmail.listCalendars(env), /rejected the app password/);
});

function unfold(ics) {
  return ics.replace(/\r\n /g, '');
}

const booking = {
  bookingId: 'b-1',
  calendarId: 'B2C1',
  start: Date.parse('2026-10-09T01:00:00Z'),
  end: Date.parse('2026-10-09T01:30:00Z'),
  timezone: 'Asia/Manila',
  title: 'Jane; Doe, — Intro call',
  description: 'Line one\nLine two',
  location: 'https://meet.jit.si/Example-abc',
  url: 'https://meet.jit.si/Example-abc',
  organizer: { email: 'alias@example.com', name: 'Alex "The Host"' },
  attendee: { email: 'jane@example.net', name: 'Jane Doe' },
};

test('createEvent writes local times, escapes text and lets Fastmail send the invite', async () => {
  replies.push({ status: 201, body: '' });
  const { id } = await fastmail.createEvent(env, { ...booking, notify: 'invite' });
  assert.equal(id, 'b-1@booking-calendar');
  const put = calls[0];
  assert.equal(put.method, 'PUT');
  assert.equal(put.url, `https://caldav.fastmail.com${HOME}B2C1/b-1.ics`);
  assert.equal(put.headers['if-none-match'], '*');
  assert.match(put.headers['content-type'], /^text\/calendar/);
  for (const line of put.body.split('\r\n')) assert.ok(new TextEncoder().encode(line).length <= 75, `line too long: ${line}`);
  const ics = unfold(put.body);
  assert.match(ics, /DTSTART;TZID=Asia\/Manila:20261009T090000/);
  assert.match(ics, /DTEND;TZID=Asia\/Manila:20261009T093000/);
  assert.match(ics, /SUMMARY:Jane\\; Doe\\, — Intro call/);
  assert.match(ics, /DESCRIPTION:Line one\\nLine two/);
  assert.match(ics, /URL:https:\/\/meet\.jit\.si\/Example-abc/);
  assert.match(ics, /ORGANIZER;CN="Alex The Host":mailto:alias@example\.com/);
  assert.match(ics, /ATTENDEE;CN="Jane Doe";ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:jane@example\.net/);
  assert.doesNotMatch(ics, /SCHEDULE-AGENT/);
});

test('createEvent in email mode stops Fastmail sending its own invite', async () => {
  replies.push({ status: 201, body: '' });
  await fastmail.createEvent(env, { ...booking, notify: 'email' });
  const ics = unfold(calls[0].body);
  assert.match(ics, /ATTENDEE;[^\r\n]*SCHEDULE-AGENT=CLIENT[^\r\n]*:mailto:jane@example\.net/);
  assert.doesNotMatch(ics, /RSVP=TRUE/);
});

const session = { apiUrl: 'https://api.fastmail.com/jmap/api/', primaryAccounts: { 'urn:ietf:params:jmap:submission': 'acc1', 'urn:ietf:params:jmap:mail': 'acc1' } };
const identityReply = {
  methodResponses: [
    ['Identity/get', { list: [{ id: 'id-main', email: 'owner@example.com', name: 'Owner' }, { id: 'id-wild', email: '*@example.org', name: 'Brand' }] }, 'i'],
    ['Mailbox/get', { list: [{ id: 'mb-d', role: 'drafts' }, { id: 'mb-s', role: 'sent' }, { id: 'mb-i', role: 'inbox' }] }, 'm'],
  ],
};

test('sendEmail sends from a wildcard identity and files the message in Sent', async () => {
  replies.push({ body: session }, { body: identityReply }, {
    body: { methodResponses: [['Email/set', { created: { e: { id: 'e1' } } }, 'c'], ['EmailSubmission/set', { created: { s: { id: 's1' } } }, 's']] },
  });
  await fastmail.sendEmail(env, { from: 'hello@example.org', fromName: 'Alex', to: 'jane@example.net', subject: 'Confirmed', text: 'See you' });
  const send = JSON.parse(calls.at(-1).body);
  assert.equal(calls.at(-1).headers.authorization, 'Bearer api-token');
  const [, emailArgs] = send.methodCalls[0];
  const [, subArgs] = send.methodCalls[1];
  assert.deepEqual(emailArgs.create.e.from, [{ name: 'Alex', email: 'hello@example.org' }]);
  assert.deepEqual(emailArgs.create.e.mailboxIds, { 'mb-d': true });
  assert.equal(subArgs.create.s.identityId, 'id-wild');
  assert.deepEqual(subArgs.onSuccessUpdateEmail['#s'], { 'mailboxIds/mb-d': null, 'mailboxIds/mb-s': true, 'keywords/$draft': null });
});

test('sendEmail refuses an address that is not a sending identity', async () => {
  replies.push({ body: identityReply });
  await assert.rejects(
    fastmail.sendEmail(env, { from: 'stranger@other.net', to: 'jane@example.net', subject: 's', text: 't' }),
    /not a sending identity/,
  );
});

test('a refused submission is reported, not swallowed', async () => {
  replies.push({ body: identityReply }, {
    body: { methodResponses: [['Email/set', { created: { e: { id: 'e1' } } }, 'c'], ['EmailSubmission/set', { notCreated: { s: { type: 'forbiddenFrom' } } }, 's']] },
  });
  await assert.rejects(
    fastmail.sendEmail(env, { from: 'owner@example.com', to: 'jane@example.net', subject: 's', text: 't' }),
    /forbiddenFrom/,
  );
});
