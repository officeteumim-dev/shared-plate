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
    for (const k of ['today', 'mine', 'theirs', 'shared']) out[k].sort(byDue);
    out.snoozed.sort((a, b) => (toMs(a.showAgainOn) || 0) - (toMs(b.showAgainOn) || 0));
    out.done.sort((a, b) => (toMs(b.completedAt) || 0) - (toMs(a.completedAt) || 0));
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
  function nextDue(dueAt, repeat, now) {
    const rule = normRepeat(repeat);
    if (!rule) return null;
    const base = toMs(dueAt) != null ? toMs(dueAt) : now;
    let next = stepOnce(base, rule, base);
    for (let i = 0; i < 1000 && next <= now; i++) next = stepOnce(next, rule, base);
    return next;
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
  function planReminder(t, group, users, now) {
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
      if (inQuiet(u.quiet, u.tz, now)) later.push(uid); else send.push({ uid, kind });
    }
    if (later.length) {
      update.notifyAt = Math.min(...later.map(uid => quietEndsAt(users[uid].quiet, users[uid].tz, now)));
      update.notifyOnly = later;
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
    toMs, effectiveStatus, responsible, laneOf, lanes, needsNudge, isOverdue,
    normRepeat, nextDue, repeatLabel, inQuiet, quietEndsAt, minutesIn,
    notifyAtFor, recipients, planReminder, fmtWhen, fmtTime, startOfDay, endOfDay
  };
});
