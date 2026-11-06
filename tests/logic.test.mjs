// Checks the household rules in public/logic.js: lanes, nudges, repeats, quiet hours and reminder planning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const L = createRequire(import.meta.url)('../public/logic.js');

process.env.TZ = 'America/New_York';
const at = s => new Date(s).getTime();
const NOW = at('2026-11-06T09:00:00');
const H = 3600e3;

test('lanes: mine, theirs, shared, claimed, snoozed and done', () => {
  const tasks = [
    { id: 1, title: 'a', owner: 'me', status: 'open' },
    { id: 2, title: 'b', owner: 'her', status: 'open' },
    { id: 3, title: 'c', owner: 'shared', claimedBy: null, status: 'open' },
    { id: 4, title: 'd', owner: 'shared', claimedBy: 'her', status: 'open' },
    { id: 5, title: 'e', owner: 'me', status: 'snoozed', showAgainOn: NOW + H },
    { id: 6, title: 'f', owner: 'me', status: 'snoozed', showAgainOn: NOW - H },
    { id: 7, title: 'g', owner: 'me', status: 'done', completedAt: NOW }
  ];
  const l = L.lanes(tasks, 'me', NOW);
  assert.deepEqual(l.mine.map(t => t.id), [1, 6]);
  assert.deepEqual(l.theirs.map(t => t.id), [2, 4]);
  assert.deepEqual(l.shared.map(t => t.id), [3]);
  assert.deepEqual(l.snoozed.map(t => t.id), [5]);
  assert.deepEqual(l.done.map(t => t.id), [7]);
});

test('today strip: due today or overdue, soonest first; tomorrow is left out', () => {
  const tasks = [
    { id: 'late', owner: 'me', status: 'open', dueAt: at('2026-11-05T18:00') },
    { id: 'tonight', owner: 'her', status: 'open', dueAt: at('2026-11-06T20:00') },
    { id: 'noon', owner: 'shared', status: 'open', dueAt: at('2026-11-06T12:00') },
    { id: 'tomorrow', owner: 'me', status: 'open', dueAt: at('2026-11-07T08:00') },
    { id: 'none', owner: 'me', status: 'open' }
  ];
  assert.deepEqual(L.lanes(tasks, 'me', NOW).today.map(t => t.id), ['late', 'noon', 'tonight']);
});

test('nudge: only unclaimed shared tasks older than 24 hours', () => {
  assert.equal(L.needsNudge({ owner: 'shared', status: 'open', createdAt: NOW - 25 * H }, NOW, 24), true);
  assert.equal(L.needsNudge({ owner: 'shared', status: 'open', createdAt: NOW - 23 * H }, NOW, 24), false);
  assert.equal(L.needsNudge({ owner: 'shared', claimedBy: 'me', status: 'open', createdAt: NOW - 48 * H }, NOW, 24), false);
  assert.equal(L.needsNudge({ owner: 'me', status: 'open', createdAt: NOW - 48 * H }, NOW, 24), false);
});

test('repeat: daily, weekly and monthly keep the time of day', () => {
  const due = at('2026-11-06T19:00');
  assert.equal(L.nextDue(due, 'daily', NOW), at('2026-11-07T19:00'));
  assert.equal(L.nextDue(due, 'weekly', NOW), at('2026-11-13T19:00'));
  assert.equal(L.nextDue(due, 'monthly', NOW), at('2026-12-06T19:00'));
});

test('repeat: across the clock change, 7pm stays 7pm', () => {
  const due = at('2026-10-31T19:00'); // DST ends Nov 1 in New York
  assert.equal(new Date(L.nextDue(due, 'daily', at('2026-10-31T20:00'))).getHours(), 19);
});

test('repeat: monthly on the 31st falls back to the last day of shorter months', () => {
  assert.equal(L.nextDue(at('2027-01-31T09:00'), 'monthly', at('2027-01-31T10:00')), at('2027-02-28T09:00'));
});

test('repeat: an overdue repeating task jumps to the next future date', () => {
  assert.equal(L.nextDue(at('2026-11-01T08:00'), 'daily', NOW), at('2026-11-07T08:00'));
});

test('repeat: custom every 2 weeks on Mon and Thu', () => {
  const rule = { every: 2, unit: 'week', weekdays: [1, 4] };
  const mon = at('2026-11-02T10:00'); // Monday
  assert.equal(L.nextDue(mon, rule, at('2026-11-02T11:00')), at('2026-11-05T10:00')); // Thu same week
  assert.equal(L.nextDue(at('2026-11-05T10:00'), rule, at('2026-11-05T11:00')), at('2026-11-16T10:00')); // Mon two weeks on
  assert.equal(L.repeatLabel(rule), 'Every 2 weeks on Mon, Thu');
});

test('repeat: none gives no next date', () => {
  assert.equal(L.nextDue(NOW, 'none', NOW), null);
});

test('quiet hours across midnight', () => {
  const q = { start: '22:00', end: '07:00' };
  const tz = 'America/New_York';
  assert.equal(L.inQuiet(q, tz, at('2026-11-06T23:30')), true);
  assert.equal(L.inQuiet(q, tz, at('2026-11-06T06:59')), true);
  assert.equal(L.inQuiet(q, tz, at('2026-11-06T07:00')), false);
  assert.equal(L.inQuiet(q, tz, at('2026-11-06T12:00')), false);
  assert.equal(L.quietEndsAt(q, tz, at('2026-11-06T23:30')), at('2026-11-07T07:00'));
  assert.equal(L.inQuiet({ ...q, enabled: false }, tz, at('2026-11-06T23:30')), false);
});

test('quiet hours use the person’s own time zone', () => {
  const q = { start: '22:00', end: '07:00' };
  // 9am in New York is 4pm in Jerusalem: not quiet. 4pm in New York is 11pm in Jerusalem: quiet.
  assert.equal(L.inQuiet(q, 'Asia/Jerusalem', NOW), false);
  assert.equal(L.inQuiet(q, 'Asia/Jerusalem', at('2026-11-06T16:00')), true);
});

test('reminders: an owned task goes to its owner', () => {
  const g = { members: { me: 'owner', her: 'member' } };
  const p = L.planReminder({ owner: 'her', status: 'open', dueAt: NOW }, g, {}, NOW);
  assert.deepEqual(p.send, [{ uid: 'her', kind: 'due' }]);
  assert.equal(p.update.notifyAt, null);
});

test('reminders: an unclaimed shared task goes to everyone; claimed goes to the claimer', () => {
  const g = { members: { me: 'owner', her: 'member' } };
  assert.deepEqual(L.planReminder({ owner: 'shared', status: 'open' }, g, {}, NOW).send.map(s => s.uid).sort(), ['her', 'me']);
  assert.deepEqual(L.planReminder({ owner: 'shared', claimedBy: 'me', status: 'open' }, g, {}, NOW).send.map(s => s.uid), ['me']);
});

test('reminders: quiet hours delay the reminder for that person only', () => {
  const g = { members: { me: 'owner', her: 'member' } };
  const night = at('2026-11-06T23:00');
  const users = { her: { quiet: { start: '22:00', end: '07:00' }, tz: 'America/New_York' }, me: {} };
  const p = L.planReminder({ owner: 'shared', status: 'open' }, g, users, night);
  assert.deepEqual(p.send, [{ uid: 'me', kind: 'due' }]);
  assert.deepEqual(p.update.notifyOnly, ['her']);
  assert.equal(p.update.notifyAt, at('2026-11-07T07:00'));
  // In the morning only she gets it.
  const p2 = L.planReminder({ owner: 'shared', status: 'open', notifyOnly: ['her'], notifyKind: 'due' }, g, users, at('2026-11-07T07:00'));
  assert.deepEqual(p2.send, [{ uid: 'her', kind: 'due' }]);
  assert.equal(p2.update.notifyOnly, null);
});

test('reminders: a snoozed task comes back, opens, and keeps a later due reminder', () => {
  const g = { members: { me: 'owner' } };
  const p = L.planReminder({ owner: 'me', status: 'snoozed', showAgainOn: NOW, dueAt: NOW + 5 * H }, g, {}, NOW);
  assert.deepEqual(p.send, [{ uid: 'me', kind: 'back' }]);
  assert.equal(p.update.status, 'open');
  assert.equal(p.update.notifyAt, NOW + 5 * H);
});

test('reminders: turned-off notification types are skipped; done tasks are cleared', () => {
  const g = { members: { me: 'owner' } };
  assert.deepEqual(L.planReminder({ owner: 'me', status: 'open' }, g, { me: { prefs: { due: false } } }, NOW).send, []);
  assert.deepEqual(L.planReminder({ owner: 'me', status: 'done' }, g, {}, NOW), { send: [], update: { notifyAt: null, notifyOnly: null, notifyKind: null } });
});

test('notifyAt: due time in the future, snooze date, or nothing', () => {
  assert.equal(L.notifyAtFor({ status: 'open', dueAt: NOW + H }, NOW), NOW + H);
  assert.equal(L.notifyAtFor({ status: 'open', dueAt: NOW - H }, NOW), null);
  assert.equal(L.notifyAtFor({ status: 'snoozed', showAgainOn: NOW + 2 * H }, NOW), NOW + 2 * H);
  assert.equal(L.notifyAtFor({ status: 'done', dueAt: NOW + H }, NOW), null);
});

test('friendly dates', () => {
  assert.equal(L.fmtWhen(at('2026-11-06T15:00'), NOW), 'Today 3pm');
  assert.equal(L.fmtWhen(at('2026-11-07T10:30'), NOW), 'Tomorrow 10:30am');
  assert.equal(L.fmtWhen(at('2026-11-10T00:00'), NOW), 'Tue');
  assert.equal(L.fmtWhen(at('2026-12-25T00:00'), NOW), 'Dec 25');
});
