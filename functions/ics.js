// Builds an iCalendar (.ics) feed of a household's scheduled tasks, for subscribing in Google Calendar or Apple Calendar.
// Pure functions with no Firebase in them, so the tests can run them directly.
'use strict';

// Text values: escape backslash, semicolon, comma and newlines (RFC 5545 §3.3.11).
const esc = s => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

// Lines longer than 75 octets are folded onto continuation lines that start with a space.
function fold(line) {
  const out = []; let cur = '', bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

// Local wall-clock parts of `ms` in time zone `tz`.
function local(ms, tz) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).reduce((o, x) => { o[x.type] = x.value; return o; }, {});
  return { date: `${p.year}${p.month}${p.day}`, time: `${p.hour}${p.minute}${p.second}`, midnight: p.hour === '00' && p.minute === '00' };
}
const utcStamp = ms => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const nextDay = yyyymmdd => { const d = new Date(Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8) + 1)); return d.toISOString().slice(0, 10).replace(/-/g, ''); };

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
function rrule(repeat) {
  if (!repeat || repeat === 'none') return null;
  if (repeat === 'daily') return 'FREQ=DAILY';
  if (repeat === 'weekly') return 'FREQ=WEEKLY';
  if (repeat === 'monthly') return 'FREQ=MONTHLY';
  if (typeof repeat === 'object' && ['day', 'week', 'month'].includes(repeat.unit)) {
    const every = Math.max(1, Math.min(365, parseInt(repeat.every, 10) || 1));
    let r = `FREQ=${{ day: 'DAILY', week: 'WEEKLY', month: 'MONTHLY' }[repeat.unit]}${every > 1 ? ';INTERVAL=' + every : ''}`;
    if (repeat.unit === 'week' && Array.isArray(repeat.weekdays) && repeat.weekdays.length) r += ';BYDAY=' + repeat.weekdays.map(d => DAYS[d]).filter(Boolean).join(',');
    return r;
  }
  return null;
}

// tasks: [{ id, title, notes, dueAt (ms), repeat, priority, category, who }] where `who` is a display name or ''.
// opts: { name, tz, now, siteUrl, groupId }
function buildIcs(tasks, opts) {
  const tz = opts.tz || 'UTC';
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Shared Plate//Household reminders//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:' + esc(opts.name || 'Shared Plate'), 'X-WR-TIMEZONE:' + tz,
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'];
  for (const t of tasks) {
    if (t.dueAt == null) continue;
    const at = local(t.dueAt, tz);
    const title = `${t.priority ? '[' + t.priority + '] ' : ''}${t.title}${t.who ? ' (' + t.who + ')' : ''}`;
    L.push('BEGIN:VEVENT', 'UID:' + esc(`${t.id}@shared-plate`), 'DTSTAMP:' + utcStamp(opts.now || Date.now()));
    if (at.midnight) L.push('DTSTART;VALUE=DATE:' + at.date, 'DTEND;VALUE=DATE:' + nextDay(at.date));
    else L.push(`DTSTART;TZID=${tz}:${at.date}T${at.time}`, 'DURATION:PT30M');
    const rr = rrule(t.repeat);
    if (rr) L.push('RRULE:' + rr);
    L.push('SUMMARY:' + esc(title));
    const desc = [t.category ? 'Category: ' + t.category : '', t.notes || ''].filter(Boolean).join('\n');
    if (desc) L.push('DESCRIPTION:' + esc(desc));
    if (opts.siteUrl) L.push('URL:' + `${opts.siteUrl.replace(/\/$/, '')}/#task=${encodeURIComponent((opts.groupId || '') + '/' + t.id)}`);
    L.push('TRANSP:TRANSPARENT', 'END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.map(fold).join('\r\n') + '\r\n';
}

module.exports = { buildIcs, rrule, esc, fold };
