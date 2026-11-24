// Hours: time worked for clients, by who did the work. Pure functions shared by the app (window.Hours), the server
// (functions/hours.js, copied at deploy) and the tests.
//
// A client lives on the household: groups/<g>.clients[<id>] = { name, rate (per hour, optional), archived }.
// An entry: groups/<g>/hours/<id> = { client, who (uid), date 'YYYY-MM-DD', minutes, note, startedAt (ms, while a
// timer runs; minutes is then null), createdBy, createdAt, updatedAt }.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Hours = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // "1.5", "1:30", "90m", "1h 30m", "1h", "2 hours", "45 min" → minutes (whole), or null if it can't be read.
  function parseDuration(s) {
    const t = String(s == null ? '' : s).trim().toLowerCase().replace(/,/g, '.');
    if (!t) return null;
    let m;
    if ((m = /^(\d{1,3}):([0-5]?\d)$/.exec(t))) return clamp(+m[1] * 60 + +m[2]);
    if ((m = /^(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours)?$/.exec(t))) return clamp(Math.round(parseFloat(m[1]) * 60));
    if ((m = /^(\d+)\s*(m|min|mins|minute|minutes)$/.exec(t))) return clamp(+m[1]);
    if ((m = /^(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hours?)\s*(?:and\s*)?(\d+)\s*(?:m|min|mins|minutes?)?$/.exec(t))) return clamp(Math.round(parseFloat(m[1]) * 60) + +m[2]);
    return null;
  }
  const clamp = n => (n > 0 && n <= 24 * 60 ? n : null);

  function fmtDuration(min) {
    min = Math.max(0, Math.round(min || 0));
    const h = Math.floor(min / 60), m = min % 60;
    return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
  }
  const decimalHours = min => Math.round((min || 0) / 60 * 100) / 100;
  const money = n => '$' + (Math.round(n * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // Dates are 'YYYY-MM-DD' strings in the household's local time.
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseYmd = s => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
  function localYmd(ms, tz) {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
    const g = t => p.find(x => x.type === t).value;
    return `${g('year')}-${g('month')}-${g('day')}`;
  }

  // Periods: { key, label, from, to } with `to` exclusive. Weeks start on Sunday.
  const PERIODS = ['week', 'lastweek', 'month', 'lastmonth', 'year'];
  function period(key, today) {
    const d = parseYmd(today);
    if (key === 'week' || key === 'lastweek') {
      const from = addDays(today, -d.getDay() - (key === 'lastweek' ? 7 : 0));
      return { key, label: key === 'week' ? 'This week' : 'Last week', from, to: addDays(from, 7) };
    }
    if (key === 'month' || key === 'lastmonth') {
      const f = new Date(d.getFullYear(), d.getMonth() - (key === 'lastmonth' ? 1 : 0), 1);
      const t = new Date(f.getFullYear(), f.getMonth() + 1, 1);
      return { key, label: key === 'month' ? 'This month' : 'Last month', from: ymd(f), to: ymd(t) };
    }
    const y = d.getFullYear();
    return { key: 'year', label: String(y), from: `${y}-01-01`, to: `${y + 1}-01-01` };
  }
  const inPeriod = (e, p) => e.date >= p.from && e.date < p.to;

  // Minutes an entry counts for: its minutes, or for a running timer the time so far.
  const minutesOf = (e, now) => (e.startedAt ? Math.max(0, Math.round((now - e.startedAt) / 60000)) : e.minutes || 0);

  // Totals for entries (already filtered): per client → per person, per person, overall; with money where there's a rate.
  function summarize(entries, clients, now) {
    const byClient = {}, byWho = {};
    let total = 0, amount = 0;
    for (const e of entries) {
      const min = minutesOf(e, now);
      const c = byClient[e.client] || (byClient[e.client] = { minutes: 0, byWho: {}, amount: 0 });
      c.minutes += min; c.byWho[e.who] = (c.byWho[e.who] || 0) + min;
      byWho[e.who] = (byWho[e.who] || 0) + min;
      total += min;
    }
    for (const [id, c] of Object.entries(byClient)) {
      const rate = clients[id] && Number(clients[id].rate);
      if (rate > 0) { c.amount = rate * c.minutes / 60; amount += c.amount; }
    }
    return { byClient, byWho, total, amount };
  }

  const csvCell = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  function csv(entries, clients, names, now) {
    const rows = [['Date', 'Client', 'Who', 'Hours', 'Duration', 'Rate', 'Amount', 'Note']];
    for (const e of entries.slice().sort((a, b) => a.date.localeCompare(b.date))) {
      const min = minutesOf(e, now), c = clients[e.client] || {}, rate = Number(c.rate) > 0 ? Number(c.rate) : '';
      rows.push([e.date, c.name || 'Unknown client', names[e.who] || '', decimalHours(min), fmtDuration(min), rate, rate ? (rate * min / 60).toFixed(2) : '', e.note || '']);
    }
    return rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }

  // A client by name (case and spacing ignored), among those not archived first.
  function findClient(clients, name) {
    const n = String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!n) return null;
    const all = Object.entries(clients || {}).map(([id, c]) => ({ id, ...c }));
    const exact = all.filter(c => String(c.name).trim().toLowerCase().replace(/\s+/g, ' ') === n);
    const pick = list => list.find(c => !c.archived) || list[0] || null;
    if (exact.length) return pick(exact);
    const part = all.filter(c => String(c.name).toLowerCase().includes(n));
    const live = part.filter(c => !c.archived), pool = live.length ? live : part;
    return pool.length === 1 || (pool.length && pool.every(c => c.name.toLowerCase() === pool[0].name.toLowerCase())) ? pool[0] : null;
  }

  return { parseDuration, fmtDuration, decimalHours, money, period, PERIODS, inPeriod, minutesOf, summarize, csv, findClient, localYmd, addDays };
});
