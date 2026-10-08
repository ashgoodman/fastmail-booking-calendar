import { DAYS } from './config.js';
import { zonedToUtc, localDatePlus, ymd, hm, partsInTz } from './time.js';

// Every candidate slot the rules allow between now and the booking horizon, before busy time.
export function candidateSlots(c, now) {
  const earliest = now + c.minNoticeHours * 3600000;
  const dur = c.durationMinutes * 60000;
  const out = [];
  for (let i = 0; i <= c.maxDaysAhead; i++) {
    const { y, m, d, dow } = localDatePlus(now, c.timezone, i);
    const date = ymd(y, m, d);
    if (c.blackoutDates.includes(date)) continue;
    for (const [s, e] of c.weekly[DAYS[dow]] || []) {
      const end = hm(e);
      for (let t = hm(s); t + c.durationMinutes <= end; t += c.slotStepMinutes) {
        const start = zonedToUtc(y, m, d, Math.floor(t / 60), t % 60, c.timezone);
        if (start >= earliest) out.push({ start, end: start + dur, date });
      }
    }
  }
  return out;
}

export function horizon(c, now) {
  const last = localDatePlus(now, c.timezone, c.maxDaysAhead + 1);
  return { from: now, to: zonedToUtc(last.y, last.m, last.d, 0, 0, c.timezone) };
}

export function localDate(ms, tz) {
  const p = partsInTz(ms, tz);
  return ymd(p.y, p.m, p.d);
}

// Removes slots that collide with busy time or exceed the daily cap. A slot keeps its own buffers
// clear of any busy time, and stays out of the buffers around earlier bookings made here.
export function freeSlots(c, candidates, busy, booked = [], bookedPerDay = {}) {
  const before = c.bufferBeforeMinutes * 60000;
  const after = c.bufferAfterMinutes * 60000;
  const overlaps = (list, a, b) => list.some((x) => x.start < b && x.end > a);
  const guarded = booked.map((x) => ({ start: x.start - before, end: x.end + after }));
  return candidates.filter((s) => {
    if (c.maxPerDay && (bookedPerDay[s.date] || 0) >= c.maxPerDay) return false;
    return !overlaps(busy, s.start - before, s.end + after) && !overlaps(guarded, s.start, s.end);
  });
}
