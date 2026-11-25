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
        repeat_until: { type: 'string', description: 'Optional last day it repeats, YYYY-MM-DD. One task that repeats, not separate tasks.' },
        times: { type: 'array', items: { type: 'string' }, description: 'For a daily task done more than once a day: every time of day, "HH:MM" 24-hour, e.g. ["08:00", "18:30"]. One task, not one per time.' },
        ends_after: { type: 'integer', description: 'Optional: how many times in all, e.g. 16 doses of medicine. The first one is the due date/time.' },
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
    description: 'Change a task: title, owner, due date, repeat (and when it ends), notes, category or priority. Use snooze_until to hide it until a date.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        title: { type: 'string' }, owner: { type: 'string' }, due: { type: 'string', description: 'New due date/time, or "" to clear it.' },
        repeat: { type: 'string', enum: REPEATS }, repeat_until: { type: 'string', description: 'Last day it repeats, YYYY-MM-DD; "" to repeat with no end.' },
        times: { type: 'array', items: { type: 'string' }, description: 'Daily times "HH:MM"; [] for once a day.' },
        ends_after: { type: 'integer', description: 'How many times in all; 0 for no count.' },
        notes: { type: 'string' }, category: { type: 'string' }, priority: { type: 'string' },
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
    name: 'add_shopping_items',
    description: 'Add items to the household shopping list. Lists are like Groceries, Amazon, Costco or Pharmacy; new list names are fine.',
    inputSchema: {
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'string' }, description: 'Item names, e.g. ["milk", "eggs"].' },
        list: { type: 'string', description: 'Which list. Default Groceries.' }
      },
      required: ['items'],
      additionalProperties: false
    }
  },
  {
    name: 'list_shopping',
    description: 'Show the shopping list: what still needs to be bought, by list, with item ids.',
    inputSchema: { type: 'object', properties: { list: { type: 'string', description: 'Only this list.' }, include_checked: { type: 'boolean' } }, additionalProperties: false },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'update_shopping_item',
    description: 'Check an item off (or back on), move it to another list, rename it, or remove it.',
    inputSchema: {
      type: 'object',
      properties: {
        item_id: { type: 'string' }, checked: { type: 'boolean' }, list: { type: 'string', description: 'Move to this list.' },
        name: { type: 'string' }, note: { type: 'string' }, remove: { type: 'boolean', description: 'Delete the item.' }
      },
      required: ['item_id'],
      additionalProperties: false
    }
  },
  {
    name: 'log_time',
    description: 'Log hours worked for a client (Hours). Say who did the work (default me), the client, how long, and the day (default today).',
    inputSchema: {
      type: 'object',
      properties: {
        client: { type: 'string', description: 'Client name, as in hours_summary. Unknown names are refused unless new_client is true.' },
        duration: { type: 'string', description: 'How long: "1.5", "1:30", "90m" or "2h 15m". Up to 24 hours.' },
        date: { type: 'string', description: 'Day worked, YYYY-MM-DD. Default today.' },
        who: { type: 'string', description: '"me" (default) or a household member\'s name.' },
        note: { type: 'string', description: 'What was done.' },
        new_client: { type: 'boolean', description: 'Add the client if there isn\'t one by that name.' }
      },
      required: ['client', 'duration'],
      additionalProperties: false
    }
  },
  {
    name: 'hours_summary',
    description: 'Hours worked per client and per person for a period, with amounts for clients that have an hourly rate, and the entries. Also lists the clients.',
    inputSchema: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: ['week', 'lastweek', 'month', 'lastmonth', 'year'], description: 'Default this week (weeks start Sunday).' },
        client: { type: 'string', description: 'Only this client.' }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'add_comment',
    description: 'Comment on a task or a shopping item, for example to ask the other person for more detail ("Which brand?"). They get a notification.',
    inputSchema: {
      type: 'object',
      properties: {
        about: { type: 'string', enum: ['task', 'shopping'], description: 'Is it a task or a shopping item?' },
        id: { type: 'string', description: 'The task id or shopping item id (from list_tasks or list_shopping).' },
        text: { type: 'string' }
      },
      required: ['about', 'id', 'text'],
      additionalProperties: false
    }
  },
  {
    name: 'get_comments',
    description: 'Read the comments on a task or a shopping item.',
    inputSchema: {
      type: 'object',
      properties: { about: { type: 'string', enum: ['task', 'shopping'] }, id: { type: 'string' } },
      required: ['about', 'id'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'take_task',
    description: 'Take an unclaimed shared task, so it moves to my plate.',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'], additionalProperties: false }
  }
];

// ctx: { uid, group: {name, members, names}, tz, now, store: { list(), get(id), add(data) → id, update(id, patch) }, L (logic.js) }
let HoursMod;
const Hours = () => HoursMod || (HoursMod = (() => { try { return require('./hours'); } catch (e) { return require('../public/hours.js'); } })());

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
    if (L.repeatLabel(t.repeat)) bits.push(L.repeatText({ ...t, dailyTimes: t.dailyTimes }).toLowerCase() + (t.repeatUntil ? ` until ${t.repeatUntil}` : ''));
    if (t.countOf) bits.push(`${t.countN || 1} of ${t.countOf}`);
    if (t.category) bits.push(t.category);
    if (t.status === 'done') bits.push('done');
    if (t.commentCount) bits.push(`${t.commentCount} comment${t.commentCount === 1 ? '' : 's'}`);
    return `[${t.id}] ${t.priority ? '(' + t.priority + ') ' : ''}${t.title} — ${bits.join(', ')}${t.notes ? `\n    Note: ${String(t.notes).replace(/\n/g, ' ')}` : ''}`;
  };
  const untilArg = (v, repeat, dueAt) => {
    if (v == null || v === '') return null;
    const s = String(v).trim().slice(0, 10);
    if (!L.validUntil(s)) throw new UserError('repeat_until must look like 2026-11-30.');
    if (!repeat || repeat === 'none') throw new UserError('Only a repeating task can have an end date.');
    if (dueAt != null && s < new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(L.toMs(dueAt)))) throw new UserError('The end date is before the first one is due.');
    return s;
  };
  const timesArg = (v, repeat) => {
    if (v == null) return null;
    const list = L.normTimes(Array.isArray(v) ? v : [v]);
    if (!list.length) return null;
    const r = L.normRepeat(repeat);
    if (!r || r.unit !== 'day') throw new UserError('Times of day are for tasks that repeat daily.');
    return list.length > 1 ? list : null;
  };
  const countArg = (v, repeat, already) => {
    if (v == null || v === 0) return null;
    const n = Math.round(Number(v));
    if (!L.normRepeat(repeat)) throw new UserError('Only a repeating task can end after a number of times.');
    if (!(n >= 2 && n <= 999)) throw new UserError('ends_after must be between 2 and 999.');
    if (n < already) throw new UserError(`This is already number ${already}.`);
    return n;
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
      const repeatUntil = untilArg(args.repeat_until, repeat, dueAt);
      const dailyTimes = timesArg(args.times, repeat);
      const countOf = countArg(args.ends_after, repeat, 1);
      const data = {
        title, notes: clean(args.notes, 2000), owner, claimedBy: null, status: 'open', dueAt, repeat, ...(repeatUntil ? { repeatUntil } : {}),
        ...(dailyTimes ? { dailyTimes } : {}), ...(countOf ? { countOf, countN: 1 } : {}),
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
      if (patch.repeat === 'none') { patch.repeatUntil = null; patch.dailyTimes = null; patch.countOf = null; patch.countN = null; }
      if (args.times != null) patch.dailyTimes = timesArg(args.times, patch.repeat || t.repeat);
      if (args.ends_after != null) { patch.countOf = args.ends_after ? countArg(args.ends_after, patch.repeat || t.repeat, t.countN || 1) : null; patch.countN = patch.countOf ? (t.countN || 1) : null; }
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
      if (args.repeat_until != null) patch.repeatUntil = args.repeat_until === '' ? null : untilArg(args.repeat_until, patch.repeat || t.repeat, patch.dueAt !== undefined ? patch.dueAt : L.toMs(t.dueAt));
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
      const next = L.nextFor({ ...t, dueAt: L.toMs(t.dueAt) }, now, tz);
      let msg = `Done: ${t.title}${t.countOf ? ` (${t.countN || 1} of ${t.countOf})` : ''}.`;
      if (!next && L.normRepeat(t.repeat) && (t.repeatUntil || t.countOf)) msg += ' That was the last one.';
      if (next) {
        const copy = { title: t.title, notes: t.notes || '', owner: t.owner, claimedBy: null, status: 'open', dueAt: next, repeat: t.repeat,
          ...L.carryRepeat(t),
          category: t.category || '', priority: t.priority || '', createdBy: uid, createdAt: 'NOW', repeatOf: t.id };
        copy.notifyAt = L.notifyAtFor(copy, now);
        patch.nextId = await store.add(copy);
        msg += ` Next one: ${fmt(next, tz)}${t.owner === 'shared' ? ', on the Shared plate' : ''}.`;
      }
      await store.update(t.id, patch);
      return msg;
    }

    case 'add_shopping_items': {
      const names = (Array.isArray(args.items) ? args.items : [args.items]).map(x => clean(x, 120)).filter(Boolean).slice(0, 40);
      if (!names.length) throw new UserError('Say what to add.');
      const list = clean(args.list, 40) || 'Groceries';
      const existing = (await store.shopList()).filter(x => !x.checked && x.list.toLowerCase() === list.toLowerCase()).map(x => x.name.toLowerCase());
      const fresh = names.filter(n => !existing.includes(n.toLowerCase()));
      for (const name of fresh) await store.shopAdd({ name, list, note: '', checked: false, addedBy: uid, createdAt: 'NOW' });
      const skipped = names.length - fresh.length;
      return `Added to ${list}: ${fresh.join(', ') || 'nothing new'}.${skipped ? ` (${skipped} already on the list.)` : ''}`;
    }
    case 'list_shopping': {
      const items = await store.shopList();
      const lists = [...new Set(items.map(x => x.list))].filter(l => !args.list || l.toLowerCase() === String(args.list).toLowerCase()).sort();
      const out = [];
      for (const l of lists) {
        const todo = items.filter(x => x.list === l && !x.checked), got = items.filter(x => x.list === l && x.checked);
        out.push(`${l} (${todo.length} to get):`, ...todo.map(x => `  [${x.id}] ${x.name}${x.note ? ' — ' + x.note : ''}${x.commentCount ? ` (${x.commentCount} comment${x.commentCount === 1 ? '' : 's'}, latest: “${x.lastComment || ''}”)` : ''}`));
        if (args.include_checked && got.length) out.push(`  Checked: ${got.map(x => `[${x.id}] ${x.name}`).join(', ')}`);
      }
      return out.length ? out.join('\n') : 'The shopping list is empty.';
    }
    case 'update_shopping_item': {
      const x = await store.shopGet(String(args.item_id || ''));
      if (!x) throw new UserError(`There's no shopping item with id "${args.item_id}". Use list_shopping to see ids.`);
      if (args.remove) { await store.shopDelete(x.id); return `Removed ${x.name}.`; }
      const patch = {};
      if (args.checked != null) Object.assign(patch, args.checked ? { checked: true, checkedBy: uid, checkedAt: 'NOW' } : { checked: false, checkedBy: null, checkedAt: null });
      if (args.list != null) { patch.list = clean(args.list, 40); if (!patch.list) throw new UserError('The list name can’t be empty.'); }
      if (args.name != null) { patch.name = clean(args.name, 120); if (!patch.name) throw new UserError('The name can’t be empty.'); }
      if (args.note != null) patch.note = clean(args.note, 200);
      await store.shopUpdate(x.id, patch);
      const m = { ...x, ...patch };
      return `${m.name}: ${m.checked ? 'checked off' : 'to get'}, on ${m.list}.`;
    }

    case 'log_time': {
      const H = Hours();
      const minutes = H.parseDuration(args.duration);
      if (!minutes) throw new UserError(`Couldn't read "${args.duration}" as a length of time. Try "1.5", "1:30" or "45m" (up to 24 hours).`);
      const today = H.localYmd(now, tz);
      const date = args.date == null || args.date === '' ? today : clean(args.date, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new UserError('date must look like 2026-11-24.');
      let who = resolveOwner(args.who);
      if (who === 'shared') throw new UserError('Say who did the work: a person, not shared.');
      const clients = group.clients || {};
      let c = H.findClient(clients, args.client);
      if (!c) {
        const list = Object.values(clients).filter(x => !x.archived).map(x => x.name).sort();
        if (!args.new_client) throw new UserError(`No client called "${clean(args.client, 60)}". Clients: ${list.join(', ') || 'none yet'}. Set new_client to add it.`);
        const name = clean(args.client, 60).replace(/\s+/g, ' ');
        if (!name) throw new UserError('Say which client.');
        const id = 'c' + Math.random().toString(36).slice(2, 10);
        await store.addClient(id, { name });
        group.clients = { ...clients, [id]: { name } };
        c = { id, name };
      }
      await store.hoursAdd({ client: c.id, who, date, minutes, note: clean(args.note, 300), startedAt: null, createdBy: uid, createdAt: 'NOW', updatedAt: 'NOW' });
      return `Logged ${H.fmtDuration(minutes)} for ${c.name} by ${nameOf(who)} on ${date}.`;
    }
    case 'hours_summary': {
      const H = Hours();
      const per = H.period(H.PERIODS.includes(args.period) ? args.period : 'week', H.localYmd(now, tz));
      const clients = group.clients || {};
      let only = null;
      if (args.client) { only = H.findClient(clients, args.client); if (!only) throw new UserError(`No client called "${clean(args.client, 60)}".`); }
      const entries = (await store.hoursList(per.from)).filter(e => H.inPeriod(e, per) && (!only || e.client === only.id));
      const sum = H.summarize(entries, clients, now);
      const cname = id => (clients[id] && clients[id].name) || 'Unknown client';
      const out = [`${per.label} (${per.from} to ${H.addDays(per.to, -1)}): ${H.fmtDuration(sum.total)}${sum.amount ? `, ${H.money(sum.amount)}` : ''}`];
      for (const [id, c] of Object.entries(sum.byClient).sort((a, b) => cname(a[0]).localeCompare(cname(b[0])))) {
        out.push(`  ${cname(id)}: ${H.fmtDuration(c.minutes)}${c.amount ? ` (${H.money(c.amount)})` : ''} — ${Object.entries(c.byWho).map(([u, m]) => `${nameOf(u)} ${H.fmtDuration(m)}`).join(', ')}`);
      }
      if (entries.length) out.push('Entries:', ...entries.sort((a, b) => a.date.localeCompare(b.date)).slice(-60).map(e => `  ${e.date} ${cname(e.client)} — ${nameOf(e.who)}, ${e.startedAt ? 'timer running' : H.fmtDuration(e.minutes)}${e.note ? ` — ${e.note}` : ''}`));
      const all = Object.values(clients).filter(x => !x.archived).map(x => x.name + (x.rate ? ` (${H.money(x.rate)}/hr)` : '')).sort();
      out.push(`Clients: ${all.join(', ') || 'none yet'}`);
      return out.join('\n');
    }
    case 'add_comment':
    case 'get_comments': {
      const kind = args.about === 'shopping' ? 'shopping' : 'tasks';
      const target = kind === 'shopping' ? await store.shopGet(String(args.id || '')) : await store.get(String(args.id || ''));
      if (!target) throw new UserError(`There's no ${kind === 'shopping' ? 'shopping item' : 'task'} with id "${args.id}".`);
      const label = target.name || target.title;
      if (name === 'add_comment') {
        const text = clean(args.text, 1000);
        if (!text) throw new UserError('Say what to write.');
        await store.addComment(kind, target.id, text);
        return `Commented on ${label}: “${text}”. The others in the household were notified.`;
      }
      const list = await store.comments(kind, target.id);
      if (!list.length) return `No comments on ${label} yet.`;
      return [`Comments on ${label}:`, ...list.map(c => `  ${nameOf(c.by)}, ${fmt(c.at, tz)}: ${c.text}`)].join('\n');
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
          'Use get_household to learn the names, today\'s date and the time zone; list_tasks to find task ids; add_task for new reminders and events. ' +
          'There is also a shared shopping list (add_shopping_items, list_shopping, update_shopping_item). ' +
          'Use add_comment to ask the other person about a task or shopping item; get_comments reads the replies. ' +
          'Hours for clients: log_time records work (who, client, how long, day); hours_summary shows totals per client and person.'
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

module.exports = { handleMessage, callTool, parseWhen, TOOLS, SUPPORTED, UserError };
