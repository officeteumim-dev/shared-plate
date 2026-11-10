// Checks the calendar feed (.ics) that Google Calendar and Apple Calendar subscribe to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { buildIcs, rrule, fold } = createRequire(import.meta.url)('../functions/ics.js');
const at = s => new Date(s).getTime();
const opts = { name: 'Our home (mine)', tz: 'America/New_York', now: at('2026-11-06T14:00:00Z'), siteUrl: 'https://x.web.app', groupId: 'g1' };

test('a timed task becomes a 30-minute event in local time', () => {
  const ics = buildIcs([{ id: 't1', title: 'Pick up challah', dueAt: at('2026-11-06T20:00:00Z'), repeat: 'weekly', priority: '1', category: 'House' }], opts);
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /DTSTART;TZID=America\/New_York:20261106T150000\r\n/);
  assert.match(ics, /DURATION:PT30M/);
  assert.match(ics, /RRULE:FREQ=WEEKLY/);
  assert.match(ics, /SUMMARY:\[1\] Pick up challah/);
  assert.match(ics, /DESCRIPTION:Category: House/);
  assert.match(ics, /URL:https:\/\/x\.web\.app\/#task=g1%2Ft1/);
  assert.match(ics, /END:VCALENDAR\r\n$/);
});

test('a task at midnight is an all-day event', () => {
  const ics = buildIcs([{ id: 't2', title: 'Car registration', dueAt: at('2026-11-11T05:00:00Z') }], opts);
  assert.match(ics, /DTSTART;VALUE=DATE:20261111\r\nDTEND;VALUE=DATE:20261112/);
});

test('names, commas and line breaks are escaped; long lines are folded', () => {
  const ics = buildIcs([{ id: 't3', title: 'Call Rieber, swap dumpster; ASAP', notes: 'Line one\nLine two', who: 'Leah', dueAt: at('2026-11-06T20:00:00Z') }], opts);
  assert.ok(ics.includes('SUMMARY:Call Rieber\\, swap dumpster\\; ASAP (Leah)'));
  assert.match(ics, /Line one\\nLine two/);
  assert.equal(fold('x'.repeat(100)).split('\r\n ').map(l => l.length).join(','), '75,25');
});

test('tasks without a due date are left out', () => {
  assert.doesNotMatch(buildIcs([{ id: 'n', title: 'Someday' }], opts), /BEGIN:VEVENT/);
});

test('repeat rules', () => {
  assert.equal(rrule('daily'), 'FREQ=DAILY');
  assert.equal(rrule('monthly'), 'FREQ=MONTHLY');
  assert.equal(rrule({ every: 2, unit: 'week', weekdays: [1, 4] }), 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH');
  assert.equal(rrule('none'), null);
});
