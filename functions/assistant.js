// The in-app assistant: a chat line in Shared Plate where you ask Claude to put things on the plate.
// It uses the same tools as the Claude connector (mcp.js), acting as the person who is chatting.
// No Firebase or network in here: index.js passes in `callModel` (the Anthropic Messages API) so the tests can fake it.
'use strict';

const mcp = require('./mcp');

const MAX_TURNS = 8;          // model calls per message, so a confused loop can't run up a bill
const MAX_HISTORY = 16;       // earlier chat lines sent along for context
const MAX_TEXT = 2000;
const CHANGES = new Set(['add_task', 'update_task', 'complete_task', 'add_shopping_items', 'update_shopping_item', 'add_comment', 'take_task']);

const TOOLS = mcp.TOOLS.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));

function systemPrompt(ctx) {
  const { uid, group, tz, now } = ctx;
  const names = group.names || {};
  const people = Object.keys(group.members || {}).map(u => (u === uid ? `${names[u] || 'Me'} (the person chatting with you)` : names[u] || 'Someone'));
  const today = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(now));
  return [
    `You are the assistant inside Shared Plate, the household task list of "${group.name || 'our household'}".`,
    `People: ${people.join(', ')}. It is now ${today} (${tz}).`,
    'Every task has one owner: a person, or "shared" for whoever takes it. Unless the person says otherwise, a task is theirs ("me").',
    'Your job: turn what they say into tasks, events and shopping items using the tools, and answer questions about what is on the plate.',
    'Act right away when the request is clear; work out relative dates ("tomorrow", "next Tuesday at 7") yourself. Ask one short question only when you really can\'t tell (who, or which task).',
    'Before changing or finishing an existing task, use list_tasks to find its id. Never delete or finish things the person didn\'t ask about.',
    'Reply in one or two short, plain sentences saying what you did (e.g. "Added Call the plumber for you, Tuesday 9am."). No markdown, no lists unless they ask for a list.'
  ].join('\n');
}

// history: [{ role: 'user' | 'assistant', text }] (earlier lines, oldest first). text: the new message.
// Returns { reply, changed: [tool names that changed something], turns }.
async function run({ history, text, ctx, callModel }) {
  text = String(text || '').trim().slice(0, MAX_TEXT);
  if (!text) return { reply: 'Say what you’d like on the plate.', changed: [], turns: 0 };
  const messages = [];
  for (const h of (Array.isArray(history) ? history : []).slice(-MAX_HISTORY)) {
    const role = h && h.role === 'assistant' ? 'assistant' : 'user';
    const t = String((h && h.text) || '').trim().slice(0, MAX_TEXT);
    if (!t) continue;
    // The API needs turns to alternate, starting with the user: merge neighbours with the same role.
    if (messages.length && messages[messages.length - 1].role === role) messages[messages.length - 1].content += '\n' + t;
    else if (messages.length || role === 'user') messages.push({ role, content: t });
  }
  if (messages.length && messages[messages.length - 1].role === 'user') messages[messages.length - 1].content += '\n' + text;
  else messages.push({ role: 'user', content: text });

  const changed = [];
  const system = systemPrompt(ctx);
  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const res = await callModel({ system, messages, tools: TOOLS });
    const content = Array.isArray(res && res.content) ? res.content : [];
    const uses = content.filter(b => b.type === 'tool_use');
    if (!uses.length || res.stop_reason !== 'tool_use') {
      const reply = content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      return { reply: reply || 'Done.', changed, turns: turn };
    }
    messages.push({ role: 'assistant', content });
    const results = [];
    for (const u of uses) {
      let out, isError = false;
      try {
        out = await mcp.callTool(u.name, u.input, ctx);
        if (CHANGES.has(u.name)) changed.push(u.name);
      } catch (e) {
        isError = true;
        out = e instanceof mcp.UserError ? e.message : 'That didn’t work. Try again.';
        if (!(e instanceof mcp.UserError)) console.error('assistant tool failed', u.name, e);
      }
      results.push({ type: 'tool_result', tool_use_id: u.id, content: String(out), ...(isError ? { is_error: true } : {}) });
    }
    messages.push({ role: 'user', content: results });
  }
  return { reply: changed.length ? 'Done. (That took more steps than expected, so check the plate.)' : 'Sorry, I got stuck on that one. Try saying it another way.', changed, turns: MAX_TURNS };
}

module.exports = { run, systemPrompt, TOOLS, MAX_TURNS, MAX_HISTORY };
