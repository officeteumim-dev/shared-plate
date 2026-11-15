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

  // ---------- Shabbos and Yom Tov: no notifications ----------
  // Sunset from the classic almanac formula, for a place picked from the person's time zone. The quiet period runs
  // from an hour before sunset on Friday or Erev Yom Tov until 1½ hours after sunset when it ends, which leaves a wide
  // margin for candle lighting, nightfall and where in the time zone they live.
  const ZONES = {
    'America/New_York': [40.71, -74.01], 'America/Detroit': [42.33, -83.05], 'America/Toronto': [43.65, -79.38],
    'America/Chicago': [41.88, -87.63], 'America/Denver': [39.74, -104.99], 'America/Phoenix': [33.45, -112.07],
    'America/Los_Angeles': [34.05, -118.24], 'America/Montreal': [45.50, -73.57], 'America/Halifax': [44.65, -63.57],
    'Asia/Jerusalem': [31.78, 35.22], 'Europe/London': [51.51, -0.13], 'Europe/Paris': [48.86, 2.35],
    'Europe/Antwerp': [51.22, 4.40], 'Europe/Brussels': [50.85, 4.35], 'Australia/Melbourne': [-37.81, 144.96],
    'America/Sao_Paulo': [-23.55, -46.63], 'America/Argentina/Buenos_Aires': [-34.60, -58.38], 'Africa/Johannesburg': [-26.20, 28.05]
  };
  function zoneOffsetMin(tz, ms) {
    try {
      const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(new Date(ms)).reduce((o, x) => { o[x.type] = +x.value; return o; }, {});
      return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute) - Math.floor(ms / 60000) * 60000) / 60000);
    } catch (e) { return 0; }
  }
  // A place for a time zone: a known city, or a guess from its UTC offset (latitude 40°).
  function placeFor(tz) {
    if (ZONES[tz]) return ZONES[tz];
    return [40, Math.max(-180, Math.min(180, zoneOffsetMin(tz, Date.now()) / 4))];
  }
  // Sunset (ms, UTC) on the civil date y-m-d (month 1–12) at lat/lon.
  function sunset(y, m, d, lat, lon) {
    const rad = Math.PI / 180, deg = 180 / Math.PI;
    const N = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 0)) / 864e5);
    const lngHour = lon / 15, t = N + ((18 - lngHour) / 24);
    const M = 0.9856 * t - 3.289;
    let L = M + 1.916 * Math.sin(M * rad) + 0.020 * Math.sin(2 * M * rad) + 282.634;
    L = ((L % 360) + 360) % 360;
    let RA = deg * Math.atan(0.91764 * Math.tan(L * rad));
    RA = ((RA % 360) + 360) % 360;
    RA = (RA + (Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90)) / 15;
    const sinDec = 0.39782 * Math.sin(L * rad), cosDec = Math.cos(Math.asin(sinDec));
    const cosH = (Math.cos(90.833 * rad) - sinDec * Math.sin(lat * rad)) / (cosDec * Math.cos(lat * rad));
    const H = (cosH > 1 ? 0 : cosH < -1 ? 180 : deg * Math.acos(cosH)) / 15;
    const T = H + RA - 0.06571 * t - 6.622;
    const UT = (((T - lngHour) % 24) + 24) % 24;
    let ms = Date.UTC(y, m - 1, d) + UT * 3600e3;
    if (ms < Date.UTC(y, m - 1, d, 12) - lngHour * 3600e3) ms += 864e5; // sunset is in the afternoon, local time
    return ms;
  }
  // The civil date in tz for an instant: { y, m, d }.
  function localYMD(ms, tz) {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(ms)).reduce((o, x) => { o[x.type] = +x.value; return o; }, {});
    return { y: p.year, m: p.month, d: p.day };
  }
  const BEFORE = 60 * 60000, AFTER = 90 * 60000;
  // Is the civil date (y, m, d) Shabbos or a day of Yom Tov (diaspora)?
  function restDay(y, m, d) {
    const noonUtc = Date.UTC(y, m - 1, d, 12);
    if (new Date(noonUtc).getUTCDay() === 6) return true;
    // holidays() reads the date in the machine's time zone, so give it local noon of that date.
    return holidays(new Date(y, m - 1, d, 12).getTime()).some(h => h.kind === 'yomtov');
  }
  // If notifications must wait at this moment, when they can go out again (ms); otherwise null.
  function restUntil(ms, tz) {
    const [lat, lon] = placeFor(tz);
    const { y, m, d } = localYMD(ms, tz);
    const day = k => { const x = new Date(Date.UTC(y, m - 1, d + k)); return [x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate()]; };
    const today = day(0), tomorrow = day(1);
    const startsTonight = restDay(...tomorrow) && ms >= sunset(...today, lat, lon) - BEFORE;
    const stillOn = restDay(...today) && ms < sunset(...today, lat, lon) + AFTER;
    if (!startsTonight && !stillOn) return null;
    // Walk forward to the last day of this Shabbos / Yom Tov.
    let k = restDay(...today) ? 0 : 1;
    while (restDay(...day(k + 1)) && k < 4) k++;
    return sunset(...day(k), lat, lon) + AFTER;
  }

  return { supported, parts, gematria, format, formatEnglish, dayLetters, hebrewMonthName, holidays, parsha, dafYomi, PARSHIYOS: P, SHAS,
    sunset, placeFor, restUntil, restDay, localYMD };
});
