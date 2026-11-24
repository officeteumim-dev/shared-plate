// Checks the Gemini adapter (functions/gemini.js): Anthropic-shaped requests in, Gemini generateContent out, and back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const G = require('../functions/gemini.js');
const A = require('../functions/assistant.js');
const L = require('../public/logic.js');

test('tools become function declarations Gemini accepts', () => {
  const body = G.toRequest({ system: 'sys', messages: [{ role: 'user', content: 'hi' }], tools: A.TOOLS });
  assert.deepEqual(body.systemInstruction, { parts: [{ text: 'sys' }] });
  assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: 'hi' }] }]);
  const decls = body.tools[0].functionDeclarations;
  assert.equal(decls.length, A.TOOLS.length);
  const add = decls.find(d => d.name === 'add_task');
  assert.equal(add.parameters.type, 'object');
  assert.deepEqual(add.parameters.required, ['title']);
  assert.ok(add.parameters.properties.repeat.enum.includes('weekly'));
  // No JSON Schema extras Gemini's schema subset rejects, and no empty parameters for no-argument tools.
  assert.ok(!JSON.stringify(decls).includes('additionalProperties'));
  assert.equal(decls.find(d => d.name === 'get_household').parameters, undefined);
});

test('a function call comes back as tool_use, and goes back with its thought signature and result', () => {
  const r = G.fromResponse({ candidates: [{ content: { role: 'model', parts: [
    { functionCall: { name: 'add_task', args: { title: 'Dentist' } }, thoughtSignature: 'SIG-A' }
  ] }, finishReason: 'STOP' }] });
  assert.equal(r.stop_reason, 'tool_use');
  const use = r.content[0];
  assert.equal(use.name, 'add_task');
  assert.deepEqual(use.input, { title: 'Dentist' });
  const body = G.toRequest({ system: 's', tools: [], messages: [
    { role: 'user', content: 'dentist' },
    { role: 'assistant', content: r.content },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: use.id, content: 'Added: Dentist' }] }
  ] });
  assert.deepEqual(body.contents[1], { role: 'model', parts: [{ functionCall: { name: 'add_task', args: { title: 'Dentist' } }, thoughtSignature: 'SIG-A' }] });
  assert.deepEqual(body.contents[2], { role: 'user', parts: [{ functionResponse: { name: 'add_task', response: { result: 'Added: Dentist' } } }] });
});

test('errors go back as errors; text answers end the turn; thinking summaries are dropped', () => {
  const body = G.toRequest({ system: 's', tools: [], messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'take_task', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'No such task', is_error: true }] }
  ] });
  assert.deepEqual(body.contents[1].parts[0].functionResponse, { name: 'take_task', response: { error: 'No such task' } });
  const r = G.fromResponse({ candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: 'Added it.', thoughtSignature: 'S' }] } }] });
  assert.equal(r.stop_reason, 'end_turn');
  assert.deepEqual(r.content, [{ type: 'text', text: 'Added it.', _sig: 'S' }]);
  assert.match(G.fromResponse({ promptFeedback: { blockReason: 'SAFETY' } }).content[0].text, /can’t help/);
});

test('the whole assistant loop runs on Gemini through the adapter', async () => {
  const tasks = new Map();
  const store = { async list() { return []; }, async get() { return null; }, async add(d) { tasks.set('n1', d); return 'n1'; }, async update() {} };
  const ctx = { uid: 'avi', group: { name: 'Home', members: { avi: 'owner' }, names: { avi: 'Avi' } }, tz: 'America/New_York', now: Date.parse('2026-11-24T07:00:00-05:00'), store, L };
  const sent = [];
  const replies = [
    { candidates: [{ content: { parts: [{ functionCall: { name: 'add_task', args: { title: 'Buy flowers', due: '2026-11-27' } }, thoughtSignature: 'A' }] } }] },
    { candidates: [{ content: { parts: [{ text: 'Added Buy flowers for Friday.' }] } }] }
  ];
  const post = async (url, headers, body) => { sent.push({ url, headers, body }); return { ok: true, status: 200, json: replies.shift() }; };
  const out = await A.run({ history: [], text: 'flowers friday', ctx, callModel: G.caller({ key: 'K', model: 'gemini-3.8-flash', post }) });
  assert.equal(out.reply, 'Added Buy flowers for Friday.');
  assert.equal(tasks.get('n1').title, 'Buy flowers');
  assert.match(sent[0].url, /models\/gemini-3\.8-flash:generateContent$/);
  assert.equal(sent[0].headers['x-goog-api-key'], 'K');
  assert.equal(sent[1].body.contents[1].parts[0].thoughtSignature, 'A');
  await assert.rejects(G.caller({ key: 'K', model: 'm', post: async () => ({ ok: false, status: 429, json: {} }) })({ system: '', messages: [], tools: [] }), e => e.status === 429);
});
