// Checks the Claude connector (functions/mcp.js) against a fake household, without Firebase.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const mcp = require('../functions/mcp.js');
const L = require('../public/logic.js');

const NOW = Date.parse('2026-11-09T22:00:00-05:00'); // Monday night in New York
function household(uid = 'avi') {
  const tasks = new Map([
    ['t1', { title: 'Call the plumber', owner: 'shared', claimedBy: null, status: 'open', repeat: 'none' }],
    ['t2', { title: 'Do the dishes', owner: 'shared', claimedBy: 'leah', status: 'open', repeat: 'daily', dueAt: Date.parse('2026-11-09T20:00:00-05:00') }],
    ['t3', { title: 'Renew registration', owner: 'avi', status: 'open', repeat: 'none', category: 'Car', priority: '2', dueAt: Date.parse('2026-11-11T09:00:00-05:00') }]
  ]);
  let n = 0;
  const shop = new Map([['s1', { name: 'Milk', list: 'Groceries', checked: false, addedBy: 'leah' }]]);
  const store = {
    async shopList() { return [...shop].map(([id, x]) => ({ id, ...x })); },
    async shopGet(id) { return shop.has(id) ? { id, ...shop.get(id) } : null; },
    async shopAdd(d) { const id = 's' + (shop.size + 1); shop.set(id, { ...d }); return id; },
    async shopUpdate(id, p) { shop.set(id, { ...shop.get(id), ...p }); },
    async shopDelete(id) { shop.delete(id); },
    async list() { return [...tasks].map(([id, t]) => ({ id, ...t })); },
    async get(id) { return tasks.has(id) ? { id, ...tasks.get(id) } : null; },
    async add(d) { const id = 'n' + (++n); tasks.set(id, { ...d }); return id; },
    async update(id, p) { tasks.set(id, { ...tasks.get(id), ...p }); }
  };
  const group = { name: 'Our home', members: { avi: 'owner', leah: 'member' }, names: { avi: 'Avi', leah: 'Leah' } };
  return { tasks, shop, ctx: { uid, group, tz: 'America/New_York', now: NOW, store, L } };
}
const call = async (ctx, name, args) => {
  const r = await mcp.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, ctx);
  return { text: r.result.content[0].text, error: !!r.result.isError };
};

test('the handshake and the tool list', async () => {
  const { ctx } = household();
  const init = await mcp.handleMessage({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude' } } }, ctx);
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.ok(init.result.capabilities.tools);
  assert.equal(await mcp.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx), null);
  const list = await mcp.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, ctx);
  assert.deepEqual(list.result.tools.map(t => t.name), ['get_household', 'list_tasks', 'add_task', 'update_task', 'complete_task', 'add_shopping_items', 'list_shopping', 'update_shopping_item', 'take_task']);
  const unknown = await mcp.handleMessage({ jsonrpc: '2.0', id: 3, method: 'resources/list' }, ctx);
  assert.equal(unknown.error.code, -32601);
});

test('add a reminder for Leah at a local time', async () => {
  const { ctx, tasks } = household();
  const r = await call(ctx, 'add_task', { title: 'Call the bank', owner: 'Leah', due: '2026-11-10T10:00', category: 'House', priority: '1' });
  assert.equal(r.error, false);
  assert.match(r.text, /Call the bank — Leah, due Tue, Nov 10, 10:00 AM/);
  const t = tasks.get('n1');
  assert.equal(t.owner, 'leah');
  assert.equal(t.dueAt, Date.parse('2026-11-10T15:00:00Z'));
  assert.equal(t.notifyAt, t.dueAt, 'a reminder is scheduled');
  assert.equal(t.createdBy, 'avi');
});

test('“me” means whoever owns the link', async () => {
  const { ctx, tasks } = household('leah');
  await call(ctx, 'add_task', { title: 'Book camp' });
  assert.equal(tasks.get('n1').owner, 'leah');
  assert.match(await call(ctx, 'get_household', {}).then(r => r.text), /Me: Leah/);
});

test('a date with no time means 9am local; clock changes are handled', async () => {
  assert.equal(mcp.parseWhen('2026-11-10', 'America/New_York'), Date.parse('2026-11-10T14:00:00Z'));
  assert.equal(mcp.parseWhen('2026-07-01T19:30', 'America/New_York'), Date.parse('2026-07-01T23:30:00Z'));
  assert.equal(mcp.parseWhen('2026-11-10T10:00:00Z', 'America/New_York'), Date.parse('2026-11-10T10:00:00Z'));
});

test('listing shows ids, owners and filters', async () => {
  const { ctx } = household();
  const all = (await call(ctx, 'list_tasks', {})).text;
  assert.match(all, /3 open tasks/);
  assert.match(all, /\[t3\] \(2\) Renew registration — Avi \(me\), due Wed, Nov 11, 9:00 AM, Car/);
  assert.match((await call(ctx, 'list_tasks', { who: 'shared' })).text, /1 open task for shared/);
  assert.match((await call(ctx, 'list_tasks', { who: 'Leah' })).text, /Do the dishes/);
});

test('finishing a shared daily task Leah took puts tomorrow’s back on Shared, unclaimed', async () => {
  const { ctx, tasks } = household('leah');
  const r = await call(ctx, 'complete_task', { task_id: 't2' });
  assert.match(r.text, /Next one: Tue, Nov 10, 8:00 PM, on the Shared plate/);
  assert.equal(tasks.get('t2').status, 'done');
  const next = tasks.get(tasks.get('t2').nextId);
  assert.equal(next.owner, 'shared');
  assert.equal(next.claimedBy, null);
});

test('take, snooze and update', async () => {
  const { ctx, tasks } = household();
  assert.match((await call(ctx, 'take_task', { task_id: 't1' })).text, /It’s yours now/);
  assert.equal(tasks.get('t1').claimedBy, 'avi');
  await call(ctx, 'update_task', { task_id: 't3', snooze_until: '2026-11-12' });
  assert.equal(tasks.get('t3').status, 'snoozed');
  assert.equal(tasks.get('t3').showAgainOn, Date.parse('2026-11-12T13:00:00Z'));
  await call(ctx, 'update_task', { task_id: 't3', title: 'Renew car registration', owner: 'shared' });
  assert.equal(tasks.get('t3').title, 'Renew car registration');
  assert.equal(tasks.get('t3').owner, 'shared');
});

test('mistakes come back as clear messages, not failures', async () => {
  const { ctx } = household();
  assert.match((await call(ctx, 'add_task', { title: 'X', owner: 'Moshe' })).text, /No one called "Moshe"/);
  assert.match((await call(ctx, 'add_task', { title: 'X', repeat: 'daily' })).text, /needs a due date/);
  assert.match((await call(ctx, 'complete_task', { task_id: 'nope' })).text, /no task with id/);
  assert.match((await call(ctx, 'add_task', { title: 'X', due: 'next tuesday' })).text, /couldn't read the date/);
  assert.equal((await call(ctx, 'add_task', { title: '' })).error, true);
});


test('shopping: add (skipping ones already there), list, check off, move and remove', async () => {
  const { ctx, shop } = household();
  assert.match((await call(ctx, 'add_shopping_items', { items: ['milk', 'eggs', 'bread'] })).text, /Added to Groceries: eggs, bread\. \(1 already on the list\.\)/);
  assert.match((await call(ctx, 'add_shopping_items', { items: ['phone charger'], list: 'Amazon' })).text, /Added to Amazon/);
  const list = (await call(ctx, 'list_shopping', {})).text;
  assert.match(list, /Groceries \(3 to get\)/);
  assert.match(list, /Amazon \(1 to get\)/);
  assert.match((await call(ctx, 'update_shopping_item', { item_id: 's1', checked: true })).text, /Milk: checked off, on Groceries/);
  assert.equal(shop.get('s1').checkedBy, 'avi');
  assert.match((await call(ctx, 'update_shopping_item', { item_id: 's2', list: 'Costco' })).text, /on Costco/);
  assert.match((await call(ctx, 'update_shopping_item', { item_id: 's3', remove: true })).text, /Removed bread/);
  assert.equal(shop.has('s3'), false);
  assert.match((await call(ctx, 'update_shopping_item', { item_id: 'zz' })).text, /no shopping item/);
});
