// Checks the linked-family helpers (functions/family.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const F = require('../functions/family.js');
const L = require('../public/logic.js');
const at = s => Date.parse(s);
const FROM = at('2026-11-01T00:00:00-05:00'), TO = at('2026-12-01T00:00:00-05:00');
const tasks = [
  { id: 'a', title: 'Noa’s recital', dueAt: at('2026-11-20T18:00:00-05:00'), owner: 'leah', familyShare: true, status: 'open' },
  { id: 'b', title: 'Dentist', dueAt: at('2026-11-18T10:00:00-05:00'), owner: 'max', status: 'open' },
  { id: 'c', title: 'Shabbos dinner', dueAt: at('2026-11-13T18:00:00-05:00'), owner: 'shared', repeat: 'weekly', familyShare: true, status: 'open' },
  { id: 'd', title: 'No date', owner: 'max', familyShare: true, status: 'open' },
  { id: 'e', title: 'Done thing', dueAt: at('2026-11-10T10:00:00-05:00'), owner: 'max', familyShare: true, status: 'done' }
];
const names = { max: 'Max', leah: 'Leah' };

test('sharing nothing shows nothing', () => {
  assert.deepEqual(F.visibleTasks(tasks, 'none', names, L, FROM, TO), []);
});

test('shared events: only tasks marked to share, with their repeats, and who has them', () => {
  const v = F.visibleTasks(tasks, 'events', names, L, FROM, TO);
  assert.deepEqual([...new Set(v.map(x => x.title))].sort(), ['Noa’s recital', 'Shabbos dinner']);
  assert.equal(v.filter(x => x.title === 'Shabbos dinner').length, 3, 'Nov 13, 20, 27');
  assert.equal(v.find(x => x.title === 'Noa’s recital').who, 'Leah');
  assert.equal(v.find(x => x.title === 'Shabbos dinner').who, 'Shared');
});

test('whole calendar: every open task with a date', () => {
  const v = F.visibleTasks(tasks, 'calendar', names, L, FROM, TO);
  assert.ok(v.some(x => x.title === 'Dentist' && x.who === 'Max'));
  assert.ok(!v.some(x => x.title === 'No date' || x.title === 'Done thing'));
});

test('settings default to the most private choice', () => {
  assert.deepEqual(F.cleanSettings({}), { share: 'none', accept: false });
  assert.deepEqual(F.cleanSettings({ share: 'everything', accept: 'yes' }), { share: 'none', accept: true });
  assert.deepEqual(F.cleanSettings({ share: 'calendar', accept: true }), { share: 'calendar', accept: true });
});

test('suggestions are checked and become tasks on the chosen plate', () => {
  assert.match(F.cleanSuggestion({ title: '' }).error, /title/);
  assert.match(F.cleanSuggestion({ title: 'x', repeat: 'weekly' }).error, /date/);
  const s = F.cleanSuggestion({ title: 'Bring the kids Sunday', dueAt: at('2026-11-22T10:00:00-05:00'), notes: 'We’ll do lunch' }).value;
  const t = F.taskFromSuggestion({ ...s, fromName: 'Grandma (Grandma & Grandpa)', fromGroup: 'g9' }, 'shared', 'max', L, at('2026-11-15T12:00:00-05:00'));
  assert.equal(t.owner, 'shared');
  assert.equal(t.fromFamily, 'g9');
  assert.match(t.notes, /We’ll do lunch\nFrom Grandma \(Grandma & Grandpa\)/);
  assert.equal(t.notifyAt, s.dueAt, 'it gets a reminder like any task');
});

test('link codes are 8 easy-to-read characters', () => {
  const code = F.linkCode(n => Buffer.from([...Array(n)].map((_, i) => i * 37)));
  assert.match(code, /^[A-HJ-NP-Z2-9]{8}$/);
});
