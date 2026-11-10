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

  return { supported, parts, gematria, format, formatEnglish, dayLetters, hebrewMonthName, holidays };
});
