// Shared Plate server code (Firebase Cloud Functions).
// - sendReminders: every 5 minutes, sends push notifications for tasks that are due and snoozed tasks that come back,
//   respecting each person's quiet hours and notification preferences.
// - joinGroup: joins a group with its invite code (the code is checked here, so non-members never read groups).
// Deployed by GitHub Actions (.github/workflows/deploy.yml). public/logic.js is copied in on deploy.
'use strict';
const { setGlobalOptions } = require('firebase-functions/v2');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineString } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
let L;
try { L = require('./logic'); } catch (e) { L = require('../public/logic.js'); }

admin.initializeApp();
const db = admin.firestore();
const FV = admin.firestore.FieldValue;
const TS = admin.firestore.Timestamp;
setGlobalOptions({ region: 'us-central1', maxInstances: 3 });

const SITE_URL = defineString('SITE_URL', { default: '' });
// Sign-up allowlist. Keep the same as public/config.js and firestore.rules. Phase 3: set to null to open sign-up.
const ALLOWLIST = [
  'office.teumim@gmail.com',
  'azw.tcp@gmail.com'
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

exports.sendReminders = onSchedule({ schedule: 'every 5 minutes', timeoutSeconds: 120 }, async () => {
  const now = Date.now();
  const due = await db.collectionGroup('tasks').where('notifyAt', '<=', TS.fromMillis(now)).orderBy('notifyAt').limit(300).get();
  if (due.empty) return;
  const groups = new Map(), users = new Map();
  const getGroup = async id => { if (!groups.has(id)) groups.set(id, (await db.doc(`groups/${id}`).get()).data() || null); return groups.get(id); };
  const getUser = async id => { if (!users.has(id)) users.set(id, (await db.doc(`users/${id}`).get()).data() || {}); return users.get(id); };
  const stats = { tasks: 0, sent: 0 };
  const siteUrl = SITE_URL.value() || `https://${process.env.GCLOUD_PROJECT}.web.app`;

  for (const d of due.docs) {
    const groupId = d.ref.parent.parent.id, task = d.data();
    try {
      const group = await getGroup(groupId);
      if (!group) { await d.ref.update({ notifyAt: null }); continue; }
      const people = {};
      for (const uid of Object.keys(group.members || {})) people[uid] = await getUser(uid);
      const plan = L.planReminder(task, group, people, now);
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
