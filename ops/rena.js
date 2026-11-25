// One-time: replace the 16 separate "Give Rena antibiotics" tasks with one task (8am and 6:30pm daily, 16 doses).
// Checks every old task is what we think before changing anything.
const admin = require('firebase-admin');
const L = require('../public/logic.js');
admin.initializeApp();
const db = admin.firestore();
const OLD = ['bHKjMbsCf5BGsaBjFUXe', 'y0YkU89CCjZQpqo9juko', 'hspueeoAybsbO2gB6us6', 'b21Mn0MEBer8GfL087dW', '90Gc1P9Hnhq01fkfrqzK',
  'liRM1Mzc0k3DZRjstpS2', 'F3AenTblsUhGSChfCnep', 'JNjdTk4EHk5pTSCHSPcW', 'ckP5Hi7uEJnrCIQcuSNB', 'FTGRRo2k53B3vC6sL2YF', 'YBv8d4RJCHTQHnwsA6l7',
  'GuMcZOhP0ewYNfgfkNMT', 'fMiCkUYKBuQQ3dF0YPXB', 'RrDjEm83RU1xwuGjmpjA', 'iZPasTtHeKzRBiTJucyR', 'sdPMhQT6RlGo5xus6CKQ'];
(async () => {
  let gid = null;
  for (const g of (await db.collection('groups').get()).docs) if ((await g.ref.collection('tasks').doc(OLD[0]).get()).exists) { gid = g.id; break; }
  if (!gid) throw new Error('Household not found');
  const col = db.collection(`groups/${gid}/tasks`);
  const old = await Promise.all(OLD.map(id => col.doc(id).get()));
  for (const d of old) {
    const t = d.data();
    if (!d.exists || !/^Give Rena antibiotics/.test(t.title) || t.status !== 'open') throw new Error(`Unexpected task ${d.id}: ${t && t.title} ${t && t.status}`);
  }
  const first = old[0].data();
  const dueAt = Date.parse('2026-11-25T18:30:00-05:00');
  const task = {
    title: first.title, notes: '', owner: 'shared', claimedBy: null, status: 'open',
    dueAt: admin.firestore.Timestamp.fromMillis(dueAt), repeat: 'daily', dailyTimes: ['08:00', '18:30'], countOf: 16, countN: 1,
    notifyAt: admin.firestore.Timestamp.fromMillis(L.notifyAtFor({ status: 'open', dueAt }, Date.now())),
    createdBy: first.createdBy, createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };
  const batch = db.batch();
  const ref = col.doc();
  batch.set(ref, task);
  for (const d of old) batch.delete(d.ref);
  await batch.commit();
  console.log(`Added ${ref.id} (${task.title}, daily 8:00 and 18:30, 16 doses from Nov 25 18:30); deleted ${old.length} old tasks.`);
})().catch(e => { console.error(e); process.exit(1); });
