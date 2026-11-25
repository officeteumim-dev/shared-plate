// Linked families: households (say, grandparents) linked to yours. Pure helpers with no Firebase in them, so the
// tests can run them; index.js does the reading and writing.
//
// A link has a side in each household: groups/<g>/links/<otherGroupId> = { name, share, accept, linkedAt }.
//   share  — what the OTHER household can see of us: 'none' | 'events' (tasks marked familyShare) | 'calendar'
//   accept — whether the OTHER household can send us events and reminders (true / false)
// Suggestions they send land in groups/<g>/inbox/<id> until someone here approves or declines them.
'use strict';

const SHARES = ['none', 'events', 'calendar'];
const REPEATS = ['none', 'daily', 'weekly', 'monthly'];

function cleanSettings(s) {
  return { share: SHARES.includes(s && s.share) ? s.share : 'none', accept: !!(s && s.accept) };
}

// What a linked household may see of ours, for dates from..to (ms). tasks: [{ id, title, dueAt (ms), repeat, owner,
// claimedBy, status, familyShare }]. Returns [{ id, title, at, repeat, who }] where who is a display name or 'Shared'.
function visibleTasks(tasks, share, names, L, from, to, tz) {
  if (share !== 'events' && share !== 'calendar') return [];
  const out = [];
  for (const t of tasks) {
    if (t.status === 'done') continue;
    if (share === 'events' && !t.familyShare) continue;
    const due = L.toMs(t.dueAt);
    if (due == null) continue;
    const resp = L.responsible(t);
    const who = resp ? (names[resp] || '') : 'Shared';
    const push = at => { if (at >= from && at < to) out.push({ id: t.id, title: String(t.title || '').slice(0, 200), at, repeat: !!L.normRepeat(t.repeat) && at !== due, who }); };
    push(due);
    if (L.normRepeat(t.repeat)) {
      let next = due, cur = { ...t, dueAt: due };
      for (let i = 0; i < 62; i++) { next = L.nextFor(cur, next, tz); if (!next || next >= to) break; push(next); cur = { ...cur, ...L.carryRepeat(cur), dueAt: next }; }
    }
  }
  return out.sort((a, b) => a.at - b.at).slice(0, 300);
}

// A suggestion as sent by a linked household → the fields we store, or an error message.
function cleanSuggestion(d) {
  const title = String((d && d.title) || '').trim().slice(0, 200);
  if (!title) return { error: 'A suggestion needs a title.' };
  const dueAt = d.dueAt == null || d.dueAt === '' ? null : Number(d.dueAt);
  if (dueAt != null && !(dueAt > 0)) return { error: 'That date isn’t valid.' };
  const repeat = REPEATS.includes(d.repeat) ? d.repeat : 'none';
  if (repeat !== 'none' && dueAt == null) return { error: 'A repeating suggestion needs a date.' };
  return { value: { title, notes: String(d.notes || '').trim().slice(0, 2000), dueAt, repeat } };
}

// The task we create when a suggestion is approved. owner: 'shared' or a member uid.
function taskFromSuggestion(s, owner, approverUid, L, now) {
  const t = {
    title: s.title, notes: [s.notes, `From ${s.fromName}`].filter(Boolean).join('\n').slice(0, 2000), owner, claimedBy: null,
    status: 'open', dueAt: s.dueAt || null, repeat: s.repeat || 'none', createdBy: approverUid, fromFamily: s.fromGroup
  };
  t.notifyAt = L.notifyAtFor(t, now);
  return t;
}

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function linkCode(randomBytes) {
  return [...randomBytes(8)].map(b => CODE_CHARS[b % CODE_CHARS.length]).join('');
}

module.exports = { SHARES, cleanSettings, visibleTasks, cleanSuggestion, taskFromSuggestion, linkCode };
