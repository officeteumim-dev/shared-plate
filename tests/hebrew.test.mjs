// Checks Hebrew dates and holidays against known dates (diaspora).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const Hb = createRequire(import.meta.url)('../public/hebrew.js');
process.env.TZ = 'America/New_York';
const at = s => new Date(s + 'T12:00:00').getTime();
const names = s => Hb.holidays(at(s)).map(h => h.name);

test('Hebrew dates', () => {
  assert.equal(Hb.supported, true);
  assert.equal(Hb.formatEnglish(at('2026-11-09'), true), '29 Cheshvan 5787');
  assert.equal(Hb.format(at('2026-12-05')), 'כ״ה כסלו');
  assert.equal(Hb.gematria(5787), 'תשפ״ז');
  assert.equal(Hb.gematria(15), 'ט״ו');
  assert.equal(Hb.gematria(16), 'ט״ז');
  assert.equal(Hb.gematria(1), 'א׳');
});

test('the Yamim Tovim of 5787', () => {
  assert.deepEqual(names('2026-09-12'), ['Rosh Hashana']);
  assert.deepEqual(names('2026-09-14'), ['Tzom Gedalia']);
  assert.deepEqual(names('2026-09-21'), ['Yom Kippur']);
  assert.deepEqual(names('2026-09-26'), ['Sukkos']);
  assert.deepEqual(names('2026-10-03'), ['Shemini Atzeres']);
  assert.deepEqual(names('2026-10-04'), ['Simchas Torah']);
  assert.deepEqual(names('2027-04-22'), ['Pesach']);
  assert.deepEqual(names('2027-04-29'), ['Pesach']);
  assert.deepEqual(names('2027-06-11'), ['Shavuos']);
});

test('Chanukah runs eight days, into Teves', () => {
  assert.deepEqual(names('2026-12-05'), ['Chanukah, day 1']);
  assert.ok(names('2026-12-12').includes('Chanukah, day 8'));
  assert.ok(!names('2026-12-13').some(n => n.startsWith('Chanukah')));
  assert.ok(names('2025-12-22').includes('Chanukah, day 8'));
});

test('Purim and fasts, including fasts moved off Shabbos', () => {
  assert.deepEqual(names('2027-03-23'), ['Purim']);
  assert.deepEqual(names('2027-03-22'), ['Taanis Esther']);
  assert.deepEqual(names('2024-03-21'), ['Taanis Esther']); // 13 Adar II was Shabbos
  assert.deepEqual(names('2024-03-23'), []);
  assert.deepEqual(names('2022-08-07'), ["Tisha B'Av (observed)"]); // 9 Av was Shabbos
  assert.deepEqual(names('2022-08-06'), []);
  assert.deepEqual(names('2025-08-03'), ["Tisha B'Av"]);
  assert.deepEqual(names('2026-12-20'), ["Asarah B'Teves"]);
});

test('Rosh Chodesh', () => {
  assert.deepEqual(names('2026-11-10'), ['Rosh Chodesh Kislev']); // 30 Cheshvan
  assert.ok(names('2026-11-11').includes('Rosh Chodesh Kislev')); // 1 Kislev
  assert.deepEqual(names('2026-11-09'), []);
});

test('sunset is within a few minutes of published times', () => {
  const ny = Hb.sunset(2026, 11, 13, 40.71, -74.01), june = Hb.sunset(2026, 6, 21, 40.71, -74.01);
  const near = (ms, iso) => assert.ok(Math.abs(ms - Date.parse(iso)) < 4 * 60000, `${new Date(ms).toISOString()} vs ${iso}`);
  near(ny, '2026-11-13T16:40:00-05:00');
  near(june, '2026-06-21T20:31:00-04:00');
  near(Hb.sunset(2026, 11, 13, 31.78, 35.22), '2026-11-13T16:41:00+02:00');
});

test('no notifications from an hour before sunset Friday until 1½ hours after sunset Shabbos', () => {
  const ny = 'America/New_York', at = s => Date.parse(s);
  assert.equal(Hb.restUntil(at('2026-11-13T15:30:00-05:00'), ny), null, 'Friday afternoon is fine');
  const until = Hb.restUntil(at('2026-11-13T15:45:00-05:00'), ny);
  assert.ok(until > at('2026-11-14T18:00:00-05:00') && until < at('2026-11-14T18:15:00-05:00'));
  assert.equal(Hb.restUntil(at('2026-11-14T12:00:00-05:00'), ny), until);
  assert.equal(Hb.restUntil(at('2026-11-14T18:30:00-05:00'), ny), null, 'Motzei Shabbos');
  assert.equal(Hb.restUntil(at('2026-11-17T12:00:00-05:00'), ny), null, 'a Tuesday');
});

test('Yom Tov joined to Shabbos runs as one stretch (Shavuos 2027, Fri–Sat); Yom Kippur too', () => {
  const ny = 'America/New_York', at = s => Date.parse(s);
  const start = Hb.restUntil(at('2027-06-10T20:00:00-04:00'), ny); // Erev Shavuos, Thursday evening
  assert.ok(start > at('2027-06-12T21:30:00-04:00') && start < at('2027-06-12T22:15:00-04:00'));
  assert.equal(Hb.restUntil(at('2027-06-11T12:00:00-04:00'), ny), start);
  assert.ok(Hb.restUntil(at('2026-09-21T12:00:00-04:00'), ny), 'Yom Kippur 5787');
  assert.equal(Hb.restUntil(at('2026-09-23T12:00:00-04:00'), ny), null, 'the Wednesday after');
});
