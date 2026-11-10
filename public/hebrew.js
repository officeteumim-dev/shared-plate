// Hebrew dates and Jewish holidays (diaspora), using the Hebrew calendar built into the browser (Intl).
// Shared by the app (window.SP_HEBREW) and the tests. No network or library needed.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SP_HEBREW = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  let EN, HE;
  try {
    EN = new Intl.DateTimeFormat('en-u-ca-hebrew', { day: 'numeric', month: 'long', year: 'numeric' });
    HE = new Intl.DateTimeFormat('he-u-ca-hebrew', { month: 'long' });
  } catch (e) { /* very old browsers: Hebrew dates stay off */ }
  const supported = !!EN && /Tishri|Heshvan|Kislev|Nisan|Elul|Av|Iyar|Sivan|Tamuz|Tevet|Shevat|Adar/.test(EN.format(new Date()));

  // Month names as Intl writes them → the Ashkenazi spelling used in the app.
  const MONTH = { Tishri: 'Tishrei', Heshvan: 'Cheshvan', Kislev: 'Kislev', Tevet: 'Teves', Shevat: 'Shevat', 'Adar I': 'Adar I',
    'Adar II': 'Adar II', Adar: 'Adar', Nisan: 'Nissan', Iyar: 'Iyar', Sivan: 'Sivan', Tamuz: 'Tammuz', Av: 'Av', Elul: 'Elul' };

  const noon = ms => { const d = new Date(ms); d.setHours(12, 0, 0, 0); return d; };
  const shift = (ms, days) => { const d = noon(ms); d.setDate(d.getDate() + days); return d.getTime(); };

  function parts(ms) {
    const p = EN.formatToParts(noon(ms));
    const get = t => (p.find(x => x.type === t) || {}).value;
    const raw = get('month');
    return { day: +get('day'), month: MONTH[raw] || raw, raw, year: +get('year'), weekday: noon(ms).getDay() };
  }

  // Hebrew numerals: 15 → ט״ו, 16 → ט״ז, 5787 → תשפ״ז (thousands left off, as usual).
  function gematria(n) {
    const ones = ['', 'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט'];
    const tens = ['', 'י', 'כ', 'ל', 'מ', 'נ', 'ס', 'ע', 'פ', 'צ'];
    const hundreds = ['', 'ק', 'ר', 'ש', 'ת', 'תק', 'תר', 'תש', 'תת', 'תתק'];
    n = n % 1000;
    let s = hundreds[Math.floor(n / 100)];
    const r = n % 100;
    if (r === 15) s += 'טו'; else if (r === 16) s += 'טז'; else s += tens[Math.floor(r / 10)] + ones[r % 10];
    return s.length === 1 ? s + '׳' : s.slice(0, -1) + '״' + s.slice(-1);
  }

  function hebrewMonthName(ms) { return HE.format(noon(ms)); }

  // "כ״ט חשוון תשפ״ז" (withYear) or "כ״ט חשוון".
  function format(ms, withYear) {
    const p = parts(ms);
    return `${gematria(p.day)} ${hebrewMonthName(ms)}${withYear ? ' ' + gematria(p.year) : ''}`;
  }
  // Just the day of the month in Hebrew letters, for calendar cells.
  const dayLetters = ms => gematria(parts(ms).day);
  // "29 Cheshvan 5787"
  function formatEnglish(ms, withYear) { const p = parts(ms); return `${p.day} ${p.month}${withYear ? ' ' + p.year : ''}`; }

  // Holidays and special days for one civil date (diaspora). Each is { name, kind: 'yomtov' | 'holiday' | 'fast' | 'minor' | 'erev' }.
  function holidays(ms) {
    if (!supported) return [];
    const p = parts(ms), out = [];
    const add = (name, kind) => out.push({ name, kind });
    const { day: d, raw: m, weekday: wd } = p;
    const sat = 6;
    // A fast day that falls on Shabbos moves to Sunday.
    const fast = (name, onDay) => {
      if (d === onDay && wd !== sat) add(name, 'fast');
      if (d === onDay + 1 && wd === 0) add(name + ' (observed)', 'fast');
    };
    if (d === 30) add(`Rosh Chodesh ${MONTH[parts(shift(ms, 1)).raw] || parts(shift(ms, 1)).raw}`, 'minor');
    if (d === 1 && m !== 'Tishri') add(`Rosh Chodesh ${p.month}`, 'minor');
    switch (m) {
      case 'Tishri':
        if (d === 1 || d === 2) add('Rosh Hashana', 'yomtov');
        fast('Tzom Gedalia', 3);
        if (d === 9) add('Erev Yom Kippur', 'erev');
        if (d === 10) add('Yom Kippur', 'yomtov');
        if (d === 14) add('Erev Sukkos', 'erev');
        if (d === 15 || d === 16) add('Sukkos', 'yomtov');
        if (d >= 17 && d <= 20) add('Chol Hamoed Sukkos', 'holiday');
        if (d === 21) add('Hoshana Rabbah', 'holiday');
        if (d === 22) add('Shemini Atzeres', 'yomtov');
        if (d === 23) add('Simchas Torah', 'yomtov');
        break;
      case 'Kislev':
        if (d === 24) add('Erev Chanukah', 'erev');
        if (d >= 25) add(`Chanukah, day ${d - 24}`, 'holiday');
        break;
      case 'Tevet': {
        const kislevLen = parts(shift(ms, -d)).day; // the last day of Kislev is 29 or 30
        const n = kislevLen - 24 + d;
        if (n <= 8) add(`Chanukah, day ${n}`, 'holiday');
        if (d === 10) add("Asarah B'Teves", 'fast');
        break;
      }
      case 'Shevat':
        if (d === 15) add("Tu B'Shvat", 'minor');
        break;
      case 'Adar I':
        if (d === 14) add('Purim Katan', 'minor');
        break;
      case 'Adar':
      case 'Adar II':
        // Taanis Esther moves back to Thursday when the 13th is Shabbos.
        if ((d === 13 && wd !== sat) || (d === 11 && wd === 4)) add('Taanis Esther', 'fast');
        if (d === 14) add('Purim', 'holiday');
        if (d === 15) add('Shushan Purim', 'minor');
        break;
      case 'Nisan':
        if (d === 14) add('Erev Pesach', 'erev');
        if (d === 15 || d === 16) add('Pesach', 'yomtov');
        if (d >= 17 && d <= 20) add('Chol Hamoed Pesach', 'holiday');
        if (d === 21 || d === 22) add('Pesach', 'yomtov');
        break;
      case 'Iyar':
        if (d === 18) add("Lag Ba'omer", 'minor');
        break;
      case 'Sivan':
        if (d === 5) add('Erev Shavuos', 'erev');
        if (d === 6 || d === 7) add('Shavuos', 'yomtov');
        break;
      case 'Tamuz':
        fast("Shiva Asar B'Tammuz", 17);
        break;
      case 'Av':
        fast("Tisha B'Av", 9);
        if (d === 15) add("Tu B'Av", 'minor');
        break;
      case 'Elul':
        if (d === 29) add('Erev Rosh Hashana', 'erev');
        break;
    }
    return out;
  }

  // ---------- Weekly parsha (diaspora) and Daf Yomi ----------
  // The parsha schedule is worked out per Hebrew year: Shabbosos from after Simchas Torah to before the next
  // Rosh Hashana that aren't Yom Tov, with the standard pairs joined when there are fewer Shabbosos than parshiyos.
  // Checked against Hebcal for every Shabbos over about a century (tests/hebcal.test.mjs).
  const Hb = { parts, holidays };
  const DAY = 86400e3;
  const noonOf = (y, m, d) => new Date(y, m, d, 12).getTime();
  const addDays = (ms, n) => { const d = new Date(ms); d.setDate(d.getDate() + n); return d.getTime(); };
  const P = ['Bereishis', 'Noach', 'Lech Lecha', 'Vayeira', 'Chayei Sarah', 'Toldos', 'Vayeitzei', 'Vayishlach', 'Vayeishev', 'Mikeitz', 'Vayigash', 'Vayechi',
    'Shemos', "Va'eira", 'Bo', 'Beshalach', 'Yisro', 'Mishpatim', 'Terumah', 'Tetzaveh', 'Ki Sisa', 'Vayakhel', 'Pekudei',
    'Vayikra', 'Tzav', 'Shemini', 'Tazria', 'Metzora', 'Acharei Mos', 'Kedoshim', 'Emor', 'Behar', 'Bechukosai',
    'Bamidbar', 'Nasso', "Beha'aloscha", "Shelach", 'Korach', 'Chukas', 'Balak', 'Pinchas', 'Matos', 'Masei',
    'Devarim', "Va'eschanan", 'Eikev', "Re'eh", 'Shoftim', 'Ki Seitzei', 'Ki Savo', 'Nitzavim', 'Vayeilech', "Ha'azinu"];
  function findHebrew(y, approxMonth, raw, day, year) {
    for (let i = 0; i < 70; i++) { const ms = noonOf(y, approxMonth, 1 + i); const p = Hb.parts(ms); if (p.raw === raw && p.day === day && p.year === year) return ms; }
    throw new Error('not found ' + raw + day + ' ' + year);
  }
  const roshHashana = Y => findHebrew(Y - 3761, 7, 'Tishri', 1, Y); // Aug 1 onward (Sept 5 – Oct 5)
  const isYomTovShabbat = ms => Hb.holidays(ms).some(h => h.kind === 'yomtov' || /^Chol Hamoed/.test(h.name));
  function shabbatotBetween(from, to) { // inclusive from, exclusive to
    const out = []; let d = from; while (new Date(d).getDay() !== 6) d = addDays(d, 1);
    for (; d < to; d = addDays(d, 7)) out.push(d);
    return out;
  }
  const cache = new Map();
  function schedule(Y) {
    if (cache.has(Y)) return cache.get(Y);
    const rh = roshHashana(Y), rhNext = roshHashana(Y + 1);
    const leap = (rhNext - rh) / DAY > 380;
    const map = new Map();
    const key = ms => new Date(ms).toDateString();
    // Tishrei, before Bereishis: Vayeilech (if read separately) and Ha'azinu, on Shabbosos that aren't Yom Tov.
    const tishrei = Y2 => { const r = roshHashana(Y2); return shabbatotBetween(r, addDays(r, 23)).filter(s => !isYomTovShabbat(s)); };
    const segC = tishrei(Y);
    (segC.length >= 2 ? ['Vayeilech', "Ha'azinu"] : ["Ha'azinu"]).forEach((n, i) => segC[i] && map.set(key(segC[i]), [n]));
    // Bereishis through Nitzavim: every Shabbos from after Simchas Torah to before next Rosh Hashana that isn't Yom Tov.
    const slots = shabbatotBetween(addDays(rh, 23), rhNext).filter(s => !isYomTovShabbat(s));
    const need = 51 - slots.length;
    // Which pairs are read together. When the second day of Shavuos is Shabbos, Chukas-Balak is joined (diaspora).
    const shav2 = findHebrew(new Date(rh).getFullYear() + 1, 4, 'Sivan', 7, Y);
    const chosen = [];
    if (new Date(shav2).getDay() === 6) chosen.push(38);
    const order = leap ? [41, 31, 21, 26, 28] : [26, 28, 31, 41, 21];
    for (const p of order) { if (chosen.length >= need) break; if (!chosen.includes(p)) chosen.push(p); }
    assign(slots, 0, 51, chosen.slice(0, Math.max(0, need)), map, key);
    if (tishrei(Y + 1).length < 2 && slots.length) map.set(key(slots[slots.length - 1]), ['Nitzavim', 'Vayeilech']);
    cache.set(Y, map);
    return map;
  }
  function assign(shabbatot, start, end, firsts, map, key) {
    const joined = new Set(firsts);
    let s = 0;
    for (let i = start; i < end; i++) {
      const names = joined.has(i) ? [P[i], P[i + 1]] : [P[i]];
      if (joined.has(i)) i++;
      if (shabbatot[s]) map.set(key(shabbatot[s]), names);
      s++;
    }
    if (s !== shabbatot.length) throw new Error(`parsha count mismatch ${s} vs ${shabbatot.length}`);
  }
  // The parsha read on the Shabbos of this week (the coming Shabbos, or today if it's Shabbos). Null on a Yom Tov Shabbos.
  function parsha(ms) {
    let s = noonOf(new Date(ms).getFullYear(), new Date(ms).getMonth(), new Date(ms).getDate());
    while (new Date(s).getDay() !== 6) s = addDays(s, 1);
    const Y = Hb.parts(s).year;
    const names = schedule(Y).get(new Date(s).toDateString());
    return names ? names.join('-') : null;
  }

  // ---------- Daf Yomi ----------
  const SHAS = [['Berachos', 64], ['Shabbos', 157], ['Eruvin', 105], ['Pesachim', 121], ['Shekalim', 22], ['Yoma', 88], ['Sukkah', 56], ['Beitzah', 40],
    ['Rosh Hashana', 35], ['Taanis', 31], ['Megillah', 32], ['Moed Katan', 29], ['Chagigah', 27], ['Yevamos', 122], ['Kesubos', 112], ['Nedarim', 91],
    ['Nazir', 66], ['Sotah', 49], ['Gittin', 90], ['Kiddushin', 82], ['Bava Kamma', 119], ['Bava Metzia', 119], ['Bava Basra', 176], ['Sanhedrin', 113],
    ['Makkos', 24], ['Shevuos', 49], ['Avodah Zarah', 76], ['Horayos', 14], ['Zevachim', 120], ['Menachos', 110], ['Chullin', 142], ['Bechoros', 61],
    ['Arachin', 34], ['Temurah', 34], ['Kerisos', 28], ['Meilah', 22], ['Kinnim', 4], ['Tamid', 10], ['Middos', 4], ['Niddah', 73]];
  const CYCLE = SHAS.reduce((n, m) => n + m[1] - 1, 0);
  const START = Date.UTC(2020, 0, 5); // Berachos 2, cycle 14
  function dafYomi(ms) {
    const d = new Date(ms), day = Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - START) / DAY);
    let n = ((day % CYCLE) + CYCLE) % CYCLE, total = 0;
    for (let i = 0; i < SHAS.length; i++) {
      total += SHAS[i][1] - 1;
      if (n < total) {
        let daf = SHAS[i][1] + 1 - (total - n);
        if (i === 36) daf += 21; else if (i === 37) daf += 24; else if (i === 38) daf += 33;
        return { masechta: SHAS[i][0], daf };
      }
    }
  }

  return { supported, parts, gematria, format, formatEnglish, dayLetters, hebrewMonthName, holidays, parsha, dafYomi, PARSHIYOS: P, SHAS };
});
