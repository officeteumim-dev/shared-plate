// Checks public/hours.js and the Hours connector tools (log_time, hours_summary).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const H = require('../public/hours.js');
const mcp = require('../functions/mcp.js');
const L = require('../public/logic.js');

test('reads durations the way people type them', () => {
  const cases = { '1.5': 90, '1:30': 90, '0:45': 45, '90m': 90, '45 min': 45, '2': 120, '2 hours': 120, '1h 30m': 90, '1h30': 90, '1 hr 5 min': 65, '1,25': 75, '24': 1440 };
  for (const [s, m] of Object.entries(cases)) assert.equal(H.parseDuration(s), m, s);
  for (const bad of ['', 'abc', '0', '25', '-1', '1:75', 'later']) assert.equal(H.parseDuration(bad), null, bad);
  assert.equal(H.fmtDuration(90), '1h 30m');
  assert.equal(H.fmtDuration(120), '2h');
  assert.equal(H.fmtDuration(5), '5m');
  assert.equal(H.money(1234.5), '$1,234.50');
});

test('periods: weeks start on Sunday; months and the year', () => {
  assert.deepEqual(H.period('week', '2026-11-24'), { key: 'week', label: 'This week', from: '2026-11-22', to: '2026-11-29' });
  assert.deepEqual(H.period('week', '2026-11-22'), { key: 'week', label: 'This week', from: '2026-11-22', to: '2026-11-29' });
  assert.equal(H.period('lastweek', '2026-11-24').from, '2026-11-15');
  assert.deepEqual(H.period('month', '2026-11-24'), { key: 'month', label: 'This month', from: '2026-11-01', to: '2026-12-01' });
  assert.deepEqual(H.period('lastmonth', '2026-01-10'), { key: 'lastmonth', label: 'Last month', from: '2025-12-01', to: '2026-01-01' });
  assert.deepEqual(H.period('year', '2026-11-24'), { key: 'year', label: '2026', from: '2026-01-01', to: '2027-01-01' });
  assert.equal(H.localYmd(Date.parse('2026-11-25T03:00:00Z'), 'America/New_York'), '2026-11-24');
});

test('totals per client and person, money where there is a rate, running timers counted so far', () => {
  const clients = { c1: { name: 'Acme', rate: 80 }, c2: { name: 'Bright' } };
  const now = Date.parse('2026-11-24T12:00:00Z');
  const entries = [
    { client: 'c1', who: 'a', date: '2026-11-24', minutes: 90 },
    { client: 'c1', who: 'b', date: '2026-11-23', minutes: 30 },
    { client: 'c2', who: 'b', date: '2026-11-23', minutes: 60 },
    { client: 'c2', who: 'a', date: '2026-11-24', minutes: null, startedAt: now - 45 * 60000 }
  ];
  const s = H.summarize(entries, clients, now);
  assert.equal(s.total, 225);
  assert.deepEqual(s.byWho, { a: 135, b: 90 });
  assert.equal(s.byClient.c1.minutes, 120);
  assert.equal(s.byClient.c1.amount, 160);
  assert.equal(s.byClient.c2.amount, 0);
  assert.equal(s.amount, 160);
  const csv = H.csv(entries.slice(0, 2).map((e, i) => ({ ...e, note: i ? 'Calls, "urgent"' : '' })), clients, { a: 'Avi', b: 'Leah' }, now);
  assert.equal(csv, 'Date,Client,Who,Hours,Duration,Rate,Amount,Note\r\n2026-11-23,Acme,Leah,0.5,30m,80,40.00,"Calls, ""urgent"""\r\n2026-11-24,Acme,Avi,1.5,1h 30m,80,120.00,\r\n');
});

test('finds clients by name, ignoring case and spacing; partial names only when unambiguous', () => {
  const clients = { c1: { name: 'Acme Dental' }, c2: { name: 'Acme Realty' }, c3: { name: 'Cohen & Co' }, c4: { name: 'Cohen & Co', archived: true } };
  assert.equal(H.findClient(clients, 'acme  dental').id, 'c1');
  assert.equal(H.findClient(clients, 'acme'), null);
  assert.equal(H.findClient(clients, 'cohen').id, 'c3');
  assert.equal(H.findClient(clients, 'COHEN & CO').id, 'c3');
  assert.equal(H.findClient(clients, ''), null);
});

const NOW = Date.parse('2026-11-24T22:00:00-05:00');
function household() {
  const hours = new Map(), group = { name: 'Home', members: { avi: 'owner', leah: 'member' }, names: { avi: 'Avi', leah: 'Leah' }, clients: { c1: { name: 'Acme Dental', rate: 100 } } };
  let n = 0;
  const store = {
    async hoursAdd(d) { const id = 'h' + (++n); hours.set(id, d); return id; },
    async hoursList(from) { return [...hours].map(([id, e]) => ({ id, ...e })).filter(e => e.date >= from); },
    async addClient(id, d) { group.clients[id] = d; }
  };
  return { hours, group, ctx: { uid: 'avi', group, tz: 'America/New_York', now: NOW, store, L } };
}
const call = async (ctx, name, args) => {
  const r = await mcp.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, ctx);
  return { text: r.result.content[0].text, error: !!r.result.isError };
};

test('Claude can log hours for me or the other person, and new clients only when asked', async () => {
  const { hours, group, ctx } = household();
  let r = await call(ctx, 'log_time', { client: 'acme dental', duration: '1:30', note: 'Site fixes' });
  assert.equal(r.text, 'Logged 1h 30m for Acme Dental by Avi (me) on 2026-11-24.');
  assert.deepEqual({ ...hours.get('h1'), createdAt: 0, updatedAt: 0 }, { client: 'c1', who: 'avi', date: '2026-11-24', minutes: 90, note: 'Site fixes', startedAt: null, createdBy: 'avi', createdAt: 0, updatedAt: 0 });
  r = await call(ctx, 'log_time', { client: 'Acme Dental', duration: '2', who: 'Leah', date: '2026-11-23' });
  assert.match(r.text, /2h for Acme Dental by Leah on 2026-11-23/);
  r = await call(ctx, 'log_time', { client: 'Brightside', duration: '1' });
  assert.equal(r.error, true);
  assert.match(r.text, /No client called "Brightside". Clients: Acme Dental/);
  r = await call(ctx, 'log_time', { client: 'Brightside', duration: '45m', new_client: true });
  assert.equal(r.error, false);
  assert.ok(Object.values(group.clients).some(c => c.name === 'Brightside'));
  for (const bad of [{ client: 'Acme Dental', duration: 'a while' }, { client: 'Acme Dental', duration: '1', who: 'shared' }, { client: 'Acme Dental', duration: '1', date: 'Tuesday' }]) {
    assert.equal((await call(ctx, 'log_time', bad)).error, true, JSON.stringify(bad));
  }
});

test('Claude can read the week’s hours per client and person, with amounts', async () => {
  const { ctx } = household();
  await call(ctx, 'log_time', { client: 'Acme Dental', duration: '1.5' });
  await call(ctx, 'log_time', { client: 'Acme Dental', duration: '30m', who: 'Leah' });
  await call(ctx, 'log_time', { client: 'Acme Dental', duration: '3', date: '2026-10-01' });
  const r = await call(ctx, 'hours_summary', {});
  assert.match(r.text, /^This week \(2026-11-22 to 2026-11-28\): 2h, \$200\.00/);
  assert.match(r.text, /Acme Dental: 2h \(\$200\.00\) — Avi \(me\) 1h 30m, Leah 30m/);
  assert.match(r.text, /Clients: Acme Dental \(\$100\.00\/hr\)/);
  assert.match((await call(ctx, 'hours_summary', { period: 'year' })).text, /: 5h, \$500\.00/);
  assert.equal((await call(ctx, 'hours_summary', { client: 'Nobody' })).error, true);
});
