// Compares our weekly parsha and Daf Yomi with Hebcal's own library, for every Shabbos and every day over ~a century.
// Hebcal is the reference. CI installs it (see .github/workflows/tests.yml); locally the test is skipped if it isn't installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const Hb = createRequire(import.meta.url)('../public/hebrew.js');
process.env.TZ = 'America/New_York';

let core = null, learning = null;
try { core = await import('@hebcal/core'); } catch (e) { /* not installed */ }
try { learning = await import('@hebcal/learning'); } catch (e) { /* not installed */ }
const REQUIRED = !!process.env.CI;

// Hebcal's names, in the same order as ours.
const HEBCAL_PARSHIYOS = ['Bereshit', 'Noach', 'Lech-Lecha', 'Vayera', 'Chayei Sara', 'Toldot', 'Vayetzei', 'Vayishlach', 'Vayeshev', 'Miketz',
  'Vayigash', 'Vayechi', 'Shemot', 'Vaera', 'Bo', 'Beshalach', 'Yitro', 'Mishpatim', 'Terumah', 'Tetzaveh', 'Ki Tisa', 'Vayakhel', 'Pekudei',
  'Vayikra', 'Tzav', 'Shmini', 'Tazria', 'Metzora', 'Achrei Mot', 'Kedoshim', 'Emor', 'Behar', 'Bechukotai', 'Bamidbar', 'Nasso',
  "Beha'alotcha", "Sh'lach", 'Korach', 'Chukat', 'Balak', 'Pinchas', 'Matot', 'Masei', 'Devarim', 'Vaetchanan', 'Eikev', "Re'eh", 'Shoftim',
  'Ki Teitzei', 'Ki Tavo', 'Nitzavim', 'Vayeilech', "Ha'azinu"];
const ours = names => names.map(n => Hb.PARSHIYOS[HEBCAL_PARSHIYOS.indexOf(n)] || '?' + n).join('-');

test('weekly parsha matches Hebcal (diaspora) for every Shabbos, 2000–2100', { skip: !core && !REQUIRED && 'Hebcal not installed' }, () => {
  assert.ok(core, '@hebcal/core must be installed in CI');
  const { HDate, getSedra } = core;
  let checked = 0; const bad = [];
  for (let d = new Date(2000, 0, 1, 12); d.getFullYear() < 2100; d.setDate(d.getDate() + 1)) {
    if (d.getDay() !== 6) continue;
    const hd = new HDate(d);
    const r = getSedra(hd.getFullYear(), false).lookup(hd);
    const want = r.chag ? null : ours(r.parsha);
    const got = Hb.parsha(d.getTime());
    checked++;
    if (got !== want && bad.length < 15) bad.push(`${d.toDateString()}: Hebcal ${want}, ours ${got}`);
  }
  assert.deepEqual(bad, [], `${bad.length} differences out of ${checked}`);
});

test('Daf Yomi matches Hebcal for every day, 2020–2060', { skip: !learning && !REQUIRED && 'Hebcal not installed' }, () => {
  assert.ok(learning, '@hebcal/learning must be installed in CI');
  const { DafYomi } = learning;
  const bad = [];
  for (let d = new Date(2020, 0, 5, 12); d.getFullYear() < 2060; d.setDate(d.getDate() + 1)) {
    const h = new DafYomi(d), o = Hb.dafYomi(d.getTime());
    const hi = Hb.SHAS.findIndex(m => m[0] === o.masechta);
    if ((h.getBlatt ? h.getBlatt() : h.blatt) !== o.daf || Hb.SHAS.length !== 40 || hi < 0) bad.push(`${d.toDateString()}: Hebcal ${h.render ? h.render('en') : h.getName()}, ours ${o.masechta} ${o.daf}`);
    if (bad.length >= 15) break;
  }
  assert.deepEqual(bad, []);
});
