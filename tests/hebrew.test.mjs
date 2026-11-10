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
