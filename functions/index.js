// Shared Plate server code (Firebase Cloud Functions).
// - sendReminders: every 5 minutes, sends push notifications for tasks that are due and snoozed tasks that come back,
//   respecting each person's quiet hours and notification preferences.
// - joinGroup: joins a group with its invite code (the code is checked here, so non-members never read groups).
// - calendarFeed: a private .ics feed of scheduled tasks (/cal/<token>.ics) for Google Calendar or Apple Calendar.
// - claudeConnector: each person's private Claude connector (/mcp/<token>), to add and manage tasks from Claude.
// Deployed by GitHub Actions (.github/workflows/deploy.yml). public/logic.js and public/hebrew.js are copied in on deploy.
'use strict';
const { setGlobalOptions } = require('firebase-functions/v2');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineString } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const { buildIcs } = require('./ics');
const mcp = require('./mcp');
let L;
try { L = require('./logic'); } catch (e) { L = require('../public/logic.js'); }
let Hb;
try { Hb = require('./hebrew'); } catch (e) { Hb = require('../public/hebrew.js'); }
// People who turned on the Jewish calendar get no notifications on Shabbos or Yom Tov: when they may get them again.
const restUntilFor = (user, now) => ((user && user.prefs && user.prefs.hebrew === true && Hb.supported) ? Hb.restUntil(now, user.tz || 'America/New_York') : null);

admin.initializeApp();
const db = admin.firestore();
const FV = admin.firestore.FieldValue;
const TS = admin.firestore.Timestamp;
setGlobalOptions({ region: 'us-central1', maxInstances: 3 });

const SITE_URL = defineString('SITE_URL', { default: '' });
// Sign-up allowlist. Keep the same as public/config.js and firestore.rules. Phase 3: set to null to open sign-up.
const ALLOWLIST = [
  'office.teumim@gmail.com',
  'azw.tcp@gmail.com',
  'riviku101@gmail.com'
];
const MAX_MEMBERS = 20;

function allowedEmail(token) {
  const email = String(token?.email || '').toLowerCase();
  if (!email || token.email_verified !== true) return false;
  return ALLOWLIST === null || ALLOWLIST.includes(email);
}

// ---------- Join a group by invite code ----------
exports.joinGroup = onCall(async req => {
  if (!req.auth || !allowedEmail(req.auth.token)) throw new HttpsError('permission-denied', 'This email isn’t on the list yet.');
  const uid = req.auth.uid;
  const code = String(req.data?.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 8) throw new HttpsError('invalid-argument', 'That code should be 8 letters and numbers.');
  const name = String(req.data?.name || req.auth.token.name || req.auth.token.email.split('@')[0]).trim().slice(0, 60) || 'Me';
  const q = await db.collection('groups').where('inviteCode', '==', code).limit(1).get();
  if (q.empty) throw new HttpsError('not-found', 'No household has that code. Check it with the person who sent it.');
  const ref = q.docs[0].ref;
  const result = await db.runTransaction(async tx => {
    const g = (await tx.get(ref)).data();
    const members = g.members || {};
    if (!members[uid]) {
      if (Object.keys(members).length >= MAX_MEMBERS) throw new HttpsError('resource-exhausted', 'This household is full.');
      tx.update(ref, { [`members.${uid}`]: 'member', [`names.${uid}`]: name });
    }
    tx.set(db.doc(`users/${uid}`), { groupIds: FV.arrayUnion(ref.id), updatedAt: FV.serverTimestamp() }, { merge: true });
    return { groupId: ref.id, name: g.name };
  });
  logger.info('Joined group', { groupId: result.groupId });
  return result;
});

// ---------- Reminders ----------
function message(task, kind, groupName, siteUrl, groupId, taskId) {
  const title = kind === 'back' ? `Back on your plate: ${task.title}` : `Due now: ${task.title}`;
  const body = task.owner === 'shared' && !task.claimedBy
    ? 'Shared task. Tap to take it.'
    : (task.notes ? String(task.notes).slice(0, 120) : groupName || 'Shared Plate');
  const link = (siteUrl ? siteUrl.replace(/\/$/, '') : '') + '/#task=' + encodeURIComponent(groupId + '/' + taskId);
  return {
    webpush: {
      notification: { title: title.slice(0, 120), body, icon: '/icons/icon-192.png', badge: '/icons/badge-72.png', tag: `${groupId}/${taskId}` },
      fcmOptions: { link },
      headers: { Urgency: 'high', TTL: '3600' }
    },
    data: { groupId, taskId, kind }
  };
}

async function sendTo(user, uid, msg, stats) {
  const tokens = Object.keys(user?.tokens || {});
  if (!tokens.length) return;
  const res = await admin.messaging().sendEachForMulticast({ ...msg, tokens });
  stats.sent += res.successCount;
  const dead = {};
  res.responses.forEach((r, i) => {
    const code = r.error?.code || '';
    if (/registration-token-not-registered|invalid-registration-token|invalid-argument/.test(code)) dead[`tokens.${tokens[i]}`] = FV.delete();
  });
  if (Object.keys(dead).length) await db.doc(`users/${uid}`).update(dead).catch(() => {});
}

// ---------- Comments ----------
// Comments on a shopping item or a task (…/comments/<id>: text, by, at). The person who posts one asks us to tell
// everyone else in the household, unless they're in quiet hours or have turned comment notifications off.
const COMMENT_KINDS = { shopping: 'shopping', tasks: 'tasks' };
async function notifyComment(groupId, kind, itemId, commentId, callerUid) {
  if (!COMMENT_KINDS[kind] || !/^[A-Za-z0-9]{1,40}$/.test(itemId) || !/^[A-Za-z0-9]{1,40}$/.test(commentId)) throw new HttpsError('invalid-argument', 'Bad comment.');
  const group = (await db.doc(`groups/${groupId}`).get()).data();
  if (!group || !(group.members || {})[callerUid]) throw new HttpsError('permission-denied', 'Not in this household.');
  const cRef = db.doc(`groups/${groupId}/${kind}/${itemId}/comments/${commentId}`);
  const sent = await db.runTransaction(async tx => {
    const c = (await tx.get(cRef)).data();
    if (!c || c.by !== callerUid || c.notified) return null;
    tx.update(cRef, { notified: true });
    return c;
  });
  if (!sent) return { sent: 0 };
  const item = (await db.doc(`groups/${groupId}/${kind}/${itemId}`).get()).data() || {};
  const who = (group.names || {})[callerUid] || 'Someone';
  const what = kind === 'shopping' ? item.name : item.title;
  const siteUrl = SITE_URL.value() || `https://${process.env.GCLOUD_PROJECT}.web.app`;
  const link = `${siteUrl.replace(/\/$/, '')}/#${kind === 'shopping' ? 'shop' : 'task'}=${encodeURIComponent(groupId + '/' + itemId)}`;
  const msg = {
    webpush: {
      notification: { title: `${who} about ${what || 'an item'}`.slice(0, 120), body: String(sent.text || '').slice(0, 180), icon: '/icons/icon-192.png', badge: '/icons/badge-72.png', tag: `c-${groupId}/${itemId}` },
      fcmOptions: { link },
      headers: { Urgency: 'high', TTL: '86400' }
    },
    data: { groupId, kind, itemId }
  };
  const stats = { sent: 0 };
  const now = Date.now();
  for (const uid of Object.keys(group.members)) {
    if (uid === callerUid) continue;
    const u = (await db.doc(`users/${uid}`).get()).data() || {};
    if ((u.prefs || {}).comments === false || L.inQuiet(u.quiet, u.tz, now) || restUntilFor(u, now)) continue;
    await sendTo(u, uid, msg, stats);
  }
  return { sent: stats.sent };
}
exports.notifyComment = onCall(async req => {
  if (!req.auth || !allowedEmail(req.auth.token)) throw new HttpsError('permission-denied', 'Sign in first.');
  const d = req.data || {};
  return notifyComment(String(d.groupId || ''), String(d.kind || ''), String(d.itemId || ''), String(d.commentId || ''), req.auth.uid);
});

// ---------- Daf Yomi reminders ----------
// Settings → Calendar → Daily Daf Yomi reminder: prefs.dafReminder { enabled, same, time, days }. Sent once a day in
// the half hour after the chosen time (users.dafSentOn remembers the date). Never on Shabbos or Yom Tov.
async function sendDafReminders(now, stats) {
  const q = await db.collection('users').where('prefs.dafReminder.enabled', '==', true).limit(500).get();
  const siteUrl = SITE_URL.value() || `https://${process.env.GCLOUD_PROJECT}.web.app`;
  for (const d of q.docs) {
    const u = d.data(), tz = u.tz || 'America/New_York';
    const date = L.dafReminderDue(u.prefs.dafReminder, tz, now, u.dafSentOn);
    if (!date) continue;
    await d.ref.update({ dafSentOn: date });
    if (restUntilFor(u, now)) continue; // Shabbos or Yom Tov: skip today's reminder
    const [y, m, dd] = date.split('-').map(Number);
    const daf = Hb.dafYomi(new Date(y, m - 1, dd, 12).getTime());
    await sendTo(u, d.id, {
      webpush: {
        notification: { title: `Daf Yomi: ${daf.masechta} ${daf.daf}`, body: 'Today’s daf', icon: '/icons/icon-192.png', badge: '/icons/badge-72.png', tag: `daf-${date}` },
        fcmOptions: { link: `${siteUrl.replace(/\/$/, '')}/` },
        headers: { Urgency: 'normal', TTL: '21600' }
      },
      data: { kind: 'daf', date }
    }, stats);
    stats.daf++;
  }
}

exports.sendReminders = onSchedule({ schedule: 'every 5 minutes', timeoutSeconds: 120 }, async () => {
  const now = Date.now();
  const stats = { tasks: 0, sent: 0, daf: 0 };
  await sendDafReminders(now, stats).catch(e => logger.error('Daf reminders failed', { err: e.message }));
  const due = await db.collectionGroup('tasks').where('notifyAt', '<=', TS.fromMillis(now)).orderBy('notifyAt').limit(300).get();
  if (due.empty) { if (stats.daf) logger.info('Reminders', stats); return; }
  const groups = new Map(), users = new Map();
  const getGroup = async id => { if (!groups.has(id)) groups.set(id, (await db.doc(`groups/${id}`).get()).data() || null); return groups.get(id); };
  const getUser = async id => { if (!users.has(id)) users.set(id, (await db.doc(`users/${id}`).get()).data() || {}); return users.get(id); };
  const siteUrl = SITE_URL.value() || `https://${process.env.GCLOUD_PROJECT}.web.app`;

  for (const d of due.docs) {
    const groupId = d.ref.parent.parent.id, task = d.data();
    try {
      const group = await getGroup(groupId);
      if (!group) { await d.ref.update({ notifyAt: null }); continue; }
      const people = {};
      for (const uid of Object.keys(group.members || {})) people[uid] = await getUser(uid);
      const plan = L.planReminder(task, group, people, now, restUntilFor);
      for (const s of plan.send) await sendTo(people[s.uid], s.uid, message(task, s.kind, group.name, siteUrl, groupId, d.id), stats);
      const upd = { ...plan.update };
      if (typeof upd.notifyAt === 'number') upd.notifyAt = TS.fromMillis(upd.notifyAt);
      await d.ref.update(upd);
      stats.tasks++;
    } catch (e) {
      logger.error('Reminder failed', { groupId, taskId: d.id, err: e.message });
      // Don't retry the same broken task every 5 minutes forever.
      await d.ref.update({ notifyAt: TS.fromMillis(now + 3600e3) }).catch(() => {});
    }
  }
  logger.info('Reminders', stats);
});

// ---------- Calendar feed ----------
// /cal/<token>.ics?who=mine|all. The token is a long random id created in the app (feeds/<token>: uid, groupId).
// Only tasks with a due date are included; repeats become recurring events.
exports.calendarFeed = onRequest({ invoker: 'public', memory: '256MiB' }, async (req, res) => {
  const m = /\/cal\/([A-Za-z0-9_-]{20,64})(?:\.ics)?$/.exec(req.path || '');
  if (!m) { res.status(404).send('Not found'); return; }
  const feed = (await db.doc(`feeds/${m[1]}`).get()).data();
  if (!feed) { res.status(404).send('This calendar link was turned off. Make a new one in Shared Plate → Settings.'); return; }
  const group = (await db.doc(`groups/${feed.groupId}`).get()).data();
  if (!group || !(group.members || {})[feed.uid]) { res.status(404).send('Not found'); return; }
  const user = (await db.doc(`users/${feed.uid}`).get()).data() || {};
  const who = req.query.who === 'all' ? 'all' : 'mine';
  const snap = await db.collection(`groups/${feed.groupId}/tasks`).where('status', 'in', ['open', 'snoozed']).get();
  const name = uid => uid === feed.uid ? '' : (group.names || {})[uid] || '';
  const tasks = [];
  snap.forEach(d => {
    const t = d.data(), dueAt = L.toMs(t.dueAt);
    if (dueAt == null) return;
    const resp = L.responsible(t);
    if (who === 'mine' && resp !== feed.uid && resp !== null) return; // mine + unclaimed shared
    tasks.push({ id: d.id, title: t.title, notes: t.notes, dueAt, repeat: t.repeat, priority: t.priority, category: t.category,
      who: who === 'all' ? (resp ? name(resp) : 'Shared') : (resp ? '' : 'Shared') });
  });
  const siteUrl = SITE_URL.value() || `https://${process.env.GCLOUD_PROJECT}.web.app`;
  const ics = buildIcs(tasks, { name: who === 'all' ? `${group.name || 'Shared Plate'} (everyone)` : `${group.name || 'Shared Plate'} (mine)`,
    tz: user.tz || 'America/New_York', now: Date.now(), siteUrl, groupId: feed.groupId });
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Cache-Control', 'private, max-age=300');
  res.set('Content-Disposition', 'inline; filename="shared-plate.ics"');
  res.send(ics);
});

// ---------- Claude connector ----------
// POST /mcp/<token> with JSON-RPC (Model Context Protocol, streamable HTTP without streaming).
// connectors/<token> (uid, groupId) is made in the app: Settings → Connect to Claude. Each person has their own.
const TIME_KEYS = ['dueAt', 'showAgainOn', 'completedAt', 'createdAt', 'updatedAt', 'notifyAt', 'claimedAt', 'checkedAt'];
function toFirestore(d) {
  const o = {};
  for (const [k, v] of Object.entries(d)) {
    if (v === 'NOW') o[k] = FV.serverTimestamp();
    else if (TIME_KEYS.includes(k) && typeof v === 'number') o[k] = TS.fromMillis(v);
    else if (v !== undefined) o[k] = v;
  }
  return o;
}
// What the Claude connector and the in-app assistant act through: a person's view of their household.
function toolContext(groupId, uid, group, user) {
  const col = db.collection(`groups/${groupId}/tasks`);
  const shop = db.collection(`groups/${groupId}/shopping`);
  const fromDoc = d => {
    const t = { id: d.id, ...d.data() };
    for (const k of TIME_KEYS) if (t[k] && t[k].toMillis) t[k] = t[k].toMillis();
    return t;
  };
  return {
    uid, group, tz: user.tz || 'America/New_York', now: Date.now(), L,
    store: {
      async list() {
        const [open, done] = await Promise.all([
          col.where('status', 'in', ['open', 'snoozed']).get(),
          col.where('status', '==', 'done').orderBy('completedAt', 'desc').limit(15).get()
        ]);
        return [...open.docs, ...done.docs].map(fromDoc);
      },
      async get(id) { if (!/^[A-Za-z0-9]{1,40}$/.test(id)) return null; const d = await col.doc(id).get(); return d.exists ? fromDoc(d) : null; },
      async add(data) { const ref = col.doc(); await ref.set(toFirestore(data)); return ref.id; },
      async update(id, patch) { await col.doc(id).update(toFirestore(patch)); },
      async shopList() { const q = await shop.get(); return q.docs.map(fromDoc); },
      async shopGet(id) { if (!/^[A-Za-z0-9]{1,40}$/.test(id)) return null; const d = await shop.doc(id).get(); return d.exists ? fromDoc(d) : null; },
      async shopAdd(data) { const ref = shop.doc(); await ref.set(toFirestore(data)); return ref.id; },
      async shopUpdate(id, patch) { await shop.doc(id).update(toFirestore(patch)); },
      async shopDelete(id) { await shop.doc(id).delete(); },
      async comments(kind, id) {
        const q = await db.collection(`groups/${groupId}/${kind}/${id}/comments`).orderBy('at').limit(50).get();
        return q.docs.map(fromDoc).map(c => ({ ...c, at: c.at && c.at.toMillis ? c.at.toMillis() : c.at }));
      },
      async addComment(kind, id, text) {
        const ref = db.collection(`groups/${groupId}/${kind}/${id}/comments`).doc();
        await ref.set({ text, by: uid, at: FV.serverTimestamp() });
        await db.doc(`groups/${groupId}/${kind}/${id}`).update({
          commentCount: FV.increment(1), lastComment: text.slice(0, 200), lastCommentBy: uid, lastCommentAt: FV.serverTimestamp(),
          [`seenBy.${uid}`]: Date.now()
        });
        await notifyComment(groupId, kind, id, ref.id, uid).catch(e => logger.warn('comment push failed', e.message));
      }
    }
  };
}

exports.claudeConnector = onRequest({ invoker: 'public', memory: '256MiB', maxInstances: 3 }, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const m = /\/mcp\/([A-Za-z0-9_-]{24,64})\/?$/.exec(req.path || '');
  if (!m) { res.status(404).json({ error: 'Not found' }); return; }
  if (req.method !== 'POST') { res.set('Allow', 'POST'); res.status(405).send('Use POST'); return; }
  const link = (await db.doc(`connectors/${m[1]}`).get()).data();
  if (!link) { res.status(404).json({ error: 'This Claude link was turned off. Make a new one in Shared Plate → Settings.' }); return; }
  const group = (await db.doc(`groups/${link.groupId}`).get()).data();
  if (!group || !(group.members || {})[link.uid]) { res.status(403).json({ error: 'You are no longer in this household.' }); return; }
  const user = (await db.doc(`users/${link.uid}`).get()).data() || {};
  const ctx = toolContext(link.groupId, link.uid, group, user);
  const body = req.body;
  const msgs = Array.isArray(body) ? body : [body];
  const out = [];
  for (const msg of msgs) { const r = await mcp.handleMessage(msg, ctx); if (r) out.push(r); }
  if (!out.length) { res.status(202).end(); return; }
  res.set('Content-Type', 'application/json');
  res.status(200).send(JSON.stringify(Array.isArray(body) ? out : out[0]));
});

// ---------- Linked families ----------
// Households can link (grandparents, say). Each side decides what the other may see and whether the other may send
// it events and reminders, which wait in its inbox for approval. See family.js for the data shapes.
const F = require('./family');
const crypto = require('crypto');
async function memberOf(req, groupId) {
  if (!req.auth || !allowedEmail(req.auth.token)) throw new HttpsError('permission-denied', 'Sign in first.');
  if (!/^[A-Za-z0-9]{1,40}$/.test(String(groupId || ''))) throw new HttpsError('invalid-argument', 'Which household?');
  const g = (await db.doc(`groups/${groupId}`).get()).data();
  if (!g || !(g.members || {})[req.auth.uid]) throw new HttpsError('permission-denied', 'You’re not in that household.');
  return g;
}
// Tells everyone in a household (except one person), respecting quiet hours, Shabbos/Yom Tov and their settings.
async function notifyHousehold(groupId, exceptUid, title, body, link, tag) {
  const g = (await db.doc(`groups/${groupId}`).get()).data();
  if (!g) return;
  const now = Date.now(), stats = { sent: 0 };
  for (const uid of Object.keys(g.members || {})) {
    if (uid === exceptUid) continue;
    const u = (await db.doc(`users/${uid}`).get()).data() || {};
    if ((u.prefs || {}).family === false || L.inQuiet(u.quiet, u.tz, now) || restUntilFor(u, now)) continue;
    await sendTo(u, uid, {
      webpush: { notification: { title: title.slice(0, 120), body: String(body || '').slice(0, 180), icon: '/icons/icon-192.png', badge: '/icons/badge-72.png', tag },
        fcmOptions: { link }, headers: { Urgency: 'high', TTL: '86400' } },
      data: { kind: 'family', groupId }
    }, stats);
  }
}
const site = () => (SITE_URL.value() || `https://${process.env.GCLOUD_PROJECT}.web.app`).replace(/\/$/, '');
const who = (g, uid) => ((g.names || {})[uid] || 'Someone');

exports.makeLinkCode = onCall(async req => {
  const { groupId } = req.data || {};
  await memberOf(req, groupId);
  const settings = F.cleanSettings(req.data);
  let code;
  for (let i = 0; i < 5; i++) {
    code = F.linkCode(n => crypto.randomBytes(n));
    if (!(await db.doc(`linkCodes/${code}`).get()).exists) break;
  }
  await db.doc(`linkCodes/${code}`).set({ groupId, ...settings, createdBy: req.auth.uid, expiresAt: TS.fromMillis(Date.now() + 7 * 864e5) });
  return { code };
});

exports.useLinkCode = onCall(async req => {
  const { groupId } = req.data || {};
  const mine = await memberOf(req, groupId);
  const code = String((req.data || {}).code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const ref = db.doc(`linkCodes/${code}`);
  const c = (await ref.get()).data();
  if (!c || L.toMs(c.expiresAt) < Date.now()) throw new HttpsError('not-found', 'That link code didn’t work. It may have expired; ask for a new one.');
  if (c.groupId === groupId) throw new HttpsError('invalid-argument', 'That code is from your own household.');
  const theirs = (await db.doc(`groups/${c.groupId}`).get()).data();
  if (!theirs) throw new HttpsError('not-found', 'That household no longer exists.');
  const settings = F.cleanSettings(req.data);
  const batch = db.batch();
  // Each side also keeps a copy of the other side's choices (theirShare, theyAccept) so the app can show them.
  batch.set(db.doc(`groups/${groupId}/links/${c.groupId}`), { name: theirs.name || 'Family', ...settings, theirShare: c.share, theyAccept: c.accept, linkedAt: FV.serverTimestamp() });
  batch.set(db.doc(`groups/${c.groupId}/links/${groupId}`), { name: mine.name || 'Family', share: c.share, accept: c.accept, theirShare: settings.share, theyAccept: settings.accept, linkedAt: FV.serverTimestamp() });
  batch.delete(ref);
  await batch.commit();
  await notifyHousehold(c.groupId, null, `Linked with ${mine.name || 'a family'}`, `${who(mine, req.auth.uid)} linked your households.`, `${site()}/`, `link-${groupId}`);
  return { name: theirs.name || 'Family', otherId: c.groupId };
});

exports.updateLink = onCall(async req => {
  const { groupId, otherId } = req.data || {};
  await memberOf(req, groupId);
  const ref = db.doc(`groups/${groupId}/links/${String(otherId || '')}`);
  if (!(await ref.get()).exists) throw new HttpsError('not-found', 'That link is gone.');
  const settings = F.cleanSettings(req.data);
  await ref.update(settings);
  await db.doc(`groups/${otherId}/links/${groupId}`).update({ theirShare: settings.share, theyAccept: settings.accept }).catch(() => {});
  return { ok: true };
});

exports.unlink = onCall(async req => {
  const { groupId, otherId } = req.data || {};
  await memberOf(req, groupId);
  const o = String(otherId || '');
  if (!/^[A-Za-z0-9]{1,40}$/.test(o)) throw new HttpsError('invalid-argument', 'Which family?');
  await Promise.all([db.doc(`groups/${groupId}/links/${o}`).delete(), db.doc(`groups/${o}/links/${groupId}`).delete()]);
  return { ok: true };
});

// What each linked family shares with us, for the calendar.
exports.linkedCalendar = onCall(async req => {
  const { groupId } = req.data || {};
  await memberOf(req, groupId);
  const from = Number(req.data.from) || Date.now() - 31 * 864e5, to = Math.min(Number(req.data.to) || Date.now() + 62 * 864e5, from + 100 * 864e5);
  const links = await db.collection(`groups/${groupId}/links`).get();
  const out = [];
  for (const l of links.docs) {
    const theirSide = (await db.doc(`groups/${l.id}/links/${groupId}`).get()).data();
    if (!theirSide || theirSide.share === 'none') continue;
    const g = (await db.doc(`groups/${l.id}`).get()).data();
    if (!g) continue;
    const q = await db.collection(`groups/${l.id}/tasks`).where('status', 'in', ['open', 'snoozed']).get();
    const tasks = q.docs.map(d => ({ id: d.id, ...d.data() }));
    out.push({ groupId: l.id, name: g.name || l.data().name, share: theirSide.share, items: F.visibleTasks(tasks, theirSide.share, g.names || {}, L, from, to) });
  }
  return { families: out };
});

exports.sendSuggestion = onCall(async req => {
  const { groupId, toGroupId } = req.data || {};
  const mine = await memberOf(req, groupId);
  const to = String(toGroupId || '');
  if (!/^[A-Za-z0-9]{1,40}$/.test(to)) throw new HttpsError('invalid-argument', 'Send to which family?');
  const [mySide, theirSide] = await Promise.all([db.doc(`groups/${groupId}/links/${to}`).get(), db.doc(`groups/${to}/links/${groupId}`).get()]);
  if (!mySide.exists || !theirSide.exists) throw new HttpsError('not-found', 'You’re not linked with that family any more.');
  if (!theirSide.data().accept) throw new HttpsError('permission-denied', `${mySide.data().name} isn’t taking suggestions from you.`);
  const s = F.cleanSuggestion(req.data);
  if (s.error) throw new HttpsError('invalid-argument', s.error);
  const fromName = `${who(mine, req.auth.uid)} (${mine.name || 'Family'})`;
  const ref = db.collection(`groups/${to}/inbox`).doc();
  await ref.set({ ...s.value, dueAt: s.value.dueAt ? TS.fromMillis(s.value.dueAt) : null, fromGroup: groupId, fromUid: req.auth.uid, fromName,
    status: 'pending', createdAt: FV.serverTimestamp() });
  await notifyHousehold(to, null, `${fromName} suggested: ${s.value.title}`, 'Open Shared Plate to approve or decline.', `${site()}/#inbox`, `sugg-${ref.id}`);
  return { ok: true };
});

exports.answerSuggestion = onCall(async req => {
  const { groupId, id, decision } = req.data || {};
  const g = await memberOf(req, groupId);
  const ref = db.doc(`groups/${groupId}/inbox/${String(id || '').replace(/[^A-Za-z0-9]/g, '')}`);
  const s = (await ref.get()).data();
  if (!s || s.status !== 'pending') throw new HttpsError('failed-precondition', 'That suggestion was already answered.');
  let taskId = null;
  if (decision === 'approve') {
    const owner = req.data.owner === 'shared' || (g.members || {})[req.data.owner] ? req.data.owner : 'shared';
    const t = F.taskFromSuggestion({ ...s, dueAt: L.toMs(s.dueAt) }, owner, req.auth.uid, L, Date.now());
    const tRef = db.collection(`groups/${groupId}/tasks`).doc();
    await tRef.set({ ...t, dueAt: t.dueAt ? TS.fromMillis(t.dueAt) : null, notifyAt: t.notifyAt ? TS.fromMillis(t.notifyAt) : null,
      createdAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp() });
    taskId = tRef.id;
  }
  await ref.update({ status: decision === 'approve' ? 'approved' : 'declined', answeredBy: req.auth.uid, answeredAt: FV.serverTimestamp(), taskId });
  // Let the person who sent it know.
  const sender = s.fromUid ? (await db.doc(`users/${s.fromUid}`).get()).data() : null;
  const now = Date.now();
  if (sender && (sender.prefs || {}).family !== false && !L.inQuiet(sender.quiet, sender.tz, now) && !restUntilFor(sender, now)) {
    await sendTo(sender, s.fromUid, {
      webpush: { notification: { title: `${who(g, req.auth.uid)} ${decision === 'approve' ? 'added' : 'declined'}: ${s.title}`.slice(0, 120), body: g.name || '', icon: '/icons/icon-192.png', tag: `ans-${id}` },
        fcmOptions: { link: `${site()}/` }, headers: { TTL: '86400' } },
      data: { kind: 'family' }
    }, { sent: 0 });
  }
  return { ok: true, taskId };
});

// ---------- In-app assistant ----------
// The chat line in the app: an AI model acting as the person chatting, with the same tools as the Claude connector.
// It runs on Gemini when GEMINI_API_KEY is set (Google's free tier), otherwise on Claude when ANTHROPIC_API_KEY is
// set. The deploy writes those GitHub secrets into functions/.env. With neither, the app says it isn't set up.
// GEMINI_MODEL / ASSISTANT_MODEL in .env override the models.
const Assistant = require('./assistant');
const Gemini = require('./gemini');
const recentAsks = new Map(); // uid → recent request times (per instance), a simple brake on runaway use

const postJson = async (url, headers, body) => {
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  return { ok: r.ok, status: r.status, json: await r.json().catch(() => ({})) };
};
function modelCaller() {
  if (process.env.GEMINI_API_KEY) {
    const call = Gemini.caller({ key: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL || 'gemini-3.8-flash', post: postJson });
    return async req => {
      try { return await call(req); } catch (e) {
        logger.error('assistant (Gemini) call failed', e.status, e.body && e.body.error);
        throw new HttpsError(e.status === 429 ? 'resource-exhausted' : 'unavailable',
          e.status === 429 ? 'The free assistant has hit its limit for now. Try again in a minute (or tomorrow, if it’s the daily limit).'
            : e.status === 400 || e.status === 403 ? 'The assistant’s Gemini key isn’t working. Check GEMINI_API_KEY.' : 'The assistant didn’t answer. Try again in a moment.');
      }
    };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    const key = process.env.ANTHROPIC_API_KEY, model = process.env.ASSISTANT_MODEL || 'claude-sonnet-5-5';
    return async ({ system, messages, tools }) => {
      const r = await postJson('https://api.anthropic.com/v1/messages',
        { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        { model, max_tokens: 1024, system, messages, tools });
      if (!r.ok) {
        logger.error('assistant (Claude) call failed', r.status, r.json && r.json.error);
        throw new HttpsError('unavailable', r.status === 401 ? 'The assistant’s API key isn’t working. Check ANTHROPIC_API_KEY.' : 'The assistant didn’t answer. Try again in a moment.');
      }
      return r.json;
    };
  }
  return null;
}

exports.assistant = onCall({ timeoutSeconds: 120, memory: '256MiB' }, async req => {
  const d = req.data || {};
  const group = await memberOf(req, d.groupId);
  const callModel = modelCaller();
  if (!callModel) return { notSetUp: true };
  const uid = req.auth.uid, t = Date.now();
  const recent = (recentAsks.get(uid) || []).filter(x => t - x < 60 * 60 * 1000);
  if (recent.length >= 60) throw new HttpsError('resource-exhausted', 'That’s a lot of messages this hour. Try again in a little while.');
  recentAsks.set(uid, [...recent, t]);
  const user = (await db.doc(`users/${uid}`).get()).data() || {};
  const ctx = toolContext(d.groupId, uid, group, user);
  const out = await Assistant.run({ history: d.history, text: d.text, ctx, callModel });
  return { reply: out.reply, changed: out.changed };
});
