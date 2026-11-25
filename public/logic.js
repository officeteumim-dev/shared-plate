// Shared Plate rules of the house: which lane a task is in, when it repeats, quiet hours, and who gets a reminder.
// Plain functions with no Firebase in them, shared by the app (window.SP_LOGIC), the Cloud Functions
// (copied into functions/ on deploy) and the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SP_LOGIC = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const DAY = 86400e3;

  // Firestore Timestamp, Date, number of ms, or null → ms (or null).
  function toMs(v) {
    if (v == null) return null;
    if (typeof v === 'number') return v;
    if (v instanceof Date) return v.getTime();
    if (typeof v.toMillis === 'function') return v.toMillis();
    if (typeof v.seconds === 'number') return v.seconds * 1000 + Math.floor((v.nanoseconds || 0) / 1e6);
    if (typeof v._seconds === 'number') return v._seconds * 1000;
    return null;
  }

  // A snoozed task whose "show again" date has passed counts as open (the server flips it shortly after).
  function effectiveStatus(t, now) {
    if (t.status === 'snoozed' && toMs(t.showAgainOn) != null && toMs(t.showAgainOn) <= now) return 'open';
    return t.status || 'open';
  }

  // Who is responsible right now: a uid, or null for an unclaimed shared task.
  function responsible(t) {
    return t.owner === 'shared' ? (t.claimedBy || null) : t.owner;
  }

  function laneOf(t, me) {
    const who = responsible(t);
    if (!who) return 'shared';
    return who === me ? 'mine' : 'theirs';
  }

  function startOfDay(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function endOfDay(ms) { return addDays(startOfDay(ms), 1) - 1; }

  function byDue(a, b) {
    const da = toMs(a.dueAt), dbb = toMs(b.dueAt);
    if (da != null && dbb != null && da !== dbb) return da - dbb;
    if (da != null && dbb == null) return -1;
    if (da == null && dbb != null) return 1;
    return (toMs(a.createdAt) || 0) - (toMs(b.createdAt) || 0);
  }

  // Splits the household's tasks into what the dashboard shows.
  function lanes(tasks, me, now) {
    const out = { today: [], mine: [], theirs: [], shared: [], snoozed: [], done: [] };
    const eod = endOfDay(now);
    for (const t of tasks) {
      const st = effectiveStatus(t, now);
      if (st === 'done') { out.done.push(t); continue; }
      if (st === 'snoozed') { out.snoozed.push(t); continue; }
      out[laneOf(t, me)].push(t);
      const due = toMs(t.dueAt);
      if (due != null && due <= eod) out.today.push(t);
    }
    out.today.sort(byDue);
  for (const k of ['mine', 'theirs', 'shared']) out[k] = arrange(out[k]);
    out.snoozed.sort((a, b) => (toMs(a.showAgainOn) || 0) - (toMs(b.showAgainOn) || 0));
    out.done.sort((a, b) => (toMs(b.completedAt) || 0) - (toMs(a.completedAt) || 0));
    return out;
  }

  // ---------- Manual order and categories ----------
  // Tasks someone has dragged into place have an `order` and come first, in that order; the rest follow by due date.
  function arrange(list) {
    return list.slice().sort((a, b) => {
      const oa = typeof a.order === 'number', ob = typeof b.order === 'number';
      if (oa && ob && a.order !== b.order) return a.order - b.order;
      if (oa !== ob) return oa ? -1 : 1;
      return byDue(a, b);
    });
  }
  const catOf = t => String(t.category || '').trim();
  // Groups an arranged list by category: named categories A–Z, then tasks without one (name '').
  function byCategory(list) {
    const map = new Map();
    for (const t of list) { const c = catOf(t); if (!map.has(c)) map.set(c, []); map.get(c).push(t); }
    const names = [...map.keys()].filter(Boolean).sort((a, b) => a.localeCompare(b));
    if (map.has('')) names.push('');
    return names.map(name => ({ name, items: map.get(name) }));
  }
  function categories(tasks) {
    const seen = new Map();
    for (const t of tasks) { const c = catOf(t); if (c && !seen.has(c.toLowerCase())) seen.set(c.toLowerCase(), c); }
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  }
  // New order numbers after moving the item at `from` to `to` in a list of ids. Only changed ones are returned.
  function reorder(ids, from, to, current) {
    const next = ids.slice(); const [moved] = next.splice(from, 1); next.splice(to, 0, moved);
    const out = {};
    next.forEach((id, i) => { const o = (i + 1) * 1000; if (!current || current[id] !== o) out[id] = o; });
    return out;
  }

  // Unclaimed shared tasks that have waited too long get a gentle nudge.
  function needsNudge(t, now, hours) {
    if (t.owner !== 'shared' || t.claimedBy || effectiveStatus(t, now) !== 'open') return false;
    const created = toMs(t.createdAt);
    return created != null && now - created >= (hours || 24) * 3600e3;
  }

  function isOverdue(t, now) {
    const due = toMs(t.dueAt);
    return due != null && due < now && effectiveStatus(t, now) === 'open';
  }

  // ---------- Repeats ----------
  // repeat: 'none' | 'daily' | 'weekly' | 'monthly' | { every: n, unit: 'day'|'week'|'month', weekdays?: [0-6] }
  function normRepeat(r) {
    if (!r || r === 'none') return null;
    if (r === 'daily') return { every: 1, unit: 'day' };
    if (r === 'weekly') return { every: 1, unit: 'week' };
    if (r === 'monthly') return { every: 1, unit: 'month' };
    if (typeof r === 'object' && ['day', 'week', 'month'].includes(r.unit)) {
      const every = Math.max(1, Math.min(365, parseInt(r.every, 10) || 1));
      const weekdays = Array.isArray(r.weekdays) ? [...new Set(r.weekdays.map(Number).filter(d => d >= 0 && d <= 6))].sort() : [];
      return { every, unit: r.unit, weekdays: r.unit === 'week' && weekdays.length ? weekdays : undefined };
    }
    return null;
  }

  function addMonths(ms, n) {
    const d = new Date(ms), day = d.getDate();
    d.setDate(1); d.setMonth(d.getMonth() + n);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last));
    return d.getTime();
  }
  function addDays(ms, n) { const d = new Date(ms); d.setDate(d.getDate() + n); return d.getTime(); }
  function weekStart(ms) { const d = new Date(startOfDay(ms)); d.setDate(d.getDate() - d.getDay()); return d.getTime(); }

  // One step after `from`, in the device's local time (so "every day at 7pm" stays at 7pm across clock changes).
  function stepOnce(from, rule, anchor) {
    if (rule.unit === 'day') return addDays(from, rule.every);
    if (rule.unit === 'month') return addMonths(from, rule.every);
    if (!rule.weekdays) return addDays(from, 7 * rule.every);
    // Weekly on chosen weekdays, every N weeks counted from the anchor's week.
    let d = from;
    for (let i = 0; i < 7 * rule.every * 2 + 7; i++) {
      d = addDays(d, 1);
      const weeks = Math.round((weekStart(d) - weekStart(anchor)) / (7 * DAY));
      if (rule.weekdays.includes(new Date(d).getDay()) && weeks % rule.every === 0) return d;
    }
    return addDays(from, 7 * rule.every);
  }

  // The next due time for a repeating task, never in the past. Tasks without a due time repeat from `now`.
  // until: optional last day ('YYYY-MM-DD', inclusive) — past it there is no next one. tz: the time zone that day is
  // in (the device's own when left out).
  function nextDue(dueAt, repeat, now, until, tz) {
    const rule = normRepeat(repeat);
    if (!rule) return null;
    const base = toMs(dueAt) != null ? toMs(dueAt) : now;
    let next = stepOnce(base, rule, base);
    for (let i = 0; i < 1000 && next <= now; i++) next = stepOnce(next, rule, base);
    if (validUntil(until) && ymdIn(next, tz) > until) return null;
    return next;
  }
  // ---------- Several times a day, and a set number of times ----------
  // A task that repeats by days can have dailyTimes: ['08:00', '18:30'] (in the household's time zone), and a
  // count: countOf (how many in all) with countN (which one this is). Medicine twice a day for 8 days is one task.
  function normTimes(a) {
    if (!Array.isArray(a)) return [];
    return [...new Set(a.map(x => String(x || '').trim()).filter(x => /^([01]\d|2[0-3]):[0-5]\d$/.test(x)))].sort().slice(0, 8);
  }
  const multiTimes = t => { const r = normRepeat(t.repeat); return !!r && r.unit === 'day' && normTimes(t.dailyTimes).length > 1; };
  const ymdAdd = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
  // ms for a wall-clock time on a day in a time zone (the device's when tz is left out).
  function zonedMs(ymd, hm, tz) {
    const [y, m, d] = ymd.split('-').map(Number), [h, mi] = hm.split(':').map(Number);
    if (!tz) return new Date(y, m - 1, d, h, mi).getTime();
    const want = Date.UTC(y, m - 1, d, h, mi);
    const off = ms => {
      const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).reduce((o, x) => { o[x.type] = x.value; return o; }, {});
      return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) - ms;
    };
    try { return want - off(want - off(want)); } catch (e) { return new Date(y, m - 1, d, h, mi).getTime(); }
  }
  // The slots of a several-times-a-day task after its current one. If some have already passed, the most recent of
  // them comes next (so a late dose is still shown, overdue) rather than skipping straight to the future.
  function nextSlot(t, now, tz) {
    const rule = normRepeat(t.repeat), times = normTimes(t.dailyTimes);
    const due = toMs(t.dueAt) != null ? toMs(t.dueAt) : now;
    let day = ymdIn(due, tz), prev = null;
    for (let i = 0; i < 400; i++, day = ymdAdd(day, rule.every)) {
      if (validUntil(t.repeatUntil) && day > t.repeatUntil) break;
      for (const hm of times) {
        const at = zonedMs(day, hm, tz);
        if (at <= due) continue;
        if (at <= now) { prev = at; continue; }
        return prev != null ? prev : at;
      }
    }
    return prev;
  }
  // The next copy of a repeating task: due time, or null when it has ended (end date or count).
  function nextFor(t, now, tz) {
    if (t.countOf && (t.countN || 1) >= t.countOf) return null;
    if (multiTimes(t)) return nextSlot(t, now, tz);
    return nextDue(t.dueAt, t.repeat, now, t.repeatUntil, tz);
  }
  // The fields the next copy carries forward.
  function carryRepeat(t) {
    const o = {};
    if (t.repeatUntil) o.repeatUntil = t.repeatUntil;
    if (normTimes(t.dailyTimes).length > 1) o.dailyTimes = normTimes(t.dailyTimes);
    if (t.countOf) { o.countOf = t.countOf; o.countN = (t.countN || 1) + 1; }
    return o;
  }
  // When the last copy will be due, for a task that ends after a count (null otherwise or when it can't tell).
  function lastOccurrence(t, tz) {
    if (!t.countOf || toMs(t.dueAt) == null) return null;
    let cur = { ...t, dueAt: toMs(t.dueAt) };
    for (let i = 0; i < 1000 && (cur.countN || 1) < cur.countOf; i++) {
      const next = nextFor(cur, 0, tz);
      if (!next) break;
      cur = { ...cur, ...carryRepeat(cur), dueAt: next };
    }
    return cur.dueAt;
  }
  // '18:30' → '6:30pm'
  function fmtHm(hm) { const [h, m] = hm.split(':').map(Number); const ap = h >= 12 ? 'pm' : 'am'; const h12 = h % 12 || 12; return m ? `${h12}:${String(m).padStart(2, '0')}${ap}` : `${h12}${ap}`; }
  // "Every day at 8am and 6:30pm" (repeatLabel plus the times), for tasks with several times a day.
  function repeatText(t) {
    const base = repeatLabel(t.repeat);
    if (!base) return '';
    const times = multiTimes(t) ? normTimes(t.dailyTimes) : [];
    return base + (times.length ? ' at ' + (times.length === 2 ? times.map(fmtHm).join(' and ') : times.slice(0, -1).map(fmtHm).join(', ') + ' and ' + fmtHm(times[times.length - 1])) : '');
  }
  const validUntil = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  function ymdIn(ms, tz) {
    if (tz) {
      try {
        const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
        const g = k => p.find(x => x.type === k).value;
        return `${g('year')}-${g('month')}-${g('day')}`;
      } catch (e) { /* fall through to the device's time zone */ }
    }
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  // "until Nov 30" (with the year when it isn't this year's).
  function untilLabel(until, now) {
    if (!validUntil(until)) return '';
    const [y, m, d] = until.split('-').map(Number);
    const sameYear = y === new Date(now || Date.now()).getFullYear();
    return 'until ' + new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
  }

  function repeatLabel(repeat) {
    const r = normRepeat(repeat);
    if (!r) return '';
    const names = { day: 'day', week: 'week', month: 'month' };
    const dn = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    let s = r.every === 1 ? 'Every ' + names[r.unit] : `Every ${r.every} ${names[r.unit]}s`;
    if (r.weekdays) s += ' on ' + r.weekdays.map(d => dn[d]).join(', ');
    return s;
  }

  // ---------- Quiet hours ----------
  // quiet: { enabled, start: 'HH:MM', end: 'HH:MM' }, tz: IANA time zone of the person.
  function hm(s) { const m = /^(\d{1,2}):(\d{2})$/.exec(s || ''); return m ? (+m[1] % 24) * 60 + (+m[2] % 60) : null; }
  function minutesIn(tz, ms) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
      const h = +parts.find(p => p.type === 'hour').value, m = +parts.find(p => p.type === 'minute').value;
      return (h % 24) * 60 + m;
    } catch (e) { const d = new Date(ms); return d.getUTCHours() * 60 + d.getUTCMinutes(); }
  }
  function inQuiet(quiet, tz, ms) {
    if (!quiet || quiet.enabled === false) return false;
    const s = hm(quiet.start), e = hm(quiet.end);
    if (s == null || e == null || s === e) return false;
    const m = minutesIn(tz, ms);
    return s < e ? (m >= s && m < e) : (m >= s || m < e);
  }
  function quietEndsAt(quiet, tz, ms) {
    const e = hm(quiet && quiet.end);
    if (e == null) return ms;
    const m = minutesIn(tz, ms);
    const wait = ((e - m) + 1440) % 1440 || 1440;
    return Math.floor(ms / 60000) * 60000 + wait * 60000;
  }

  // ---------- Reminders ----------
  // When the server should next look at a task, written by the app on every save.
  function notifyAtFor(t, now) {
    if (t.status === 'done') return null;
    if (t.status === 'snoozed') return toMs(t.showAgainOn);
    const due = toMs(t.dueAt);
    return due != null && due > now ? due : null;
  }

  function recipients(t, members) {
    if (t.owner !== 'shared') return members.includes(t.owner) ? [t.owner] : [];
    if (t.claimedBy) return members.includes(t.claimedBy) ? [t.claimedBy] : [];
    return members.slice();
  }

  // Decides what the reminder job does with one task that has come due.
  // group: { members: {uid: role}, names }, users: { uid: { quiet, tz, prefs } }.
  // Returns { send: [{ uid, kind }], update: {...fields to write on the task} }.
  // restUntil(user, now): optional; when it returns a time, that person gets nothing until then (Shabbos and Yom Tov).
  function planReminder(t, group, users, now, restUntil) {
    const members = Object.keys((group && group.members) || {});
    const update = {};
    if (t.status === 'done') return { send: [], update: { notifyAt: null, notifyOnly: null, notifyKind: null } };
    const kind = t.notifyKind || (t.status === 'snoozed' ? 'back' : 'due');
    if (kind === 'back') {
      update.status = 'open';
      update.showAgainOn = null;
    }
    let who = recipients(t, members);
    if (Array.isArray(t.notifyOnly) && t.notifyOnly.length) who = who.filter(u => t.notifyOnly.includes(u));
    const send = [], later = [];
    for (const uid of who) {
      const u = users[uid] || {};
      const prefs = u.prefs || {};
      if (prefs[kind] === false) continue;
      const rest = restUntil ? restUntil(u, now) : null;
      if (rest) later.push({ uid, at: rest });
      else if (inQuiet(u.quiet, u.tz, now)) later.push({ uid, at: quietEndsAt(u.quiet, u.tz, now) });
      else send.push({ uid, kind });
    }
    if (later.length) {
      update.notifyAt = Math.min(...later.map(l => l.at));
      update.notifyOnly = later.map(l => l.uid);
      update.notifyKind = kind; // so a deferred "back on your plate" still says so after quiet hours

    } else {
      // After a "back" reminder, a future due time still gets its own reminder.
      const due = toMs(t.dueAt);
      update.notifyAt = kind === 'back' && due != null && due > now ? due : null;
      update.notifyOnly = null;
      update.notifyKind = null;
    }
    return { send, update };
  }

  // ---------- Daf Yomi reminder ----------
  // pref: { enabled, same: true|false, time: 'HH:MM', days: { 0..6: 'HH:MM' | '' } } (days used when same is false).
  // Returns today's local date ('YYYY-MM-DD') when the reminder should go out now, or null. It goes out in the half
  // hour after the chosen time, once a day (sentOn is the last date it went out).
  function dafReminderDue(pref, tz, now, sentOn) {
    if (!pref || !pref.enabled) return null;
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(now)).reduce((o, x) => { o[x.type] = x.value; return o; }, {});
    const date = `${p.year}-${p.month}-${p.day}`;
    if (sentOn === date) return null;
    const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
    const at = hm(pref.same === false ? (pref.days || {})[wd] : pref.time);
    if (at == null) return null;
    const mins = (+p.hour % 24) * 60 + +p.minute;
    return mins >= at && mins - at < 30 ? date : null;
  }

  // ---------- Display ----------
  const DN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtTime(ms) {
    const d = new Date(ms); let h = d.getHours(); const m = d.getMinutes();
    const ap = h >= 12 ? 'pm' : 'am'; h = h % 12 || 12;
    return m ? `${h}:${String(m).padStart(2, '0')}${ap}` : `${h}${ap}`;
  }
  function fmtWhen(v, now, withTime = true) {
    const ms = toMs(v);
    if (ms == null) return '';
    const days = Math.round((startOfDay(ms) - startOfDay(now)) / DAY);
    const d = new Date(ms);
    const t = withTime && (d.getHours() || d.getMinutes()) ? ' ' + fmtTime(ms) : '';
    if (days === 0) return 'Today' + t;
    if (days === 1) return 'Tomorrow' + t;
    if (days === -1) return 'Yesterday' + t;
    if (days > 1 && days < 7) return DN[d.getDay()] + t;
    const y = d.getFullYear() !== new Date(now).getFullYear() ? ' ' + d.getFullYear() : '';
    return `${MN[d.getMonth()]} ${d.getDate()}${y}` + t;
  }

  return {
    toMs, effectiveStatus, responsible, laneOf, lanes, needsNudge, isOverdue, arrange, byCategory, categories, reorder,
    normRepeat, nextDue, nextFor, untilLabel, validUntil, repeatLabel, normTimes, multiTimes, zonedMs, carryRepeat, lastOccurrence, repeatText, fmtHm, ymdIn, inQuiet, quietEndsAt, minutesIn,
    notifyAtFor, recipients, planReminder, dafReminderDue, fmtWhen, fmtTime, startOfDay, endOfDay
  };
});
