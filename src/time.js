// Wall-clock <-> UTC conversion for an IANA timezone, using only Intl.

const dtfCache = new Map();
function dtf(tz) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz) {
  try { dtf(tz); return true; } catch { return false; }
}

// Wall-clock parts of an instant in tz.
export function partsInTz(ms, tz) {
  const p = {};
  for (const { type, value } of dtf(tz).formatToParts(new Date(ms))) p[type] = value;
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute, ss: +p.second };
}

function offsetMinutes(ms, tz) {
  const p = partsInTz(ms, tz);
  return (Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Math.floor(ms / 1000) * 1000) / 60000;
}

// UTC ms for a wall-clock time in tz.
export function zonedToUtc(y, m, d, hh, mm, tz) {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const off1 = offsetMinutes(guess, tz);
  let t = guess - off1 * 60000;
  const off2 = offsetMinutes(t, tz);
  if (off2 !== off1) t = guess - off2 * 60000;
  return t;
}

export function ymd(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Local calendar date in tz, plus n days.
export function localDatePlus(ms, tz, n) {
  const p = partsInTz(ms, tz);
  const base = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
  return { y: base.getUTCFullYear(), m: base.getUTCMonth() + 1, d: base.getUTCDate(), dow: base.getUTCDay() };
}

export function hm(str) {
  const [h, m] = str.split(':').map(Number);
  return h * 60 + m;
}
