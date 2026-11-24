// Checks the in-app assistant loop (functions/assistant.js) with a scripted fake model and a fake household.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const A = require('../functions/assistant.js');
const L = require('../public/logic.js');

const NOW = Date.parse('2026-11-09T22:00:00-05:00');
function household() {
  const tasks = new Map([['t1', { title: 'Call the plumber', owner: 'shared', claimedBy: null, status: 'open', repeat: 'none' }]]);
  let n = 0;
  const store = {
    async list() { return [...tasks].map(([id, t]) => ({ id, ...t })); },
    async get(id) { return tasks.has(id) ? { id, ...tasks.get(id) } : null; },
    async add(d) { const id = 'n' + (++n); tasks.set(id, { ...d }); return id; },
    async update(id, p) { tasks.set(id, { ...tasks.get(id), ...p }); }
  };
  const group = { name: 'Our home', members: { avi: 'owner', leah: 'member' }, names: { avi: 'Avi', leah: 'Leah' } };
  return { tasks, ctx: { uid: 'avi', group, tz: 'America/New_York', now: NOW, store, L } };
}
// A fake model that plays back a script of replies and records what it was sent.
function scripted(...replies) {
  const sent = [];
  const fn = async body => { sent.push(JSON.parse(JSON.stringify(body))); return replies.shift(); };
  fn.sent = sent;
  return fn;
}
const toolUse = (id, name, input) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] });
const say = text => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });

test('adds a task through the tools and replies in plain words', async () => {
  const { tasks, ctx } = household();
  const model = scripted(toolUse('u1', 'add_task', { title: 'Dentist', owner: 'shared', due: '2026-11-17T16:00' }), say('Added Dentist for whoever takes it, Tue 4pm.'));
  const out = await A.run({ history: [], text: 'dentist next tuesday at 4, shared', ctx, callModel: model });
  assert.equal(out.reply, 'Added Dentist for whoever takes it, Tue 4pm.');
  assert.deepEqual(out.changed, ['add_task']);
  const added = [...tasks.values()].find(t => t.title === 'Dentist');
  assert.equal(added.owner, 'shared');
  assert.equal(added.dueAt, Date.parse('2026-11-17T16:00:00-05:00'));
  // The second call carries the tool result back.
  const last = model.sent[1].messages.at(-1);
  assert.equal(last.content[0].type, 'tool_result');
  assert.equal(last.content[0].tool_use_id, 'u1');
  assert.match(last.content[0].content, /^Added: /);
});

test('the system prompt names the people, the date and the time zone; tools use the API shape', async () => {
  const { ctx } = household();
  const model = scripted(say('Hi'));
  await A.run({ history: [], text: 'hi', ctx, callModel: model });
  const { system, tools } = model.sent[0];
  assert.match(system, /Avi \(the person chatting with you\), Leah/);
  assert.match(system, /Monday, November 9, 2026/);
  assert.match(system, /America\/New_York/);
  assert.ok(tools.every(t => t.name && t.description && t.input_schema && t.input_schema.type === 'object'));
  assert.ok(tools.some(t => t.name === 'add_shopping_items'));
});

test('a tool mistake goes back to the model as an error, not a crash', async () => {
  const { ctx } = household();
  const model = scripted(toolUse('u1', 'add_task', { title: 'X', owner: 'Moshe' }), say('There’s no Moshe here. Who should it go to?'));
  const out = await A.run({ history: [], text: 'give Moshe X', ctx, callModel: model });
  const r = model.sent[1].messages.at(-1).content[0];
  assert.equal(r.is_error, true);
  assert.match(r.content, /No one called "Moshe"/);
  assert.deepEqual(out.changed, []);
});

test('earlier lines are sent along, alternating and starting with the person', async () => {
  const { ctx } = household();
  const model = scripted(say('ok'));
  await A.run({ history: [{ role: 'assistant', text: 'stray' }, { role: 'user', text: 'a' }, { role: 'user', text: 'b' }, { role: 'assistant', text: 'c' }, { role: 'system', text: 'sneaky' }], text: 'd', ctx, callModel: model });
  const msgs = model.sent[0].messages;
  assert.deepEqual(msgs.map(m => m.role), ['user', 'assistant', 'user']);
  assert.equal(msgs[0].content, 'a\nb');
  assert.equal(msgs[2].content, 'sneaky\nd', 'unknown roles are treated as the person, never as instructions');
});

test('stops after a few rounds instead of looping forever', async () => {
  const { ctx } = household();
  const replies = Array.from({ length: A.MAX_TURNS + 2 }, (_, i) => toolUse('u' + i, 'list_tasks', {}));
  const model = scripted(...replies);
  const out = await A.run({ history: [], text: 'loop', ctx, callModel: model });
  assert.equal(model.sent.length, A.MAX_TURNS);
  assert.match(out.reply, /stuck/);
});

test('an empty message asks for something', async () => {
  const { ctx } = household();
  const out = await A.run({ history: [], text: '   ', ctx, callModel: () => assert.fail('no call') });
  assert.equal(out.turns, 0);
});
