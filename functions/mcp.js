// Shared Plate connector for Claude (Model Context Protocol, over plain HTTP + JSON-RPC).
// Each person makes a private link in the app (Settings → Connect to Claude) and adds it in Claude as a custom
// connector. Requests through that link act as that person, in their household.
// This file has no Firebase in it: index.js passes in a small `store` so the tests can use a fake one.
'use strict';

// Problems the person can fix (bad name, bad date): sent back to Claude as a readable message.
class UserError extends Error {}

const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
const REPEATS = ['none', 'daily', 'weekly', 'monthly'];

// ---------- Time zones ----------
function tzOffset(ms, tz) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).reduce((o, x) => { o[x.type] = +x.value || x.value; return o; }, {});
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}
// "2026-11-10" (9am), "2026-11-10T19:30" (that wall-clock time in tz), or a full ISO time with Z/offset.
function parseWhen(s, tz) {
  if (s == null || s === '') return null;
  s = String(s).trim();
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(s) && !isNaN(Date.parse(s))) return Date.parse(s);
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?/.exec(s);
  if (!m) throw new UserError(`I couldn't read the date "${s}". Use YYYY-MM-DD or YYYY-MM-DDTHH:MM.`);
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] != null ? +m[4] : 9, m[5] != null ? +m[5] : 0);
  let ms = guess - tzOffset(guess, tz);
  ms = guess - tzOffset(ms, tz); // settle across a clock change
  return ms;
}
function fmt(ms, tz) {
  if (ms == null) return '';
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
}
function localDate(ms, tz) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  return p; // YYYY-MM-DD
}

// ---------- Tools ----------
const TOOLS = [
  {
    name: 'get_household',
    description: 'Who is in the Shared Plate household, who "me" is, and today\'s date and time zone. Call this first if you need to resolve a name or a relative date like "tomorrow".',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'list_tasks',
    description: 'List open tasks on the household plate (and optionally recently finished ones). Each line starts with the task id, which the other tools need.',
    inputSchema: {
      type: 'object',
      properties: {
        who: { type: 'string', description: '"me", "shared", "all", or a person\'s name. Default "all".' },
        category: { type: 'string', description: 'Only this category (e.g. Work, Car, House).' },
        include_done: { type: 'boolean', description: 'Also list the most recently finished tasks.' }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'add_task',
    description: 'Add a reminder or event to the household plate. An event is a task with a date and time. Times are in the household person\'s local time zone.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What needs doing, e.g. "Call the plumber".' },
        owner: { type: 'string', description: '"me" (default), "shared" (whoever gets to it first), or a person\'s name from get_household.' },
        due: { type: 'string', description: 'Optional. "YYYY-MM-DD" (9am that day) or "YYYY-MM-DDTHH:MM" in local time.' },
        repeat: { type: 'string', enum: REPEATS, description: 'Optional. Needs a due date.' },
        notes: { type: 'string' },
        category: { type: 'string', description: 'Optional, e.g. Work, Car, House.' },
        priority: { type: 'string', description: 'Optional short code up to 3 characters, e.g. 1, 2, 3, A.' }
      },
      required: ['title'],
      additionalProperties: false
    }
  },
  {
    name: 'update_task',
    description: 'Change a task: title, owner, due date, repeat, notes, category or priority. Use snooze_until to hide it until a date.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        title: { type: 'string' }, owner: { type: 'string' }, due: { type: 'string', description: 'New due date/time, or "" to clear it.' },
        repeat: { type: 'string', enum: REPEATS }, notes: { type: 'string' }, category: { type: 'string' }, priority: { type: 'string' },
        snooze_until: { type: 'string', description: '"YYYY-MM-DD" (comes back at 8am) or "YYYY-MM-DDTHH:MM". Use "" to bring it back now.' }
      },
      required: ['task_id'],
      additionalProperties: false
    }
  },
  {
    name: 'complete_task',
    description: 'Mark a task done. A repeating task puts its next copy on the plate (shared ones go back to Shared, unclaimed).',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'], additionalProperties: false }
  },
  {
    name: 'take_task',
    description: 'Take an unclaimed shared task, so it moves to my plate.',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'], additionalProperties: false }
  }
];

// ctx: { uid, group: {name, members, names}, tz, now, store: { list(), get(id), add(data) → id, update(id, patch) }, L (logic.js) }
async function callTool(name, args, ctx) {
  const { uid, group, tz, now, store, L } = ctx;
  args = args || {};
  const names = group.names || {};
  const members = Object.keys(group.members || {});
  const nameOf = u => u === uid ? `${names[u] || 'Me'} (me)` : (names[u] || 'Someone');
  const resolveOwner = o => {
    const v = String(o == null ? 'me' : o).trim().toLowerCase();
    if (!v || v === 'me' || v === 'mine' || v === 'i') return uid;
    if (v === 'shared' || v === 'anyone' || v === 'either') return 'shared';
    const hit = members.find(u => (names[u] || '').toLowerCase() === v)
      || members.find(u => (names[u] || '').toLowerCase().split(/\s+/)[0] === v.split(/\s+/)[0]);
    if (!hit) throw new UserError(`No one called "${o}" is in this household. People: ${members.map(nameOf).join(', ')}.`);
    return hit;
  };
  const clean = (s, max) => String(s == null ? '' : s).trim().slice(0, max);
  const describe = t => {
    const who = t.owner === 'shared' ? (t.claimedBy ? `Shared, ${nameOf(t.claimedBy)} took it` : 'Shared') : nameOf(t.owner);
    const bits = [who];
    if (t.status === 'snoozed') bits.push(`snoozed until ${fmt(L.toMs(t.showAgainOn), tz)}`);
    else if (t.dueAt) bits.push(`due ${fmt(L.toMs(t.dueAt), tz)}`);
    if (L.repeatLabel(t.repeat)) bits.push(L.repeatLabel(t.repeat).toLowerCase());
    if (t.category) bits.push(t.category);
    if (t.status === 'done') bits.push('done');
    return `[${t.id}] ${t.priority ? '(' + t.priority + ') ' : ''}${t.title} — ${bits.join(', ')}${t.notes ? `\n    Note: ${String(t.notes).replace(/\n/g, ' ')}` : ''}`;
  };
  const getTask = async id => {
    const t = await store.get(String(id || ''));
    if (!t) throw new UserError(`There's no task with id "${id}". Use list_tasks to see ids.`);
    return t;
  };

  switch (name) {
    case 'get_household':
      return [`Household: ${group.name || 'Shared Plate'}`,
        `Me: ${names[uid] || 'Me'}`,
        `People: ${members.map(nameOf).join(', ')}`,
        `Time zone: ${tz}`,
        `Now: ${fmt(now, tz)} (today is ${localDate(now, tz)})`].join('\n');

    case 'list_tasks': {
      const all = await store.list();
      const who = String(args.who || 'all').trim().toLowerCase();
      let open = all.filter(t => t.status !== 'done');
      if (who !== 'all') {
        const o = resolveOwner(who);
        open = open.filter(t => (o === 'shared' ? t.owner === 'shared' && !t.claimedBy : L.responsible(t) === o));
      }
      if (args.category) open = open.filter(t => String(t.category || '').toLowerCase() === String(args.category).toLowerCase());
      open.sort((a, b) => (L.toMs(a.dueAt) ?? 9e15) - (L.toMs(b.dueAt) ?? 9e15));
      const out = [`${open.length} open task${open.length === 1 ? '' : 's'}${who !== 'all' ? ` for ${who}` : ''} (times in ${tz}):`, ...open.map(describe)];
      if (args.include_done) {
        const done = all.filter(t => t.status === 'done').sort((a, b) => (L.toMs(b.completedAt) || 0) - (L.toMs(a.completedAt) || 0)).slice(0, 15);
        out.push('', `Recently done (${done.length}):`, ...done.map(describe));
      }
      return out.join('\n');
    }

    case 'add_task': {
      const title = clean(args.title, 200);
      if (!title) throw new UserError('A task needs a title.');
      const owner = resolveOwner(args.owner);
      const dueAt = parseWhen(args.due, tz);
      const repeat = REPEATS.includes(args.repeat) ? args.repeat : 'none';
      if (repeat !== 'none' && dueAt == null) throw new UserError('A repeating task needs a due date.');
      const data = {
        title, notes: clean(args.notes, 2000), owner, claimedBy: null, status: 'open', dueAt, repeat,
        category: clean(args.category, 40), priority: clean(args.priority, 3),
        createdBy: uid, createdAt: 'NOW', updatedAt: 'NOW', notifyOnly: null, notifyKind: null
      };
      data.notifyAt = L.notifyAtFor(data, now);
      const id = await store.add(data);
      return `Added: ${describe({ ...data, id })}`;
    }

    case 'update_task': {
      const t = await getTask(args.task_id);
      const patch = { updatedAt: 'NOW', notifyOnly: null, notifyKind: null };
      if (args.title != null) { patch.title = clean(args.title, 200); if (!patch.title) throw new UserError('The title can’t be empty.'); }
      if (args.owner != null) { patch.owner = resolveOwner(args.owner); patch.claimedBy = null; }
      if (args.due != null) patch.dueAt = parseWhen(args.due, tz);
      if (args.repeat != null) patch.repeat = REPEATS.includes(args.repeat) ? args.repeat : 'none';
      if (args.notes != null) patch.notes = clean(args.notes, 2000);
      if (args.category != null) patch.category = clean(args.category, 40);
      if (args.priority != null) patch.priority = clean(args.priority, 3);
      if (args.snooze_until != null) {
        if (args.snooze_until === '') { patch.status = 'open'; patch.showAgainOn = null; }
        else {
          let until = parseWhen(args.snooze_until, tz);
          if (/^\d{4}-\d{2}-\d{2}$/.test(String(args.snooze_until).trim())) until = parseWhen(args.snooze_until + 'T08:00', tz);
          if (until <= now) throw new UserError('Snooze until a time in the future.');
          patch.status = 'snoozed'; patch.showAgainOn = until;
        }
      }
      const merged = { ...t, ...patch };
      if ((merged.repeat || 'none') !== 'none' && L.toMs(merged.dueAt) == null) throw new UserError('A repeating task needs a due date.');
      patch.notifyAt = L.notifyAtFor({ ...merged, dueAt: L.toMs(merged.dueAt), showAgainOn: L.toMs(merged.showAgainOn) }, now);
      await store.update(t.id, patch);
      return `Updated: ${describe({ ...merged })}`;
    }

    case 'complete_task': {
      const t = await getTask(args.task_id);
      if (t.status === 'done') return `Already done: ${describe(t)}`;
      const patch = { status: 'done', completedAt: 'NOW', completedBy: uid, notifyAt: null, notifyOnly: null, notifyKind: null, updatedAt: 'NOW' };
      const next = L.nextDue(L.toMs(t.dueAt), t.repeat, now);
      let msg = `Done: ${t.title}.`;
      if (next) {
        const copy = { title: t.title, notes: t.notes || '', owner: t.owner, claimedBy: null, status: 'open', dueAt: next, repeat: t.repeat,
          category: t.category || '', priority: t.priority || '', createdBy: uid, createdAt: 'NOW', repeatOf: t.id };
        copy.notifyAt = L.notifyAtFor(copy, now);
        patch.nextId = await store.add(copy);
        msg += ` Next one: ${fmt(next, tz)}${t.owner === 'shared' ? ', on the Shared plate' : ''}.`;
      }
      await store.update(t.id, patch);
      return msg;
    }

    case 'take_task': {
      const t = await getTask(args.task_id);
      if (t.owner !== 'shared') throw new UserError(`That isn’t a shared task; it belongs to ${nameOf(t.owner)}.`);
      if (t.claimedBy && t.claimedBy !== uid) throw new UserError(`${nameOf(t.claimedBy)} already took it.`);
      await store.update(t.id, { claimedBy: uid, claimedAt: 'NOW', notifyOnly: null, updatedAt: 'NOW' });
      return `It’s yours now: ${t.title}.`;
    }
  }
  throw new UserError(`Unknown tool "${name}".`);
}

// One JSON-RPC message → a response object, or null for notifications.
async function handleMessage(msg, ctx) {
  const id = msg && msg.id;
  const reply = result => ({ jsonrpc: '2.0', id, result });
  const error = (code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return error(-32600, 'Invalid request');
  const isNotification = id === undefined;
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params && msg.params.protocolVersion;
      return reply({
        protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'shared-plate', title: 'Shared Plate', version: '1.0.0' },
        instructions: 'Shared Plate is a household task list. Every task has one owner: a person, or "shared" for whoever takes it. ' +
          'Use get_household to learn the names, today\'s date and the time zone; list_tasks to find task ids; add_task for new reminders and events.'
      });
    }
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS });
    case 'tools/call': {
      const { name, arguments: args } = msg.params || {};
      try {
        const text = await callTool(name, args, ctx);
        return reply({ content: [{ type: 'text', text }] });
      } catch (e) {
        if (e instanceof UserError) return reply({ content: [{ type: 'text', text: e.message }], isError: true });
        console.error('tool failed', name, e);
        return reply({ content: [{ type: 'text', text: 'Something went wrong saving that. Try again.' }], isError: true });
      }
    }
    default:
      if (isNotification) return null;
      return error(-32601, `Method not found: ${msg.method}`);
  }
}

module.exports = { handleMessage, callTool, parseWhen, TOOLS, SUPPORTED };
