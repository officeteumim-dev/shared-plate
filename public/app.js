// Shared Plate app. Plain JavaScript, no build step (same approach as sfsp-wgroup).
// - Live data: Firebase Auth + Firestore (compat SDK from Google's CDN), with Firestore's offline cache.
// - Preview mode (?preview): sample household kept in memory, no sign-in. Used by the automated tests.
(function () {
  'use strict';
  const C = self.SP_CONFIG || {};
  const L = self.SP_LOGIC;
  const Hb = self.SP_HEBREW;
  const $ = s => document.querySelector(s);
  const app = $('#app'), sheetRoot = $('#sheet-root'), toastEl = $('#toast');
  const params = new URLSearchParams(location.search);
  const PREVIEW = params.has('preview');
  const H = 3600e3, DAYMS = 86400e3;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  const S = window.SP = {
    preview: PREVIEW, uid: null, email: '', profile: {}, gid: null, group: null,
    open: [], done: [], view: 'home', loaded: false, unsub: []
  };
  let B = null; // data backend (Firebase or preview)

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const now = () => Date.now();
  const ICON = {
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12.5a7.5 7.5 0 0 1-10.9 6.7L4 20.5l1.4-4.4A7.5 7.5 0 1 1 20 12.5z"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13M13 6l6 6-6 6"/></svg>',
    cart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h2.2l2.3 11.2a1.6 1.6 0 0 0 1.6 1.3h8.1a1.6 1.6 0 0 0 1.6-1.2L20.5 8H6.1"/><circle cx="9.5" cy="20" r="1.3"/><circle cx="17" cy="20" r="1.3"/></svg>',
    cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
    next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
    grip: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.7"/><circle cx="15" cy="6" r="1.7"/><circle cx="9" cy="12" r="1.7"/><circle cx="15" cy="12" r="1.7"/><circle cx="9" cy="18" r="1.7"/><circle cx="15" cy="18" r="1.7"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>'
  };

  // ---------- Names and lanes ----------
  const members = () => Object.keys(S.group?.members || {});
  const others = () => members().filter(u => u !== S.uid);
  const nameOf = uid => uid === S.uid ? 'You' : (S.group?.names?.[uid] || 'Someone');
  const myName = () => S.group?.names?.[S.uid] || S.profile.displayName || (S.email || '').split('@')[0] || 'Me';
  function theirsTitle() {
    const o = others();
    return o.length === 1 ? `${S.group.names?.[o[0]] || 'Their'}’s` : 'Theirs';
  }
  const isOwner = () => S.group?.members?.[S.uid] === 'owner';

  // ---------- Colors ----------
  // Household-wide: group.colors maps a uid (or 'shared') to a hex color, so a person looks the same on every phone.
  // Without a choice, the person signed in is teal, the other person plum and shared ochre (with dark-mode variants).
  const PALETTE = ['#1e6f6a', '#2f5fa8', '#7a4e7e', '#b0473a', '#a8741a', '#4f7a2a', '#c2577e', '#4a5560'];
  const HEX = /^#[0-9a-fA-F]{6}$/;
  const customColor = key => { const c = S.group?.colors?.[key]; return HEX.test(c || '') ? c : null; };
  // A CSS color for whoever is responsible: a uid, or 'shared' for an unclaimed shared task.
  function personColor(key) {
    if (key === 'shared') return 'var(--shared)';
    if (key === S.uid) return 'var(--mine)';
    if (key === others()[0]) return 'var(--theirs)';
    return customColor(key) || PALETTE[(members().indexOf(key) + 5) % PALETTE.length];
  }
  function applyColors() {
    const root = document.documentElement.style;
    const set = (lane, key) => {
      const c = customColor(key);
      if (c) { root.setProperty(`--${lane}`, c); root.setProperty(`--${lane}-soft`, `color-mix(in srgb, ${c} 22%, var(--surface))`); }
      else { root.removeProperty(`--${lane}`); root.removeProperty(`--${lane}-soft`); }
    };
    set('mine', S.uid); set('theirs', others()[0] || '-'); set('shared', 'shared');
  }

  // ---------- Priority and categories ----------
  // A priority is a short code (up to 3 characters) shown in small before the title. 1/2/3 (or A/B/C) get colors.
  function prio(x) {
    const p = String(x.priority || '').trim();
    if (!p) return '';
    const level = { '1': 1, a: 1, '2': 2, b: 2, '3': 3, c: 3 }[p.toLowerCase()] || 0;
    return `<span class="prio p${level}" title="Priority ${esc(p)}">${esc(p)}</span>`;
  }
  const DEFAULT_CATS = ['Work', 'Car', 'House'];
  // Tasks that repeat every day are shown smaller. (Hiding them until an hour before they're due is on hold.)
  const isDaily = x => { const r = L.normRepeat(x.repeat); return !!r && r.unit === 'day' && r.every === 1; };
  // Daily tasks come onto the tile 3 hours before they're due (and stay while overdue); the "Daily list" always has them.
  const DAILY_LEAD = 3 * H;
  // Weekly tasks work the same way: always in the "Weekly list", and on the tile from a day before they're due.
  const isWeekly = x => { const r = L.normRepeat(x.repeat); return !!r && r.unit === 'week'; };
  const WEEKLY_LEAD = 24 * H;
  const recurLead = x => (isDaily(x) ? DAILY_LEAD : isWeekly(x) ? WEEKLY_LEAD : null);
  const dailyShowing = (x, t) => { const d = L.toMs(x.dueAt), lead = recurLead(x); return lead == null || d == null || d - t <= lead; };
  // Anything due more than two weeks from now waits in a "More than 2 weeks out" drawer.
  const FAR = 14 * DAYMS;
  const farOut = (x, t) => { const d = L.toMs(x.dueAt); return d != null && d - t > FAR; };
  // Hebrew dates and holidays: a per-person display option (Settings → Calendar).
  const hebOn = () => !!(Hb && Hb.supported && S.profile.prefs && S.profile.prefs.hebrew === true);
  const parshaOn = () => !!(Hb && Hb.supported && S.profile.prefs && S.profile.prefs.parsha === true);
  const dafOn = () => !!(Hb && Hb.supported && S.profile.prefs && S.profile.prefs.daf === true);
  const holidayHtml = ms => Hb.holidays(ms).map(h => `<span class="hol ${h.kind}">${esc(h.name)}</span>`).join('');
  const allCats = () => { const c = L.categories([...S.open, ...S.done]); for (const d of DEFAULT_CATS) if (!c.some(x => x.toLowerCase() === d.toLowerCase())) c.push(d); return c; };
  const savedFilter = () => { try { return localStorage.getItem('sp_cat') || ''; } catch (e) { return ''; } };

  // ---------- Toast ----------
  let toastTimer;
  function toast(msg, action, fn) {
    clearTimeout(toastTimer);
    toastEl.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action)}</button>` : ''}`;
    toastEl.hidden = false;
    if (action) toastEl.querySelector('button').onclick = () => { toastEl.hidden = true; fn(); };
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, action ? 6000 : 3000);
  }
  function fail(e, what) {
    console.error(e);
    const code = e?.code || '';
    const msg = /permission/.test(code) ? `Couldn’t ${what}: you don’t have access to this household.`
      : /unavailable|network/.test(code) ? `Couldn’t ${what} while offline. Try again when you’re connected.`
      : (e?.message && e.code && /functions/.test(e.code) ? e.message : `Couldn’t ${what}. Try again.`);
    toast(msg);
  }

  // =====================================================================
  // Backends
  // =====================================================================
  const TIME_KEYS = ['dueAt', 'showAgainOn', 'completedAt', 'createdAt', 'updatedAt', 'notifyAt', 'claimedAt', 'checkedAt'];

  function previewBackend() {
    const me = 'me', her = 'leah', t0 = now();
    const day = n => { const d = new Date(t0); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n); return d.getTime(); };
    const at = (n, h, m = 0) => day(n) + h * H + m * 60000;
    let seq = 100;
    const group = { name: 'Our home', createdBy: me, members: { [me]: 'owner', [her]: 'member' }, names: { [me]: 'Avi', [her]: 'Leah' }, inviteCode: 'PLATE234' };
    const base = { claimedBy: null, status: 'open', repeat: 'none', createdBy: me, createdAt: t0 - 2 * H };
    const tasks = new Map([
      ['p1', { ...base, title: 'Call the plumber about the kitchen sink', owner: 'shared', createdAt: t0 - 30 * H, notes: 'Number is on the fridge.', category: 'House', priority: '1' }],
      ['p2', { ...base, title: 'Pick up challah', owner: me, dueAt: at(0, 15), repeat: 'weekly' }],
      ['p3', { ...base, title: 'Pay the electric bill', owner: me, dueAt: at(-1, 18), category: 'House', priority: '1' }],
      ['p4', { ...base, title: 'Pediatrician appointment for Noa', owner: her, dueAt: at(0, 10, 30), createdBy: her }],
      ['p5', { ...base, title: 'Take out recycling', owner: 'shared', claimedBy: her, claimedAt: t0 - H, dueAt: at(0, 20), repeat: 'weekly' }],
      ['p6', { ...base, title: 'Order birthday gift for Grandma', owner: 'shared', dueAt: at(2, 12) }],
      ['p7', { ...base, title: 'Renew car registration', owner: me, dueAt: at(5, 9), category: 'Car', priority: '2' }],
      ['p14', { ...base, title: 'Renew passports', owner: me, dueAt: at(20, 10), category: 'House' }],
      ['p12', { ...base, title: 'Do the dishes', owner: 'shared', dueAt: at(0, 20), repeat: 'daily', createdAt: t0 - H }],
      ['p13', { ...base, title: 'Take vitamins', owner: me, dueAt: at(0, 9, 30), repeat: 'daily' }],
      ['p10', { ...base, title: 'Send the Q4 invoices', owner: me, category: 'Work', priority: '3' }],
      ['p11', { ...base, title: 'Rotate the tires', owner: me, category: 'Car' }],
      ['p8', { ...base, title: 'Book the summer camp', owner: her, status: 'snoozed', showAgainOn: at(3, 8), createdBy: her }],
      ['p9', { ...base, title: 'Water the plants', owner: me, status: 'done', completedAt: t0 - 3 * H, completedBy: me }]
    ]);
    let onOpen = () => {}, onDone = () => {}, onGroup = () => {}, onProfile = () => {}, onShop = () => {};
    const shop = new Map([
      ['s1', { name: 'Milk', list: 'Groceries', note: '2 gallons', checked: false, addedBy: her, createdAt: t0 - 3 * H }],
      ['s2', { name: 'Challah flour', list: 'Groceries', checked: false, addedBy: me, createdAt: t0 - 2 * H }],
      ['s3', { name: 'Eggs', list: 'Groceries', checked: true, checkedBy: her, checkedAt: t0 - H, addedBy: me, createdAt: t0 - 5 * H }],
      ['s4', { name: 'Phone charger', list: 'Amazon', checked: false, addedBy: me, createdAt: t0 - 26 * H }],
      ['s5', { name: 'Paper towels', list: 'Amazon', checked: false, addedBy: her, createdAt: t0 - 4 * H }]
    ]);
    const comments = new Map(); // 'shopping/s1' → [{ id, text, by, at }]
    comments.set('shopping/s4', [{ id: 'c1', text: 'Which one? USB-C or Lightning?', by: her, at: t0 - 50 * 60000 }]);
    shop.set('s4', { ...shop.get('s4'), commentCount: 1, lastComment: 'Which one? USB-C or Lightning?', lastCommentBy: her, lastCommentAt: t0 - 50 * 60000, seenBy: {} });
    let onThread = null, threadKey = null;
    const emitThread = () => { if (onThread) { const l = (comments.get(threadKey) || []).slice(); setTimeout(() => onThread && onThread(l)); } };
    const emitShop = () => { const all = [...shop].map(([id, x]) => ({ id, ...x })); setTimeout(() => onShop(all)); };
    let profile = { displayName: 'Avi', email: 'avi@example.com', groupIds: ['demo'], quiet: { enabled: true, start: '22:00', end: '07:00' }, prefs: {}, tz: 'America/New_York' };
    const resolve = d => { const o = { ...d }; for (const k in o) if (o[k] === 'NOW') o[k] = now(); return o; };
    const emit = () => {
      const all = [...tasks].map(([id, t]) => ({ id, ...t }));
      setTimeout(() => {
        onOpen(all.filter(t => t.status !== 'done'));
        onDone(all.filter(t => t.status === 'done').sort((a, b) => b.completedAt - a.completedAt));
      });
    };
    return {
      uid: me, email: profile.email,
      watchProfile(cb) { onProfile = cb; setTimeout(() => cb(profile)); return () => {}; },
      saveProfile(p) { profile = { ...profile, ...p, prefs: { ...(profile.prefs || {}), ...(p.prefs || {}) } }; onProfile(profile); return Promise.resolve(); },
      watchGroup(gid, cb) { onGroup = cb; setTimeout(() => cb({ id: gid, ...group })); return () => {}; },
      updateGroup(gid, patch) {
        for (const [k, v] of Object.entries(patch)) {
          const [a, b] = k.split('.');
          if (b) { group[a] = group[a] || {}; if (v === undefined) delete group[a][b]; else group[a][b] = v; } else group[a] = v;
        }
        onGroup({ id: gid, ...group }); return Promise.resolve();
      },
      watchTasks(gid, a, b) { onOpen = a; onDone = b; emit(); return () => {}; },
      watchShopping(gid, cb) { onShop = cb; emitShop(); return () => {}; },
      setItem(gid, id, data) { shop.set(id, resolve(data)); emitShop(); return Promise.resolve(id); },
      updateItem(gid, id, patch) { shop.set(id, { ...shop.get(id), ...resolve(patch) }); emitShop(); return Promise.resolve(); },
      deleteItem(gid, id) { shop.delete(id); emitShop(); return Promise.resolve(); },
      watchComments(gid, kind, id, cb) { onThread = cb; threadKey = `${kind}/${id}`; emitThread(); return () => { onThread = null; }; },
      addComment(gid, kind, id, text) {
        const key = `${kind}/${id}`, list = comments.get(key) || [];
        list.push({ id: 'c' + (++seq), text, by: me, at: now() }); comments.set(key, list);
        const store = kind === 'shopping' ? shop : tasks, x = store.get(id);
        store.set(id, { ...x, commentCount: (x.commentCount || 0) + 1, lastComment: text.slice(0, 200), lastCommentBy: me, lastCommentAt: now(), seenBy: { ...(x.seenBy || {}), [me]: now() } });
        if (kind === 'shopping') emitShop(); else emit();
        emitThread(); return Promise.resolve();
      },
      markSeen(gid, kind, id) {
        const store = kind === 'shopping' ? shop : tasks, x = store.get(id); if (!x) return Promise.resolve();
        store.set(id, { ...x, seenBy: { ...(x.seenBy || {}), [me]: now() } });
        if (kind === 'shopping') emitShop(); else emit();
        return Promise.resolve();
      },
      newId() { return 'n' + (++seq); },
      setTask(gid, id, data) { tasks.set(id, resolve(data)); emit(); return Promise.resolve(id); },
      updateTask(gid, id, patch) { tasks.set(id, { ...tasks.get(id), ...resolve(patch) }); emit(); return Promise.resolve(); },
      deleteTask(gid, id) { tasks.delete(id); emit(); return Promise.resolve(); },
      createGroup() { return Promise.resolve('demo'); },
      createFeed(token) { profile = { ...profile, feedToken: token }; onProfile(profile); return Promise.resolve(); },
      createConnector(token) { profile = { ...profile, claudeToken: token }; onProfile(profile); return Promise.resolve(); },
      deleteConnector() { profile = { ...profile, claudeToken: null }; onProfile(profile); return Promise.resolve(); },
      deleteFeed() { profile = { ...profile, feedToken: null }; onProfile(profile); return Promise.resolve(); },
      joinGroup() { return Promise.resolve({ groupId: 'demo', name: group.name }); },
      leaveGroup() { return Promise.resolve(); },
      signOut() { location.href = location.pathname; }
    };
  }

  function firebaseBackend(user) {
    const db = firebase.firestore();
    const FV = firebase.firestore.FieldValue, TS = firebase.firestore.Timestamp;
    const uid = user.uid;
    const toFs = d => {
      const o = {};
      for (const [k, v] of Object.entries(d)) {
        if (v === 'NOW') o[k] = FV.serverTimestamp();
        else if (v === undefined) o[k] = FV.delete();
        else if (TIME_KEYS.includes(k) && typeof v === 'number') o[k] = TS.fromMillis(v);
        else o[k] = v;
      }
      return o;
    };
    const snapData = s => s.data({ serverTimestamps: 'estimate' });
    const tasksCol = gid => db.collection('groups').doc(gid).collection('tasks');
    return {
      uid, email: (user.email || '').toLowerCase(),
      watchProfile(cb) {
        return db.doc(`users/${uid}`).onSnapshot(s => cb(s.exists ? snapData(s) : {}), e => fail(e, 'load your settings'));
      },
      saveProfile(p) { return db.doc(`users/${uid}`).set(toFs({ ...p, updatedAt: 'NOW' }), { merge: true }); },
      watchGroup(gid, cb, onErr) {
        return db.doc(`groups/${gid}`).onSnapshot(s => cb(s.exists ? { id: s.id, ...snapData(s) } : null), onErr);
      },
      updateGroup(gid, patch) { return db.doc(`groups/${gid}`).update(toFs(patch)); },
      watchTasks(gid, onOpen, onDone, onErr) {
        const a = tasksCol(gid).where('status', 'in', ['open', 'snoozed']).onSnapshot(
          q => onOpen(q.docs.map(d => ({ id: d.id, ...snapData(d) }))), onErr);
        const b = tasksCol(gid).where('status', '==', 'done').orderBy('completedAt', 'desc').limit(40).onSnapshot(
          q => onDone(q.docs.map(d => ({ id: d.id, ...snapData(d) }))), onErr);
        return () => { a(); b(); };
      },
      newId(gid) { return tasksCol(gid).doc().id; },
      // Shopping list: groups/<gid>/shopping/<item>, shared by the household.
      watchShopping(gid, cb, onErr) {
        return db.collection('groups').doc(gid).collection('shopping').onSnapshot(q => cb(q.docs.map(d => ({ id: d.id, ...snapData(d) }))), onErr);
      },
      newItemId(gid) { return db.collection('groups').doc(gid).collection('shopping').doc().id; },
      setItem(gid, id, data) { db.collection('groups').doc(gid).collection('shopping').doc(id).set(toFs(data)).catch(e => fail(e, 'save that')); return Promise.resolve(id); },
      updateItem(gid, id, patch) { db.collection('groups').doc(gid).collection('shopping').doc(id).update(toFs(patch)).catch(e => fail(e, 'save that')); return Promise.resolve(); },
      deleteItem(gid, id) { db.collection('groups').doc(gid).collection('shopping').doc(id).delete().catch(e => fail(e, 'delete that')); return Promise.resolve(); },
      // Writes go to the offline cache right away; we don't wait for the server so the app feels instant offline.
      setTask(gid, id, data) { tasksCol(gid).doc(id).set(toFs(data)).catch(e => fail(e, 'save that')); return Promise.resolve(id); },
      updateTask(gid, id, patch) { tasksCol(gid).doc(id).update(toFs(patch)).catch(e => fail(e, 'save that')); return Promise.resolve(); },
      deleteTask(gid, id) { tasksCol(gid).doc(id).delete().catch(e => fail(e, 'delete that')); return Promise.resolve(); },
      async createGroup(name, mine, inviteCode) {
        const ref = db.collection('groups').doc();
        const batch = db.batch();
        batch.set(ref, { name, createdBy: uid, createdAt: FV.serverTimestamp(), members: { [uid]: 'owner' }, names: { [uid]: mine }, inviteCode });
        batch.set(db.doc(`users/${uid}`), { groupIds: FV.arrayUnion(ref.id), updatedAt: FV.serverTimestamp() }, { merge: true });
        await batch.commit();
        return ref.id;
      },
      // Comments: groups/<gid>/<kind>/<id>/comments. Posting one also updates the summary on the item and
      // asks the server to notify the others (skipped if offline; the comment still syncs).
      watchComments(gid, kind, id, cb) {
        return db.collection(`groups/${gid}/${kind}/${id}/comments`).orderBy('at').limit(200)
          .onSnapshot(q => cb(q.docs.map(d => ({ id: d.id, ...snapData(d) }))), e => fail(e, 'load the comments'));
      },
      addComment(gid, kind, id, text) {
        const ref = db.collection(`groups/${gid}/${kind}/${id}/comments`).doc();
        const batch = db.batch();
        batch.set(ref, { text, by: uid, at: FV.serverTimestamp() });
        batch.update(db.doc(`groups/${gid}/${kind}/${id}`), {
          commentCount: FV.increment(1), lastComment: text.slice(0, 200), lastCommentBy: uid, lastCommentAt: FV.serverTimestamp(),
          [`seenBy.${uid}`]: Date.now()
        });
        const done = batch.commit();
        done.then(() => firebase.app().functions('us-central1').httpsCallable('notifyComment')({ groupId: gid, kind, itemId: id, commentId: ref.id }))
          .catch(e => console.warn('comment notify', e));
        done.catch(e => fail(e, 'send that'));
        return Promise.resolve(ref.id);
      },
      markSeen(gid, kind, id) {
        return db.doc(`groups/${gid}/${kind}/${id}`).update({ [`seenBy.${uid}`]: Date.now() }).catch(() => {});
      },
      async joinGroup(code, name) {
        const r = await firebase.app().functions('us-central1').httpsCallable('joinGroup')({ code, name });
        return r.data;
      },
      async leaveGroup(gid) {
        await db.doc(`groups/${gid}`).update({ [`members.${uid}`]: FV.delete(), [`names.${uid}`]: FV.delete() });
        await db.doc(`users/${uid}`).set({ groupIds: FV.arrayRemove(gid) }, { merge: true });
      },
      // A calendar feed: feeds/<token> tells the calendarFeed function whose tasks to publish.
      async createFeed(token, gid) {
        const batch = db.batch();
        batch.set(db.doc(`feeds/${token}`), { uid, groupId: gid, createdAt: FV.serverTimestamp() });
        batch.set(db.doc(`users/${uid}`), { feedToken: token }, { merge: true });
        await batch.commit();
      },
      // A Claude connector link: connectors/<token> tells the claudeConnector function who is asking.
      async createConnector(token, gid) {
        const batch = db.batch();
        batch.set(db.doc(`connectors/${token}`), { uid, groupId: gid, createdAt: FV.serverTimestamp() });
        batch.set(db.doc(`users/${uid}`), { claudeToken: token }, { merge: true });
        await batch.commit();
      },
      async deleteConnector(token) {
        if (token) await db.doc(`connectors/${token}`).delete().catch(() => {});
        await db.doc(`users/${uid}`).set({ claudeToken: null }, { merge: true });
      },
      async deleteFeed(token) {
        if (token) await db.doc(`feeds/${token}`).delete().catch(() => {});
        await db.doc(`users/${uid}`).set({ feedToken: null }, { merge: true });
      },
      forgetGroup(gid) { return db.doc(`users/${uid}`).set({ groupIds: FV.arrayRemove(gid) }, { merge: true }); },
      saveToken(token, platform) {
        return db.doc(`users/${uid}`).update(new firebase.firestore.FieldPath('tokens', token), { platform, updatedAt: FV.serverTimestamp() });
      },
      dropToken(token) {
        return db.doc(`users/${uid}`).update(new firebase.firestore.FieldPath('tokens', token), FV.delete());
      },
      signOut() { return firebase.auth().signOut().then(() => location.reload()); }
    };
  }

  // =====================================================================
  // Start-up and sign-in
  // =====================================================================
  function boot() {
    if ('serviceWorker' in navigator && !PREVIEW && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});
    const join = /join=([A-Za-z0-9]+)/.exec(location.hash);
    if (join) { try { localStorage.setItem('sp_join', join[1].toUpperCase()); } catch (e) {} history.replaceState(null, '', location.pathname + location.search); }
    const imp = /import=([A-Za-z0-9_-]+)/.exec(location.hash);
    if (imp) { S.pendingImport = imp[1]; history.replaceState(null, '', location.pathname + location.search); }
    addEventListener('online', netState); addEventListener('offline', netState); netState();
    if (PREVIEW) { B = previewBackend(); return signedIn({ uid: B.uid, email: B.email, displayName: 'Avi' }); }
    if (!C.configured) return renderNotConfigured();
    if (!window.firebase) return renderWelcome('Couldn’t load sign-in. Check your connection and reopen the app.');
    firebase.initializeApp(C.firebase);
    firebase.firestore().enablePersistence({ synchronizeTabs: true }).catch(() => {});
    const auth = firebase.auth();
    // Stay signed in on this device until you sign out (Firebase's default, set explicitly).
    auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(() => {});
    if (auth.isSignInWithEmailLink(location.href)) finishEmailLink();
    auth.getRedirectResult().catch(e => renderWelcome(signInError(e)));
    auth.onAuthStateChanged(u => { if (u) signedIn(u); else renderWelcome(); });
  }

  function netState() { $('#offline').hidden = navigator.onLine !== false || PREVIEW; }

  const onList = email => !Array.isArray(C.allowlist) || C.allowlist.map(e => e.toLowerCase()).includes(String(email || '').toLowerCase());

  function signInError(e) {
    const code = e?.code || '';
    if (/popup-closed|cancelled-popup/.test(code)) return '';
    if (/network/.test(code)) return 'You look offline. Connect and try again.';
    if (/invalid-action-code|expired-action-code/.test(code)) return 'That sign-in link has expired or was already used. Send yourself a new one.';
    return 'Sign-in didn’t work. Try again.';
  }

  async function signInGoogle() {
    const auth = firebase.auth(), provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    try {
      if (isIOS && standalone) await auth.signInWithRedirect(provider);
      else await auth.signInWithPopup(provider);
    } catch (e) {
      if (/popup-blocked|operation-not-supported/.test(e.code || '')) return auth.signInWithRedirect(provider);
      const m = signInError(e); if (m) renderWelcome(m);
    }
  }

  async function sendEmailLink(email) {
    email = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return renderWelcome('Enter your email address.');
    if (!onList(email)) return renderWelcome('That email isn’t on the list for Shared Plate yet.');
    try {
      await firebase.auth().sendSignInLinkToEmail(email, { url: location.origin + '/', handleCodeInApp: true });
      try { localStorage.setItem('sp_email', email); } catch (e) {}
      renderWelcome(null, email);
    } catch (e) { renderWelcome(signInError(e)); }
  }

  async function finishEmailLink() {
    let email = ''; try { email = localStorage.getItem('sp_email') || ''; } catch (e) {}
    if (!email) email = prompt('Confirm the email address you used for the sign-in link') || '';
    try {
      await firebase.auth().signInWithEmailLink(email, location.href);
      try { localStorage.removeItem('sp_email'); } catch (e) {}
    } catch (e) { renderWelcome(signInError(e)); }
    history.replaceState(null, '', location.pathname);
  }

  async function signedIn(user) {
    if (!PREVIEW && !onList(user.email)) {
      app.innerHTML = `<section class="welcome">${plateArt()}<h1>Not on the list yet</h1>
        <p>${esc(user.email)} can’t use Shared Plate yet. Ask the person who set it up to add you.</p>
        <button class="btn quiet" data-act="signout">Sign out</button></section>`;
      return;
    }
    if (!PREVIEW) B = firebaseBackend(user);
    S.uid = B.uid; S.email = B.email;
    let first = true;
    S.unsub.push(B.watchProfile(p => {
      S.profile = p || {};
      if (first) {
        first = false;
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const patch = { email: S.email, tz };
        if (!S.profile.displayName && user.displayName) patch.displayName = user.displayName;
        if (!S.profile.quiet) patch.quiet = { enabled: true, start: '22:00', end: '07:00' };
        if (!PREVIEW) B.saveProfile(patch).catch(() => {});
        afterProfile();
      } else if (S.view === 'settings-open') { /* settings sheet re-renders itself */ }
    }));
  }

  async function afterProfile() {
    let code = ''; try { code = localStorage.getItem('sp_join') || ''; } catch (e) {}
    if (code) {
      try { localStorage.removeItem('sp_join'); } catch (e) {}
      return renderSetup(code);
    }
    pickGroup();
  }

  function pickGroup() {
    const ids = S.profile.groupIds || [];
    if (!ids.length) return renderSetup();
    let saved = ''; try { saved = localStorage.getItem('sp_group') || ''; } catch (e) {}
    startGroup(ids.includes(saved) ? saved : ids[0]);
  }

  function startGroup(gid) {
    S.unsub.splice(1).forEach(u => u && u());
    S.gid = gid; S.loaded = false;
    try { localStorage.setItem('sp_group', gid); } catch (e) {}
    const lost = e => {
      if (/permission/.test(e?.code || '')) {
        // Removed from this household (or it was deleted).
        B.forgetGroup?.(gid).catch(() => {});
        S.group = null; toast('You’re no longer in that household.'); renderSetup();
      } else fail(e, 'load the household');
    };
    S.unsub.push(B.watchGroup(gid, g => {
      if (!g) return lost({ code: 'permission-denied' });
      S.group = g; applyColors(); render();
    }, lost));
    S.unsub.push(B.watchTasks(gid, list => { S.open = list; S.loaded = true; render(); openDeepLink();
      if (S.pendingImport) { const c = S.pendingImport; S.pendingImport = null; openImport(c); } }, list => { S.done = list; if (S.view === 'done' || S.view === 'calendar') render(); }, lost));
    S.shop = [];
    S.unsub.push(B.watchShopping(gid, items => { S.shop = items; if (S.view === 'shopping') renderShopping(); else if (S.view === 'home') render(); if (/shop=/.test(location.hash)) openDeepLink(); }, () => {}));
    refreshPushToken();
  }

  // =====================================================================
  // Screens
  // =====================================================================
  function plateArt() {
    return `<svg class="plate-art" viewBox="0 0 120 120" aria-hidden="true">
      <circle cx="60" cy="60" r="56" fill="var(--surface)"/><circle cx="60" cy="60" r="38" fill="var(--bg)"/>
      <circle cx="60" cy="60" r="47" fill="none" stroke="var(--mine)" stroke-width="12" stroke-dasharray="92 203.3" transform="rotate(-90 60 60)" stroke-linecap="round"/>
      <circle cx="60" cy="60" r="47" fill="none" stroke="var(--theirs)" stroke-width="12" stroke-dasharray="80 215.3" stroke-dashoffset="-100" transform="rotate(-90 60 60)" stroke-linecap="round"/>
      <circle cx="60" cy="60" r="47" fill="none" stroke="var(--shared)" stroke-width="12" stroke-dasharray="96 199.3" stroke-dashoffset="-188" transform="rotate(-90 60 60)" stroke-linecap="round"/>
    </svg>`;
  }

  function renderNotConfigured() {
    app.innerHTML = `<section class="welcome">${plateArt()}<h1>Shared Plate</h1>
      <p>The Firebase settings in config.js aren’t filled in yet, so sign-in is off.</p>
      <a class="btn" href="/?preview">Open the preview</a></section>`;
  }

  function renderWelcome(err, sentTo) {
    if (sentTo) {
      app.innerHTML = `<section class="welcome">${plateArt()}<h1>Check your email</h1>
        <p>We sent a sign-in link to ${esc(sentTo)}. Open it on this phone.</p>
        ${isIOS && standalone ? `<p class="small">On iPhone the link opens in Safari. If you end up signed in there instead of here, come back and use “Continue with Google”.</p>` : ''}
        <button class="link" data-act="welcome">Use a different email</button></section>`;
      return;
    }
    app.innerHTML = `<section class="welcome">${plateArt()}
      <h1>What’s on<br>your plate?</h1>
      <p>One list for the household. Every task has one owner, so nothing gets done twice or not at all.</p>
      <div class="stack">
        <button class="btn block" data-act="google">Continue with Google</button>
        <div class="or">or get a sign-in link by email</div>
        <form class="stack" id="email-form">
          <label class="field"><span>Email</span><input type="email" name="email" autocomplete="email" inputmode="email" required></label>
          <button class="btn quiet block" type="submit">Email me a link</button>
        </form>
        ${err ? `<p class="err" role="alert">${esc(err)}</p>` : ''}
      </div></section>`;
    $('#email-form').onsubmit = e => { e.preventDefault(); sendEmailLink(e.target.email.value); };
  }

  function renderSetup(code, err) {
    S.view = 'setup';
    app.innerHTML = `<section class="welcome">${plateArt()}
      <h1>${code ? 'Join the household' : 'Set the table'}</h1>
      <p>${code ? 'You’ve been invited to share a plate.' : 'Start a household and invite your partner, or join one with a code.'}</p>
      <form class="stack" id="setup-form">
        <label class="field"><span>Your name, as the others will see it</span><input type="text" name="me" maxlength="60" required value="${esc(myName())}"></label>
        ${code ? '' : `<label class="field"><span>Household name</span><input type="text" name="name" maxlength="60" placeholder="Our home"></label>
        <button class="btn block" type="submit" name="act" value="create">Start a household</button>
        <div class="or">or join with an invite code</div>`}
        <label class="field"><span>Invite code</span><input type="text" name="code" maxlength="12" autocapitalize="characters" autocomplete="off" value="${esc(code || '')}" placeholder="8 letters and numbers"></label>
        <button class="btn ${code ? '' : 'quiet'} block" type="submit" name="act" value="join">Join</button>
        ${err ? `<p class="err" role="alert">${esc(err)}</p>` : ''}
      </form>
      ${S.profile.groupIds?.length ? '<button class="link" data-act="home">Back to my household</button>' : ''}
      <button class="link" data-act="signout">Sign out</button></section>`;
    $('#setup-form').onsubmit = async e => {
      e.preventDefault();
      const f = e.target, act = e.submitter?.value || 'join', mine = f.me.value.trim() || 'Me';
      [...f.querySelectorAll('button')].forEach(b => { b.disabled = true; });
      try {
        if (act === 'create') {
          const gid = await B.createGroup((f.name.value.trim() || 'Our home').slice(0, 60), mine, makeCode());
          B.saveProfile({ displayName: mine }).catch(() => {});
          startGroup(gid);
          setTimeout(() => openSettings('invite'), 400);
        } else {
          const c = f.code.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
          if (c.length !== 8) throw { friendly: 'Invite codes are 8 letters and numbers.' };
          const r = await B.joinGroup(c, mine);
          B.saveProfile({ displayName: mine }).catch(() => {});
          toast(`You joined ${r.name || 'the household'}.`);
          startGroup(r.groupId);
        }
      } catch (er) {
        renderSetup(f.code?.value, er.friendly || er.message || 'That didn’t work. Try again.');
      }
    };
  }

  function makeCode() {
    const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', b = new Uint32Array(8);
    crypto.getRandomValues(b);
    return [...b].map(n => A[n % A.length]).join('');
  }

  // ---------- Dashboard ----------
  function render() {
    if (!S.group) return;
    if (S.view === 'done') return renderDone();
    if (S.view === 'shopping') return renderShopping();
    if (S.view === 'calendar') return renderCalendar();
    S.view = 'home';
    const t = now();
    const cats = L.categories(S.open.filter(x => L.effectiveStatus(x, t) === 'open'));
    if (S.cat === undefined) S.cat = savedFilter();
    if (S.cat && !cats.some(c => c.toLowerCase() === S.cat.toLowerCase())) S.cat = '';
    const shown = S.cat ? S.open.filter(x => String(x.category || '').trim().toLowerCase() === S.cat.toLowerCase()) : S.open;
    const l = L.lanes(shown, S.uid, t);
    const counts = { mine: l.mine.length, theirs: l.theirs.length, shared: l.shared.length };
    const others1 = others().length === 1 ? (S.group.names?.[others()[0]] || 'Them') : 'Theirs';
    const date = new Date(t).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    l.today = l.today.filter(x => dailyShowing(x, t));
    const todayN = l.today.length;
    const snoozedIn = k => l.snoozed.filter(x => L.laneOf(x, S.uid) === k);
    app.innerHTML = `
      <header class="top">
        <h1>${esc(S.group.name || 'Shared Plate')}</h1>
        <div style="display:flex;gap:8px;align-items:center">
          ${PREVIEW ? '<span class="preview-flag">Preview</span>' : ''}
          <button class="icon-btn shop-btn" data-act="shopping" aria-label="Shopping list${shopCount() ? `, ${shopCount()} to get` : ''}">${ICON.cart}${shopCount() ? `<span class="badge">${shopCount() > 99 ? '99+' : shopCount()}</span>` : ''}${shopUnread() ? '<span class="new-dot" aria-label="new comments"></span>' : ''}</button>
          <button class="icon-btn" data-act="calendar" aria-label="Calendar">${ICON.cal}</button>
          <button class="icon-btn" data-act="settings" aria-label="Settings">${ICON.gear}</button>
        </div>
      </header>
      <section class="hello">
        ${plate(counts, todayN)}
        <div>
          <h2>${!S.loaded ? 'Loading…' : todayN ? `${todayN} ${todayN === 1 ? 'thing' : 'things'} today` : 'Nothing due today'}</h2>
          <p>${esc(date)}</p>
          ${hebOn() ? `<p class="heb-line"><span class="heb" lang="he" dir="rtl">${esc(Hb.format(t, true))}</span>${holidayHtml(t)}</p>` : ''}
          <div class="legend">
            <span><i class="dot mine"></i>Mine <b>${counts.mine}</b></span>
            <span><i class="dot theirs"></i>${esc(others1)} <b>${counts.theirs}</b></span>
            <span><i class="dot shared"></i>Shared <b>${counts.shared}</b></span>
          </div>
        </div>
      </section>
      ${todayN ? `<nav class="today" aria-label="Due today">${l.today.map(x => chip(x, t)).join('')}</nav>` : ''}
      ${cats.length ? `<nav class="cats" aria-label="Categories">${['', ...cats].map(c => `<button class="cat-chip" data-act="cat" data-cat="${esc(c)}" aria-pressed="${(S.cat || '').toLowerCase() === c.toLowerCase()}">${esc(c || 'All')}</button>`).join('')}</nav>` : ''}
      <div class="lanes">
        ${lane('mine', 'Mine', l.mine, t, 'Nothing on your plate. Nice.', snoozedIn('mine'))}
        ${lane('theirs', theirsTitle(), l.theirs, t, others().length ? 'Nothing on their plate right now.' : 'Invite someone from Settings to share the plate.', snoozedIn('theirs'))}
        ${lane('shared', 'Shared', l.shared, t, 'No shared tasks waiting. Add one for whoever gets to it first.', snoozedIn('shared'))}
      </div>
      <div class="more-row"><button class="btn line" data-act="show-done">Completed</button></div>
      <button class="fab" data-act="add" aria-label="Add a task">${ICON.plus}<span>Add</span></button>`;
    bindSwipes(); bindReorder();
    app.querySelectorAll('details.drawer').forEach(d => d.addEventListener('toggle', () => {
      const set = S.openDrawers || (S.openDrawers = new Set());
      if (d.open) set.add(d.dataset.drawer); else set.delete(d.dataset.drawer);
    }));
  }

  function plate(counts, todayN) {
    const total = counts.mine + counts.theirs + counts.shared;
    const r = 44, Cf = 2 * Math.PI * r, gap = total > 1 ? 7 : 0;
    let off = 0, arcs = '';
    if (!total) arcs = `<circle cx="56" cy="56" r="${r}" fill="none" stroke="var(--line)" stroke-width="14"/>`;
    for (const k of ['mine', 'theirs', 'shared']) {
      if (!counts[k]) continue;
      const len = Math.max(2, Cf * counts[k] / total - gap);
      arcs += `<circle cx="56" cy="56" r="${r}" fill="none" stroke="var(--${k})" stroke-width="14" stroke-linecap="butt"
        stroke-dasharray="${len.toFixed(1)} ${(Cf - len).toFixed(1)}" stroke-dashoffset="${(-off).toFixed(1)}" transform="rotate(-90 56 56)"/>`;
      off += Cf * counts[k] / total;
    }
    return `<svg class="plate" viewBox="0 0 112 112" role="img" aria-label="${counts.mine} mine, ${counts.theirs} theirs, ${counts.shared} shared">
      <circle class="rim" cx="56" cy="56" r="55"/>${arcs}<circle class="well" cx="56" cy="56" r="34"/>
      <text x="56" y="67" text-anchor="middle" font-size="32" font-weight="700">${total}</text></svg>`;
  }

  function chip(x, t) {
    const k = L.laneOf(x, S.uid), late = L.isOverdue(x, t);
    const who = k === 'mine' ? '' : k === 'shared' ? ', shared' : `, ${nameOf(L.responsible(x))}`;
    return `<button class="chip ${k}" data-act="edit" data-id="${esc(x.id)}">
      <span class="when ${late ? 'late' : ''}">${late ? 'Overdue, ' : ''}${esc(L.fmtWhen(x.dueAt, t))}${esc(who)}</span>
      <span class="t">${prio(x)}${esc(x.title)}</span></button>`;
  }

  function lane(k, title, all, t, empty, snoozed) {
    const daily = all.filter(isDaily), weekly = all.filter(isWeekly);
    const far = all.filter(x => recurLead(x) == null && farOut(x, t));
    const list = all.filter(x => (recurLead(x) != null ? dailyShowing(x, t) : !farOut(x, t)));
    const open = S.openDrawers || (S.openDrawers = new Set());
    const drawer = (id, label, items, snz) => items.length ? `<details class="drawer" data-drawer="${k}-${id}" ${open.has(`${k}-${id}`) ? 'open' : ''}>
        <summary>${label} <span class="n">${items.length}</span></summary>
        <ul class="list">${items.map(x => row(x, t, k, snz)).join('')}</ul></details>` : '';
    return `<section class="lane ${k}" aria-label="${esc(title)}">
      <div class="lane-head"><h3>${esc(title)}</h3><span class="count">${list.length}</span></div>
      ${!list.length ? `<div class="empty">${esc(S.cat ? `Nothing in ${S.cat} here.` : daily.length || weekly.length || far.length || snoozed.length ? 'Nothing due right now.' : empty)}</div>`
        : (() => {
          const groups = L.byCategory(list);
          const named = groups.some(g => g.name) && !S.cat;
          return groups.map(g => `${named ? `<h4 class="cat-head">${esc(g.name || 'Other')}</h4>` : ''}<ul class="list" data-sortable="${esc(k + '/' + g.name)}">${g.items.map(x => row(x, t, k, false, true)).join('')}</ul>`).join('');
        })()}
      ${drawer('daily', 'Daily list', daily, false)}
      ${drawer('weekly', 'Weekly list', weekly, false)}
      ${drawer('far', 'More than 2 weeks out', far, false)}
      ${drawer('snoozed', 'Snoozed', snoozed, true)}
    </section>`;
  }

  function row(x, t, k, snoozed, sortable) {
    const meta = [];
    if (snoozed) meta.push(`Back ${esc(L.fmtWhen(x.showAgainOn, t))}`);
    else if (x.dueAt) meta.push(`<span class="${L.isOverdue(x, t) ? 'late' : ''}">${L.isOverdue(x, t) ? 'Overdue, ' : ''}${esc(L.fmtWhen(x.dueAt, t))}</span>`);
    if (L.repeatLabel(x.repeat)) meta.push(esc(L.repeatLabel(x.repeat)));
    if (x.owner === 'shared' && x.claimedBy) meta.push(`<span class="tag">${x.claimedBy === S.uid ? 'Shared, you took it' : `Shared, ${esc(nameOf(x.claimedBy))} took it`}</span>`);
    else if (k === 'theirs' && others().length > 1) meta.push(`<span class="tag">${esc(nameOf(L.responsible(x)))}</span>`);
    if (x.notes) meta.push('Note');
    if (x.commentCount) meta.push(`<span class="${unread(x) ? 'new-comment' : ''}">${unread(x) ? 'New comment' : `${x.commentCount} comment${x.commentCount === 1 ? '' : 's'}`}</span>`);
    if (x.category && (snoozed || S.view === 'calendar')) meta.push(`<span class="tag">${esc(x.category)}</span>`);
    const unclaimed = x.owner === 'shared' && !x.claimedBy && !snoozed;
    const nudge = unclaimed && L.needsNudge(x, t, C.nudgeAfterHours || 24);
    return `<li class="row-wrap lane ${k}${isDaily(x) ? ' compact' : ''}" data-id="${esc(x.id)}"><div class="swipe-hint" aria-hidden="true">Done</div>
      <div class="task" data-id="${esc(x.id)}">
        <button class="check" data-act="done" data-id="${esc(x.id)}" aria-label="Mark done: ${esc(x.title)}"><span></span></button>
        <button class="body" data-act="edit" data-id="${esc(x.id)}">
          <div class="title">${prio(x)}${esc(x.title)}</div>${meta.length ? `<div class="meta">${meta.map(m => `<span>${m}</span>`).join('')}</div>` : ''}
        </button>
        ${unclaimed ? `<button class="take" data-act="take" data-id="${esc(x.id)}">Take it</button>` : '<span></span>'}
        ${sortable ? `<button class="grip" type="button" aria-label="Drag to reorder: ${esc(x.title)}" data-id="${esc(x.id)}">${ICON.grip}</button>` : '<span></span>'}
        ${nudge ? `<div class="nudge">Waiting since ${esc(L.fmtWhen(x.createdAt, t, false))}. Could one of you take it?</div>` : ''}
      </div></li>`;
  }

  function renderDone() {
    S.view = 'done';
    const t = now();
    app.innerHTML = `<header class="top"><button class="icon-btn" data-act="home" aria-label="Back">${ICON.back}</button><h1>Completed</h1><span style="width:48px"></span></header>
      <p class="muted">The last ${S.done.length || 'few'} things you finished. Tap Undo to put one back.</p>
      ${S.done.length ? `<ul class="list done-list">${S.done.map(x => `<li class="row-wrap lane ${L.laneOf(x, S.uid)}"><div class="task">
        <div class="body"><div class="title">${esc(x.title)}</div>
        <div class="meta"><span>${esc(nameOf(x.completedBy))} finished it ${esc(L.fmtWhen(x.completedAt, t))}</span></div></div>
        <button class="btn quiet" style="min-height:44px" data-act="undo" data-id="${esc(x.id)}">Undo</button></div></li>`).join('')}</ul>`
        : '<div class="empty">Nothing finished yet. Swipe a task to the right, or tap its circle, to mark it done.</div>'}`;
  }

  // ---------- Calendar ----------
  // A month of tasks with due dates, colored by who is responsible. Repeating tasks show their upcoming dates too.
  function monthStart(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); d.setDate(1); return d.getTime(); }
  function addMonthsTo(ms, n) { const d = new Date(ms); d.setMonth(d.getMonth() + n); return d.getTime(); }
  const dayKey = ms => dateStr(ms);

  function calendarItems(from, to) {
    const out = [];
    const push = (x, at, extra) => { if (at >= from && at < to) out.push({ x, at, who: L.responsible(x) || 'shared', ...extra }); };
    for (const x of S.open) {
      const due = L.toMs(x.dueAt);
      if (due == null) continue;
      push(x, due, { snoozed: L.effectiveStatus(x, now()) === 'snoozed' });
      // Upcoming copies of repeating tasks show as rings (not for daily ones, which would fill every day).
      if (L.normRepeat(x.repeat) && !isDaily(x)) {
        let next = due;
        for (let i = 0; i < 62; i++) {
          next = L.nextDue(next, x.repeat, next);
          if (!next || next >= to) break;
          push(x, next, { repeat: true, who: x.owner === 'shared' ? 'shared' : x.owner });
        }
      }
    }
    for (const x of S.done) { const due = L.toMs(x.dueAt); if (due != null) push(x, due, { done: true }); }
    return out.sort((a, b) => a.at - b.at);
  }

  const whoName = k => k === 'shared' ? 'Shared' : k === S.uid ? 'You' : nameOf(k);
  // One task in a day's list (the agenda under the month, and each day of the week view).
  function agendaItem(it, t) {
    const at = new Date(it.at), timed = at.getHours() || at.getMinutes();
    return `<li class="row-wrap"><div class="task cal-task" style="--k:${personColor(it.who)}">
      <span class="bar"></span>
      <button class="body" data-act="edit" data-id="${esc(it.x.id)}">
        <div class="title"${it.done ? ' style="text-decoration:line-through"' : ''}>${prio(it.x)}${esc(it.x.title)}</div>
        <div class="meta"><span>${esc(whoName(it.who))}</span>${timed ? `<span>${esc(L.fmtTime(it.at))}</span>` : ''}${it.repeat ? `<span>${esc(L.repeatLabel(it.x.repeat))}</span>` : ''}${it.snoozed ? '<span>Snoozed</span>' : ''}${it.done ? '<span>Done</span>' : ''}${!it.done && !it.repeat && L.isOverdue(it.x, t) ? '<span class="late">Overdue</span>' : ''}</div>
      </button></div></li>`;
  }
  const modeSwitch = () => `<div class="seg cal-mode" role="group" aria-label="Calendar view">
      <button type="button" data-act="cal-mode" data-mode="week" aria-pressed="${S.calMode === 'week'}">Week</button>
      <button type="button" data-act="cal-mode" data-mode="month" aria-pressed="${S.calMode === 'month'}">Month</button></div>`;
  const weekStartOf = ms => { const d = new Date(L.startOfDay(ms)); d.setDate(d.getDate() - d.getDay()); return d.getTime(); };

  // The week view (the default on phones): seven days as a list, so task titles fit.
  function renderWeek() {
    const t = now();
    if (!S.calDay) S.calDay = L.startOfDay(t);
    const ws = weekStartOf(S.calDay);
    const we = new Date(ws); we.setDate(we.getDate() + 7);
    const items = calendarItems(ws, we.getTime());
    const byDay = {};
    for (const it of items) (byDay[dayKey(it.at)] = byDay[dayKey(it.at)] || []).push(it);
    const heb = hebOn(), showParsha = parshaOn(), showDaf = dafOn(), todayKey = dayKey(t);
    const last = new Date(we); last.setDate(last.getDate() - 1);
    const sameMonth = new Date(ws).getMonth() === last.getMonth();
    const range = `${new Date(ws).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${last.toLocaleDateString(undefined, sameMonth ? { day: 'numeric' } : { month: 'short', day: 'numeric' })}`;
    let days = '';
    for (let i = 0; i < 7; i++) {
      const d = new Date(ws); d.setDate(d.getDate() + i);
      const ms = d.getTime(), k = dayKey(ms), list = byDay[k] || [];
      const hs = heb ? Hb.holidays(ms) : [];
      const extras = [
        heb ? `<span class="heb" lang="he" dir="rtl">${esc(Hb.format(ms))}</span>` : '',
        hs.map(h => `<span class="hol ${h.kind}">${esc(h.name)}</span>`).join(''),
        showParsha && d.getDay() === 6 && Hb.parsha(ms) ? `<span class="wk-learn"><b>${esc(Hb.parsha(ms))}</b></span>` : '',
        showDaf ? `<span class="wk-learn">${esc(Hb.dafYomi(ms).masechta)} ${Hb.dafYomi(ms).daf}</span>` : ''
      ].join('');
      days += `<section class="wk-day${k === todayKey ? ' is-today' : ''}" data-day="${ms}">
        <div class="wk-head">
          <div class="wk-date"><span class="wk-dow">${d.toLocaleDateString(undefined, { weekday: 'short' })}</span><span class="wk-num">${d.getDate()}</span></div>
          <div class="wk-extras">${extras}</div>
          <button class="wk-add" data-act="add-on" data-day="${ms}" aria-label="Add a task on ${esc(d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }))}">${ICON.plus}</button>
        </div>
        ${list.length ? `<ul class="list">${list.map(it => agendaItem(it, t)).join('')}</ul>` : ''}
      </section>`;
    }
    const legendKeys = [S.uid, ...others(), 'shared'];
    const hebRange = heb ? (() => { const a = Hb.hebrewMonthName(ws), z = Hb.hebrewMonthName(last.getTime()); return (a === z ? a : `${a} – ${z}`) + ' ' + Hb.gematria(Hb.parts(last.getTime()).year); })() : '';
    app.innerHTML = `<header class="top"><button class="icon-btn" data-act="home" aria-label="Back">${ICON.back}</button><h1>Calendar</h1>
        <button class="icon-btn" data-act="settings" aria-label="Settings">${ICON.gear}</button></header>
      ${modeSwitch()}
      <div class="cal-nav">
        <button class="icon-btn" data-act="cal-prev" aria-label="Previous week">${ICON.back}</button>
        <div class="cal-title"><h2>${esc(range)}</h2>${heb ? `<span class="heb" lang="he" dir="rtl">${esc(hebRange)}</span>` : ''}</div>
        <button class="icon-btn" data-act="cal-next" aria-label="Next week">${ICON.next}</button>
      </div>
      <div class="legend cal-legend">${legendKeys.map(k => `<span><i class="dot" style="background:${personColor(k)}"></i>${esc(whoName(k))}</span>`).join('')}
        ${weekStartOf(t) !== ws ? '<button class="link" data-act="cal-today">This week</button>' : ''}</div>
      <div class="week">${days}</div>
      <button class="fab" data-act="add-on" data-day="${weekStartOf(t) === ws ? L.startOfDay(t) : ws}" aria-label="Add a task">${ICON.plus}<span>Add</span></button>`;
  }

  function renderCalendar() {
    S.view = 'calendar';
    if (!S.calMode) S.calMode = innerWidth < 720 ? 'week' : 'month';
    if (S.calMode === 'week') return renderWeek();
    const t = now();
    if (!S.calMonth) S.calMonth = monthStart(t);
    if (!S.calDay || monthStart(S.calDay) !== S.calMonth) S.calDay = monthStart(t) === S.calMonth ? L.startOfDay(t) : S.calMonth;
    const first = new Date(S.calMonth);
    const gridStart = new Date(first); gridStart.setDate(1 - first.getDay());
    const weeks = Math.ceil((first.getDay() + new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()) / 7);
    const gridEnd = new Date(gridStart); gridEnd.setDate(gridStart.getDate() + weeks * 7);
    const items = calendarItems(gridStart.getTime(), gridEnd.getTime());
    const byDay = {};
    for (const it of items) (byDay[dayKey(it.at)] = byDay[dayKey(it.at)] || []).push(it);
    const todayKey = dayKey(t), selKey = dayKey(S.calDay), heb = hebOn(), showParsha = parshaOn(), showDaf = dafOn();
    let cells = '';
    for (let i = 0; i < weeks * 7; i++) {
      const d = new Date(gridStart); d.setDate(gridStart.getDate() + i);
      const k = dayKey(d.getTime()), list = byDay[k] || [], inMonth = d.getMonth() === first.getMonth();
      const marks = list.slice(0, 4).map(it => `<i class="mark${it.done ? ' done' : ''}${it.repeat ? ' rep' : ''}" style="--c:${personColor(it.who)}"></i>`).join('');
      const peek = list.slice(0, 2).map(it => `<span class="peek${it.done ? ' done' : ''}" style="--c:${personColor(it.who)}">${esc(it.x.title)}</span>`).join('');
      const label = `${d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}, ${list.length ? list.length + (list.length === 1 ? ' task' : ' tasks') : 'nothing scheduled'}`;
      cells += `<button class="day${inMonth ? '' : ' out'}${k === todayKey ? ' is-today' : ''}${k === selKey ? ' sel' : ''}" data-act="cal-day" data-day="${d.getTime()}" aria-label="${esc(label)}" aria-pressed="${k === selKey}">
        <span class="num">${d.getDate()}</span>${heb ? `<span class="hd" lang="he">${esc(Hb.dayLetters(d.getTime()))}</span>${(() => { const hs = Hb.holidays(d.getTime()).filter(h => h.kind !== 'erev'); return hs.length ? `<span class="hol-dot ${hs[0].kind}" title="${esc(hs.map(h => h.name).join(', '))}"></span><span class="hol-name ${hs[0].kind}">${esc(hs[0].name)}</span>` : ''; })()}` : ''}${showParsha && d.getDay() === 6 && Hb.parsha(d.getTime()) ? `<span class="pname">${esc(Hb.parsha(d.getTime()))}</span>` : ''}<span class="marks">${marks}${list.length > 4 ? '<b>+</b>' : ''}</span><span class="peeks">${peek}${list.length > 2 ? `<span class="more-n">+${list.length - 2}</span>` : ''}</span></button>`;
    }
    const sel = byDay[selKey] || [];
    const legendKeys = [S.uid, ...others(), 'shared'];
    const monthName = first.toLocaleDateString(undefined, { month: 'long', year: first.getFullYear() === new Date(t).getFullYear() ? undefined : 'numeric' });
    const selName = new Date(S.calDay).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    app.innerHTML = `<header class="top"><button class="icon-btn" data-act="home" aria-label="Back">${ICON.back}</button><h1>Calendar</h1>
        <button class="icon-btn" data-act="settings" aria-label="Settings">${ICON.gear}</button></header>
      ${modeSwitch()}
      <div class="cal-nav">
        <button class="icon-btn" data-act="cal-prev" aria-label="Previous month">${ICON.back}</button>
        <div class="cal-title"><h2>${esc(monthName)}</h2>${heb ? `<span class="heb" lang="he" dir="rtl">${esc((() => { const a = Hb.hebrewMonthName(gridStart.getTime() + 7 * DAYMS), z = Hb.hebrewMonthName(gridEnd.getTime() - 7 * DAYMS); return (a === z ? a : `${a} – ${z}`) + ' ' + Hb.gematria(Hb.parts(gridEnd.getTime() - 7 * DAYMS).year); })())}</span>` : ''}</div>
        <button class="icon-btn" data-act="cal-next" aria-label="Next month">${ICON.next}</button>
      </div>
      <div class="legend cal-legend">${legendKeys.map(k => `<span><i class="dot" style="background:${personColor(k)}"></i>${esc(whoName(k))}</span>`).join('')}
        ${monthStart(t) !== S.calMonth ? '<button class="link" data-act="cal-today">Today</button>' : ''}</div>
      <div class="cal" role="grid" aria-label="${esc(monthName)}">
        ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(w => `<div class="wd" aria-hidden="true">${w}</div>`).join('')}
        ${cells}
      </div>
      <section class="cal-agenda">
        <h3>${esc(selName)}</h3>
        ${heb ? `<p class="heb-line"><span class="heb" lang="he" dir="rtl">${esc(Hb.format(S.calDay, true))}</span>${holidayHtml(S.calDay)}</p>` : ''}
        ${showParsha || showDaf ? `<p class="learning">${showParsha && Hb.parsha(S.calDay) ? `<span><b>Parshas ${esc(Hb.parsha(S.calDay))}</b>${new Date(S.calDay).getDay() === 6 ? '' : ' this Shabbos'}</span>` : ''}${showDaf ? `<span>Daf Yomi: <b>${esc(Hb.dafYomi(S.calDay).masechta)} ${Hb.dafYomi(S.calDay).daf}</b></span>` : ''}</p>` : ''}
        ${sel.length ? `<ul class="list">${sel.map(it => agendaItem(it, t)).join('')}</ul>`
          : '<div class="empty">Nothing scheduled. Tap Add to put something on this day.</div>'}
      </section>
      <button class="fab" data-act="add-on-day" aria-label="Add a task on ${esc(selName)}">${ICON.plus}<span>Add</span></button>`;
  }

  // ---------- Shopping list ----------
  // One shared list, split into lists like Groceries and Amazon. Tap to check off; tap the name to move or edit.
  const DEFAULT_LISTS = ['Groceries', 'Amazon'];
  const shopCount = () => (S.shop || []).filter(x => !x.checked).length;
  // A comment from someone else that I haven't opened yet.
  const unread = x => !!x && !!x.lastCommentBy && x.lastCommentBy !== S.uid && (L.toMs(x.lastCommentAt) || 0) > ((x.seenBy || {})[S.uid] || 0);
  const shopUnread = () => (S.shop || []).some(unread);
  function shopLists() {
    const used = [...new Set((S.shop || []).map(x => String(x.list || '').trim()).filter(Boolean))];
    const out = [...DEFAULT_LISTS];
    for (const u of used.sort((a, b) => a.localeCompare(b))) if (!out.some(o => o.toLowerCase() === u.toLowerCase())) out.push(u);
    for (const extra of S.newLists || []) if (!out.some(o => o.toLowerCase() === extra.toLowerCase())) out.push(extra);
    return out;
  }
  const sameList = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  function shopItemHtml(x) {
    const sub = [x.note || '', x.checked && x.checkedBy && x.checkedBy !== S.uid ? `${nameOf(x.checkedBy)} got it` : ''].filter(Boolean).join(', ');
    return `<li class="shop-item${x.checked ? ' checked' : ''}" data-id="${esc(x.id)}">
      <button class="shop-check" data-act="shop-toggle" data-id="${esc(x.id)}" role="checkbox" aria-checked="${!!x.checked}" aria-label="${x.checked ? 'Uncheck' : 'Check off'} ${esc(x.name)}"><span></span></button>
      <button class="shop-body" data-act="shop-edit" data-id="${esc(x.id)}">
        <span class="shop-name">${esc(x.name)}</span>${sub ? `<span class="shop-note">${esc(sub)}</span>` : ''}
      </button>
      <button class="chat-btn${unread(x) ? ' unread' : ''}" data-act="shop-chat" data-id="${esc(x.id)}" aria-label="${x.commentCount ? `${x.commentCount} comment${x.commentCount === 1 ? '' : 's'}${unread(x) ? ', new' : ''} on` : 'Ask about'} ${esc(x.name)}">${ICON.chat}${x.commentCount ? `<span class="n">${x.commentCount}</span>` : ''}</button></li>`;
  }
  function renderShopping() {
    S.view = 'shopping';
    const lists = shopLists();
    if (!S.shopList || !lists.some(l => sameList(l, S.shopList))) S.shopList = (() => { try { return localStorage.getItem('sp_shoplist') || lists[0]; } catch (e) { return lists[0]; } })();
    if (!lists.some(l => sameList(l, S.shopList))) S.shopList = lists[0];
    const filter = S.shopFilter || '';
    const shown = filter ? lists.filter(l => sameList(l, filter)) : lists;
    const byTime = (a, b) => (L.toMs(a.createdAt) || 0) - (L.toMs(b.createdAt) || 0);
    const sections = shown.map(l => {
      const items = (S.shop || []).filter(x => sameList(x.list, l));
      const todo = items.filter(x => !x.checked).sort(byTime), got = items.filter(x => x.checked).sort((a, b) => (L.toMs(b.checkedAt) || 0) - (L.toMs(a.checkedAt) || 0));
      if (!items.length && !DEFAULT_LISTS.some(d => sameList(d, l)) && !filter) return '';
      const openKey = 'got-' + l.toLowerCase();
      return `<section class="shop-list" data-list="${esc(l)}">
        <div class="shop-head"><h3>${esc(l)}</h3><span class="count">${todo.length}</span></div>
        ${todo.length ? `<ul class="shop-items">${todo.map(shopItemHtml).join('')}</ul>` : `<div class="empty">Nothing to get from ${esc(l)}.</div>`}
        ${got.length ? `<details class="drawer got" data-drawer="${esc(openKey)}" ${(S.openDrawers || new Set()).has(openKey) ? 'open' : ''}>
          <summary>Checked <span class="n">${got.length}</span></summary>
          <ul class="shop-items">${got.map(shopItemHtml).join('')}</ul>
          <button class="link clear-got" data-act="shop-clear" data-list="${esc(l)}">Clear checked items</button></details>` : ''}
      </section>`;
    }).join('');
    app.innerHTML = `<header class="top"><button class="icon-btn" data-act="home" aria-label="Back">${ICON.back}</button><h1>Shopping</h1><span style="width:44px"></span></header>
      <form class="shop-add" id="shop-add" autocomplete="off">
        <input type="text" name="name" maxlength="400" placeholder="Add to ${esc(S.shopList)}…" aria-label="Add an item" enterkeyhint="done">
        <button class="btn" type="submit" aria-label="Add">${ICON.plus}</button>
      </form>
      <div class="shop-to" role="group" aria-label="Add to which list">${lists.map(l => `<button type="button" class="cat-chip small" data-act="shop-to" data-list="${esc(l)}" aria-pressed="${sameList(l, S.shopList)}">${esc(l)}</button>`).join('')}
        <button type="button" class="cat-chip small" data-act="shop-newlist">+ New list</button></div>
      <p class="muted small shop-tip">Add several at once with commas: milk, eggs, bread.</p>
      ${lists.length > 2 || filter ? `<nav class="cats" aria-label="Show">${['', ...lists].map(l => `<button class="cat-chip" data-act="shop-filter" data-list="${esc(l)}" aria-pressed="${sameList(l, filter)}">${esc(l || 'All lists')}</button>`).join('')}</nav>` : ''}
      <div class="shop-lists">${sections || '<div class="empty">Your shopping list is empty.</div>'}</div>`;
    const f = $('#shop-add');
    f.onsubmit = e => { e.preventDefault(); addShopItems(f.name.value); f.name.value = ''; f.name.focus(); };
    app.querySelectorAll('details.drawer').forEach(d => d.addEventListener('toggle', () => {
      const set = S.openDrawers || (S.openDrawers = new Set());
      if (d.open) set.add(d.dataset.drawer); else set.delete(d.dataset.drawer);
    }));
  }
  function addShopItems(text) {
    const names = String(text || '').split(/[,\n]/).map(x => x.trim()).filter(Boolean).slice(0, 30);
    if (!names.length) return;
    const list = S.shopList || DEFAULT_LISTS[0];
    names.forEach((name, i) => B.setItem(S.gid, B.newItemId ? B.newItemId(S.gid) : 'i' + Date.now() + i, {
      name: name.slice(0, 120), list, note: '', checked: false, addedBy: S.uid, createdAt: 'NOW'
    }));
    toast(names.length === 1 ? `Added to ${list}.` : `Added ${names.length} items to ${list}.`);
  }
  function openShopItem(id) {
    const x = (S.shop || []).find(i => i.id === id);
    if (!x) return;
    let target = x.list || DEFAULT_LISTS[0];
    openSheet(`<form id="item-form" class="stack" autocomplete="off">
      <h2>Edit item</h2>
      <label class="field"><span>Item</span><input type="text" name="name" maxlength="120" required value="${esc(x.name)}"></label>
      <label class="field"><span>Note</span><input type="text" name="note" maxlength="200" value="${esc(x.note || '')}" placeholder="Size, brand, how many…"></label>
      <div class="field"><span>Move to list</span><div class="shop-move">${shopLists().map(l => `<button type="button" class="cat-chip" data-move="${esc(l)}" aria-pressed="${sameList(l, target)}">${esc(l)}</button>`).join('')}</div></div>
      <label class="field"><span>Or a new list</span><input type="text" name="newlist" maxlength="40" placeholder="e.g. Costco, Pharmacy"></label>
      <div class="actions"><button class="btn block" type="submit">Save</button>
        <button type="button" class="btn danger" data-act="shop-delete" data-id="${esc(x.id)}">Delete item</button></div></form>`, sheet => {
      const form = sheet.querySelector('#item-form');
      sheet.querySelector('.shop-move').onclick = e => {
        const b = e.target.closest('[data-move]'); if (!b) return;
        target = b.dataset.move; form.newlist.value = '';
        sheet.querySelectorAll('[data-move]').forEach(o => o.setAttribute('aria-pressed', o === b));
      };
      form.onsubmit = e => {
        e.preventDefault();
        const name = form.name.value.trim(); if (!name) return;
        const list = (form.newlist.value.trim() || target).slice(0, 40);
        const moved = !sameList(list, x.list);
        B.updateItem(S.gid, x.id, { name: name.slice(0, 120), note: form.note.value.trim().slice(0, 200), list });
        closeSheet();
        toast(moved ? `Moved to ${list}.` : 'Saved.');
      };
    });
  }

  // ---------- Comment threads ----------
  const QUICK = {
    shopping: ['Which brand?', 'How many?', 'What size?', 'Do we still need this?'],
    tasks: ['Any more details?', 'When does this need to be done?', 'Can you take this one?', 'Is this done?']
  };
  function threadHtml(kind) {
    return `<section class="thread" aria-label="Comments">
      <ol class="msgs" id="msgs"><li class="muted small">Loading…</li></ol>
      <div class="quick">${QUICK[kind].map(q => `<button type="button" class="cat-chip small" data-quick="${esc(q)}">${esc(q)}</button>`).join('')}</div>
      <form class="say" id="say" autocomplete="off">
        <textarea name="text" rows="1" maxlength="1000" placeholder="${others().length ? `Message ${esc(others().map(o => S.group.names?.[o] || 'them').join(', '))}` : 'Add a comment'}" aria-label="Comment"></textarea>
        <button class="btn" type="submit" aria-label="Send">${ICON.send}</button>
      </form></section>`;
  }
  function bindThread(sheet, kind, id) {
    const box = sheet.querySelector('#msgs'), form = sheet.querySelector('#say');
    const draw = list => {
      box.innerHTML = list.length ? list.map(c => {
        const mine = c.by === S.uid, at = L.toMs(c.at);
        return `<li class="msg${mine ? ' mine' : ''}"><div class="bubble">${esc(c.text)}</div>
          <div class="when">${mine ? 'You' : esc(nameOf(c.by))}${at ? `, ${esc(L.fmtWhen(at, now()))}` : ''}</div></li>`;
      }).join('') : '<li class="muted small">No comments yet. Ask a question and they’ll get a notification.</li>';
      box.scrollTop = box.scrollHeight;
    };
    S.threadUnsub = B.watchComments(S.gid, kind, id, draw);
    B.markSeen(S.gid, kind, id);
    const send = text => {
      text = String(text || '').trim().slice(0, 1000);
      if (!text) return;
      B.addComment(S.gid, kind, id, text);
      form.text.value = ''; form.text.style.height = '';
    };
    form.onsubmit = e => { e.preventDefault(); send(form.text.value); };
    form.text.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(form.text.value); } });
    form.text.addEventListener('input', () => { form.text.style.height = 'auto'; form.text.style.height = Math.min(140, form.text.scrollHeight) + 'px'; });
    sheet.querySelector('.quick').onclick = e => { const b = e.target.closest('[data-quick]'); if (b) send(b.dataset.quick); };
  }
  function openShopChat(id) {
    const x = (S.shop || []).find(i => i.id === id);
    if (!x) return;
    openSheet(`<div class="stack">
      <div class="chat-head"><h2>${esc(x.name)}</h2><span class="muted small">${esc(x.list)}${x.note ? `, ${esc(x.note)}` : ''}</span></div>
      ${threadHtml('shopping')}
      <button class="link" data-act="shop-edit" data-id="${esc(x.id)}">Edit or move this item</button></div>`, sheet => bindThread(sheet, 'shopping', id));
  }

  // =====================================================================
  // Task actions
  // =====================================================================
  const findTask = id => S.open.find(x => x.id === id) || S.done.find(x => x.id === id);

  function markDone(id) {
    const x = findTask(id); if (!x) return;
    const t = now();
    const patch = { status: 'done', completedAt: 'NOW', completedBy: S.uid, notifyAt: null, notifyOnly: null, notifyKind: null, updatedAt: 'NOW' };
    const next = L.nextDue(x.dueAt, x.repeat, t);
    if (next) {
      const nid = B.newId(S.gid);
      const copy = {
        title: x.title, notes: x.notes || '', owner: x.owner, claimedBy: null, status: 'open',
        dueAt: next, repeat: x.repeat, createdBy: S.uid, createdAt: 'NOW', repeatOf: id
      };
      copy.notifyAt = L.notifyAtFor(copy, t);
      B.setTask(S.gid, nid, copy);
      patch.nextId = nid;
    }
    B.updateTask(S.gid, id, patch);
    if (navigator.vibrate) navigator.vibrate(12);
    toast(next ? `Done. Next one ${L.fmtWhen(next, t)}.` : `Done: ${x.title}`, 'Undo', () => undoDone(id));
  }

  function undoDone(id) {
    const x = findTask(id); if (!x) return;
    if (x.nextId) B.deleteTask(S.gid, x.nextId);
    const reopened = { ...x, status: 'open' };
    B.updateTask(S.gid, id, { status: 'open', completedAt: null, completedBy: null, nextId: null, notifyAt: L.notifyAtFor(reopened, now()), updatedAt: 'NOW' });
    toast('Put back on the plate.');
  }

  function take(id) {
    const x = findTask(id); if (!x) return;
    B.updateTask(S.gid, id, { claimedBy: S.uid, claimedAt: 'NOW', notifyOnly: null, updatedAt: 'NOW' });
    toast(`It’s yours: ${x.title}`, 'Undo', () => B.updateTask(S.gid, id, { claimedBy: null, claimedAt: null, updatedAt: 'NOW' }));
  }

  function snooze(id, ms) {
    const x = findTask(id); if (!x) return;
    B.updateTask(S.gid, id, { status: 'snoozed', showAgainOn: ms, notifyAt: ms, notifyOnly: null, notifyKind: null, updatedAt: 'NOW' });
    closeSheet();
    toast(`Snoozed until ${L.fmtWhen(ms, now())}.`, 'Undo', () => {
      B.updateTask(S.gid, id, { status: 'open', showAgainOn: null, notifyAt: L.notifyAtFor({ ...x, status: 'open' }, now()), updatedAt: 'NOW' });
    });
  }

  function unsnooze(id) {
    const x = findTask(id); if (!x) return;
    B.updateTask(S.gid, id, { status: 'open', showAgainOn: null, notifyAt: L.notifyAtFor({ ...x, status: 'open' }, now()), updatedAt: 'NOW' });
    closeSheet();
  }

  // ---------- Swipe right to mark done ----------
  function bindSwipes() {
    app.querySelectorAll('.task[data-id]').forEach(el => {
      let x0 = 0, y0 = 0, dx = 0, active = false, dragging = false;
      el.addEventListener('pointerdown', e => { if (e.button || e.target.closest('.grip')) return; active = true; dragging = false; x0 = e.clientX; y0 = e.clientY; dx = 0; });
      el.addEventListener('pointermove', e => {
        if (!active) return;
        dx = e.clientX - x0; const dy = e.clientY - y0;
        if (!dragging && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.5) { dragging = true; el.classList.add('dragging'); el.parentElement.classList.add('swiping'); try { el.setPointerCapture(e.pointerId); } catch (er) {} }
        if (dragging) el.style.transform = `translateX(${Math.max(0, dx)}px)`;
      });
      const end = () => {
        if (!active) return; active = false;
        el.classList.remove('dragging');
        if (!(dragging && dx > el.offsetWidth * 0.35)) el.parentElement.classList.remove('swiping');
        if (dragging && dx > el.offsetWidth * 0.35) {
          el.style.transform = `translateX(${el.offsetWidth}px)`;
          el.dataset.swiped = '1';
          setTimeout(() => markDone(el.dataset.id), 160);
        } else el.style.transform = '';
        if (dragging) { el.dataset.justDragged = '1'; setTimeout(() => { delete el.dataset.justDragged; }, 50); }
      };
      el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
    });
  }

  // ---------- Drag the handle to reorder within a tile (and category) ----------
  function bindReorder() {
    app.querySelectorAll('ul[data-sortable]').forEach(ul => {
      ul.querySelectorAll('.grip').forEach(grip => {
        grip.addEventListener('pointerdown', e => {
          if (e.button) return;
          e.preventDefault();
          const li = grip.closest('li'), items = [...ul.children];
          if (items.length < 2) return;
          const from = items.indexOf(li), rects = items.map(i => i.getBoundingClientRect());
          const step = rects.length > 1 ? rects[1].top - rects[0].top : li.offsetHeight + 8;
          const y0 = e.clientY; let to = from;
          try { grip.setPointerCapture(e.pointerId); } catch (er) {}
          li.classList.add('lifted');
          const move = ev => {
            const dy = ev.clientY - y0;
            li.style.transform = `translateY(${dy}px)`;
            const mid = rects[from].top + rects[from].height / 2 + dy;
            // The new position is how many of the other tasks now sit above the dragged one.
            to = rects.filter((r, i) => i !== from && r.top + r.height / 2 < mid).length;
            items.forEach((it, i) => {
              if (it === li) return;
              const shift = from < to && i > from && i <= to ? -step : from > to && i >= to && i < from ? step : 0;
              it.style.transform = shift ? `translateY(${shift}px)` : '';
            });
          };
          const up = () => {
            grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up);
            items.forEach(it => { it.style.transform = ''; }); li.classList.remove('lifted');
            if (to === from) return;
            const ids = items.map(i => i.dataset.id);
            const current = Object.fromEntries(ids.map(id => [id, findTask(id)?.order]));
            const changes = L.reorder(ids, from, to, current);
            for (const [id, order] of Object.entries(changes)) B.updateTask(S.gid, id, { order, updatedAt: 'NOW' });
            if (navigator.vibrate) navigator.vibrate(8);
          };
          grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
        });
        // Keyboard: arrow keys move the task up or down.
        grip.addEventListener('keydown', e => {
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
          e.preventDefault();
          const items = [...ul.children], ids = items.map(i => i.dataset.id), from = ids.indexOf(grip.dataset.id);
          const to = Math.max(0, Math.min(ids.length - 1, from + (e.key === 'ArrowUp' ? -1 : 1)));
          if (to === from) return;
          const current = Object.fromEntries(ids.map(id => [id, findTask(id)?.order]));
          for (const [id, order] of Object.entries(L.reorder(ids, from, to, current))) B.updateTask(S.gid, id, { order, updatedAt: 'NOW' });
          setTimeout(() => app.querySelector(`.grip[data-id="${CSS.escape(grip.dataset.id)}"]`)?.focus(), 30);
        });
      });
    });
  }

  // =====================================================================
  // Sheets: add / edit task, settings
  // =====================================================================
  // ---------- Going back ----------
  // Screens and sheets add a browser history entry, so Android's back button, the back arrow, swiping in from the
  // left edge and pulling a sheet down all go back one step.
  const navStack = [];
  let skipPop = 0;
  function pushNav(kind) { navStack.push(kind); try { history.pushState({ sp: navStack.length }, ''); } catch (e) {} }
  function popNav(kind) {
    // Called when we leave a screen or sheet ourselves: drop its history entry quietly.
    const i = navStack.lastIndexOf(kind);
    if (i < 0) return;
    navStack.splice(i, 1); skipPop++;
    try { history.back(); } catch (e) { skipPop--; }
  }
  addEventListener('popstate', () => {
    if (skipPop) { skipPop--; return; }
    const kind = navStack.pop();
    if (kind === 'sheet') closeSheet(true);
    else if (kind === 'view') goHome(true);
  });
  function goHome(fromHistory) {
    if (!fromHistory) popNav('view');
    closeSheet(fromHistory);
    if (S.group && S.view !== 'setup') { S.view = 'home'; render(); window.scrollTo(0, 0); } else pickGroup();
  }
  function openView(view, draw) {
    if (S.view === 'home' || S.view === 'setup') pushNav('view');
    S.view = view; window.scrollTo(0, 0); draw();
  }
  // The back gesture: whatever is on top goes away.
  function goBack() {
    if (sheetRoot.innerHTML) return closeSheet();
    if (S.view === 'calendar' || S.view === 'done' || S.view === 'shopping') return goHome();
  }

  function openSheet(html, onOpen) {
    const wasOpen = !!sheetRoot.innerHTML;
    if (S.threadUnsub) { S.threadUnsub(); S.threadUnsub = null; }
    sheetRoot.innerHTML = `<div class="scrim" data-act="close"></div><div class="sheet" role="dialog" aria-modal="true"><div class="grab" aria-hidden="true"></div>${html}</div>`;
    document.body.style.overflow = 'hidden';
    if (!wasOpen) pushNav('sheet');
    bindSheetPull(sheetRoot.querySelector('.sheet'));
    onOpen && onOpen(sheetRoot.querySelector('.sheet'));
  }
  function closeSheet(fromHistory) {
    if (S.threadUnsub) { S.threadUnsub(); S.threadUnsub = null; }
    if (!sheetRoot.innerHTML) return;
    sheetRoot.innerHTML = ''; document.body.style.overflow = '';
    if (!fromHistory) popNav('sheet');
  }
  addEventListener('keydown', e => { if (e.key === 'Escape' && sheetRoot.innerHTML) closeSheet(); });

  // Pull a sheet down (from its top, when it isn't scrolled) to close it.
  function bindSheetPull(sheet) {
    let y0 = null, dy = 0;
    sheet.addEventListener('touchstart', e => {
      if (sheet.scrollTop > 0 || e.target.closest('input, textarea, select, .grip')) { y0 = null; return; }
      y0 = e.touches[0].clientY; dy = 0;
    }, { passive: true });
    sheet.addEventListener('touchmove', e => {
      if (y0 == null) return;
      dy = e.touches[0].clientY - y0;
      if (dy > 0 && sheet.scrollTop <= 0) { sheet.style.transition = 'none'; sheet.style.transform = `translateY(${dy}px)`; }
    }, { passive: true });
    sheet.addEventListener('touchend', () => {
      if (y0 == null) return;
      sheet.style.transition = ''; y0 = null;
      if (dy > 110) { sheet.style.transform = 'translateY(100%)'; setTimeout(() => closeSheet(), 150); } else sheet.style.transform = '';
    });
  }

  // Swipe in from the left edge of the screen to go back (like iPhone apps). Works on screens and sheets.
  (function edgeSwipe() {
    const EDGE = 28;
    let x0 = null, y0 = 0, dx = 0, target = null, horizontal = false;
    addEventListener('touchstart', e => {
      const t = e.touches[0];
      const canGoBack = sheetRoot.innerHTML || S.view === 'calendar' || S.view === 'done' || S.view === 'shopping';
      if (!canGoBack || t.clientX > EDGE) { x0 = null; return; }
      x0 = t.clientX; y0 = t.clientY; dx = 0; horizontal = false;
      target = sheetRoot.querySelector('.sheet') || app;
    }, { passive: true });
    addEventListener('touchmove', e => {
      if (x0 == null) return;
      const t = e.touches[0];
      dx = t.clientX - x0;
      if (!horizontal && Math.abs(t.clientY - y0) > Math.abs(dx)) { x0 = null; target.style.transform = ''; return; }
      horizontal = true;
      if (dx > 0) { target.style.transition = 'none'; target.style.transform = `translateX(${dx}px)`; target.style.opacity = String(Math.max(0.4, 1 - dx / innerWidth)); }
    }, { passive: true });
    addEventListener('touchend', () => {
      if (x0 == null) return;
      const el = target; x0 = null;
      el.style.transition = 'transform .16s ease, opacity .16s ease';
      if (dx > Math.min(110, innerWidth * 0.28)) {
        el.style.transform = `translateX(${innerWidth}px)`; el.style.opacity = '0';
        setTimeout(() => { el.style.transition = 'none'; el.style.transform = ''; el.style.opacity = ''; goBack(); requestAnimationFrame(() => { el.style.transition = ''; }); }, 160);
      } else { el.style.transform = ''; el.style.opacity = ''; }
    });
  })();

  const pad = n => String(n).padStart(2, '0');
  const dateStr = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const timeStr = ms => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const at8 = ms => { const d = new Date(ms); d.setHours(8, 0, 0, 0); return d.getTime(); };

  function openTask(id, preset) {
    const x = id ? findTask(id) : null;
    if (id && !x) return;
    const t = now();
    const f = {
      owner: x ? x.owner : S.uid,
      repeat: x ? L.normRepeat(x.repeat) : null
    };
    const kind = !f.repeat ? 'none' : (typeof x.repeat === 'string' ? x.repeat : 'custom');
    const due = x ? L.toMs(x.dueAt) : null;
    const presetDate = !x && preset?.day ? dateStr(preset.day) : '';
    const ownerBtn = (val, label, cls) => `<button type="button" class="${cls}" style="--k:${personColor(val)}" data-owner="${esc(val)}" aria-pressed="${f.owner === val}">${esc(label)}</button>`;
    const ownerBtns = [ownerBtn(S.uid, 'Me', 'o-mine'), ...others().map(o => ownerBtn(o, S.group.names?.[o] || 'Them', 'o-theirs')), ownerBtn('shared', 'Shared', 'o-shared')].join('');
    const dn = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    const wd = f.repeat?.weekdays || (due ? [new Date(due).getDay()] : []);
    const snoozed = x && x.status === 'snoozed';
    openSheet(`<form id="task-form" class="stack" autocomplete="off">
      <h2>${x ? 'Edit task' : 'Add a task'}</h2>
      <label class="field"><span>What needs doing?</span><input class="title-input" type="text" name="title" maxlength="200" required value="${esc(x?.title || '')}" placeholder="Call the plumber"></label>
      <div class="field"><span>Whose is it?</span><div class="seg" id="owner-seg">${ownerBtns}</div></div>
      <div class="cat-prio">
        <label class="field"><span>Category</span><input type="text" name="category" maxlength="40" list="cat-list" autocomplete="off" value="${esc(x?.category || (!x && S.cat ? S.cat : ''))}" placeholder="Work, Car, House…">
          <datalist id="cat-list">${allCats().map(c => `<option value="${esc(c)}">`).join('')}</datalist></label>
        <label class="field prio-field"><span>Priority</span><input type="text" name="priority" maxlength="3" autocomplete="off" autocapitalize="characters" value="${esc(x?.priority || '')}" placeholder="—"></label>
      </div>
      <div class="quick-cats">${allCats().slice(0, 8).map(c => `<button type="button" class="cat-chip small" data-qcat="${esc(c)}">${esc(c)}</button>`).join('')}
        <span class="sep"></span>${['1', '2', '3'].map(p => `<button type="button" class="cat-chip small" data-qprio="${p}" aria-label="Priority ${p}">${prio({ priority: p })}</button>`).join('')}</div>
      <details class="more" ${x || presetDate ? 'open' : ''}><summary>Due date, repeat and note</summary><div class="stack">
      <div class="two">
        <label class="field"><span>Due date</span><input type="date" name="date" value="${due ? dateStr(due) : presetDate}"></label>
        <label class="field"><span>Time</span><input type="time" name="time" value="${due ? timeStr(due) : ''}"></label>
      </div>
      <label class="field"><span>Repeat</span><select name="repeat">
        ${[['none', 'Doesn’t repeat'], ['daily', 'Every day'], ['weekly', 'Every week'], ['monthly', 'Every month'], ['custom', 'Custom…']].map(([v, l]) => `<option value="${v}" ${kind === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select></label>
      <div id="custom" class="stack" ${kind === 'custom' ? '' : 'hidden'}>
        <div class="two">
          <label class="field"><span>Every</span><input type="number" name="every" min="1" max="365" value="${f.repeat?.every || 1}"></label>
          <label class="field"><span>Unit</span><select name="unit">${['day', 'week', 'month'].map(u => `<option value="${u}" ${f.repeat?.unit === u ? 'selected' : ''}>${u}s</option>`).join('')}</select></label>
        </div>
        <div class="days" id="days" ${f.repeat?.unit === 'week' ? '' : 'hidden'}>${dn.map((d, i) => `<button type="button" data-day="${i}" aria-pressed="${wd.includes(i)}" aria-label="${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][i]}">${d}</button>`).join('')}</div>
      </div>
      <label class="field"><span>Note</span><textarea name="notes" maxlength="2000" placeholder="Anything the other person should know">${esc(x?.notes || '')}</textarea></label>
      </div></details>
      <p class="err" id="task-err" hidden></p>
      <div class="actions">
        <button class="btn block" type="submit">${x ? 'Save' : 'Add to the plate'}</button>
        ${x ? `<div class="row"><button type="button" class="btn quiet" data-act="done-from-sheet">Mark done</button>
          ${snoozed ? '<button type="button" class="btn quiet" data-act="unsnooze">Bring back now</button>' : '<button type="button" class="btn quiet" data-act="snooze-menu">Snooze</button>'}</div>
          <div id="snooze-opts" class="snooze-opts" hidden>
            <button type="button" class="btn line" data-snooze="${at8(t + DAYMS)}">Tomorrow</button>
            <button type="button" class="btn line" data-snooze="${at8(t + ((6 - new Date(t).getDay() + 7) % 7 || 7) * DAYMS)}">Saturday</button>
            <button type="button" class="btn line" data-snooze="${at8(t + ((8 - new Date(t).getDay()) % 7 || 7) * DAYMS)}">Next Monday</button>
            <label class="field" style="flex:1 1 100%"><span>Or pick a date (it comes back at 8am)</span><input type="date" id="snooze-date" min="${dateStr(t + DAYMS)}"></label>
          </div>
          <button type="button" class="btn danger" data-act="delete">Delete task</button>` : ''}
      </div></form>
      ${x ? `<h3 class="thread-title">Comments</h3>${threadHtml('tasks')}` : ''}`, sheet => {
      if (x) bindThread(sheet, 'tasks', x.id);
      const form = sheet.querySelector('#task-form');
      if (!x) setTimeout(() => form.title.focus(), 60);
      sheet.querySelector('#owner-seg').onclick = e => {
        const b = e.target.closest('[data-owner]'); if (!b) return;
        f.owner = b.dataset.owner;
        sheet.querySelectorAll('[data-owner]').forEach(o => o.setAttribute('aria-pressed', o === b));
      };
      sheet.querySelector('.quick-cats').onclick = e => {
        const c = e.target.closest('[data-qcat]'), p = e.target.closest('[data-qprio]');
        if (c) form.category.value = form.category.value === c.dataset.qcat ? '' : c.dataset.qcat;
        if (p) form.priority.value = form.priority.value === p.dataset.qprio ? '' : p.dataset.qprio;
      };
      form.repeat.onchange = () => { sheet.querySelector('#custom').hidden = form.repeat.value !== 'custom'; };
      form.unit.onchange = () => { sheet.querySelector('#days').hidden = form.unit.value !== 'week'; };
      sheet.querySelector('#days').onclick = e => {
        const b = e.target.closest('[data-day]'); if (b) b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') !== 'true');
      };
      sheet.querySelector('[data-act=snooze-menu]')?.addEventListener('click', () => { sheet.querySelector('#snooze-opts').hidden = false; });
      sheet.querySelectorAll('[data-snooze]').forEach(b => { b.onclick = () => snooze(x.id, +b.dataset.snooze); });
      sheet.querySelector('#snooze-date')?.addEventListener('change', e => { if (e.target.value) snooze(x.id, at8(new Date(e.target.value + 'T00:00').getTime())); });
      sheet.querySelector('[data-act=done-from-sheet]')?.addEventListener('click', () => { closeSheet(); markDone(x.id); });
      sheet.querySelector('[data-act=unsnooze]')?.addEventListener('click', () => unsnooze(x.id));
      sheet.querySelector('[data-act=delete]')?.addEventListener('click', () => {
        const keep = { ...x, createdBy: S.uid, createdAt: 'NOW' }; delete keep.id;
        B.deleteTask(S.gid, x.id); closeSheet();
        toast('Deleted.', 'Undo', () => B.setTask(S.gid, x.id, keep));
      });
      form.onsubmit = e => {
        e.preventDefault();
        const title = form.title.value.trim();
        if (!title) return;
        let dueAt = null;
        if (form.date.value) dueAt = new Date(`${form.date.value}T${form.time.value || '09:00'}`).getTime();
        else if (form.time.value) { // a time with no date means the next time that clock time comes round
          dueAt = new Date(`${dateStr(now())}T${form.time.value}`).getTime();
          if (dueAt <= now()) dueAt += DAYMS;
        }
        let repeat = form.repeat.value;
        if (repeat === 'custom') {
          const days = [...sheet.querySelectorAll('[data-day][aria-pressed=true]')].map(b => +b.dataset.day);
          repeat = { every: Math.max(1, Math.min(365, +form.every.value || 1)), unit: form.unit.value };
          if (repeat.unit === 'week' && days.length) repeat.weekdays = days;
        }
        if (repeat !== 'none' && !dueAt) {
          const err = sheet.querySelector('#task-err'); err.hidden = false; err.textContent = 'Pick a due date so we know when it repeats.'; return;
        }
        const data = {
          title, notes: form.notes.value.trim(), owner: f.owner,
          category: form.category.value.trim().slice(0, 40), priority: form.priority.value.trim().slice(0, 3),
          claimedBy: f.owner === 'shared' ? (x?.owner === 'shared' ? (x.claimedBy || null) : null) : null,
          dueAt, repeat, updatedAt: 'NOW', notifyOnly: null, notifyKind: null
        };
        if (x) {
          const status = x.status === 'done' ? 'done' : x.status;
          data.notifyAt = L.notifyAtFor({ ...x, ...data, status }, now());
          B.updateTask(S.gid, x.id, data);
          toast('Saved.');
        } else {
          Object.assign(data, { status: 'open', createdBy: S.uid, createdAt: 'NOW' });
          data.notifyAt = L.notifyAtFor(data, now());
          const where = f.owner === 'shared' ? 'Shared' : f.owner === S.uid ? 'your plate' : `${nameOf(f.owner)}’s plate`;
          B.setTask(S.gid, B.newId(S.gid), data);
          toast(`Added to ${where}.`);
        }
        closeSheet();
      };
    });
  }

  // ---------- Settings ----------
  function pushState() {
    if (PREVIEW) return 'preview';
    if (isIOS && !standalone) return 'ios-install';
    if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported';
    if (!C.vapidKey) return 'no-key';
    if (Notification.permission === 'denied') return 'blocked';
    if (Notification.permission === 'granted') { let tok = ''; try { tok = localStorage.getItem('sp_token') || ''; } catch (e) {} return tok ? 'on' : 'off'; }
    return 'off';
  }

  function pushSection() {
    const st = pushState();
    const body = {
      preview: '<p class="muted small">Notifications are off in the preview.</p>',
      'ios-install': `<p>On iPhone, notifications work once Shared Plate is on your home screen:</p>
        <ol class="steps"><li>Tap the Share button at the bottom of Safari.</li><li>Choose <b>Add to Home Screen</b>, then <b>Add</b>.</li>
        <li>Open Shared Plate from your home screen and come back here.</li></ol><p class="muted small">Needs iOS 16.4 or newer.</p>`,
      unsupported: '<p class="muted small">This browser can’t show notifications. On Android use Chrome; on iPhone add the app to your home screen from Safari.</p>',
      'no-key': '<p class="muted small">Notifications aren’t set up yet (the Web Push key in config.js is empty).</p>',
      blocked: `<p>Notifications are blocked for Shared Plate. ${isIOS ? 'Open iPhone Settings → Notifications → Shared Plate and allow them.' : 'Allow them in your browser’s site settings, then come back.'}</p>`,
      on: '<p>Reminders come to this phone when tasks are due and when snoozed tasks come back.</p><button class="btn line" data-act="push-off">Turn off on this phone</button>',
      off: '<p>Get a reminder on this phone when a task is due or a snoozed task comes back.</p><button class="btn block" data-act="push-on">Turn on notifications</button>'
    }[st];
    return `<section class="settings-section" id="push-section"><h3>Notifications</h3>${body}</section>`;
  }

  function openSettings(focus) {
    const q = S.profile.quiet || { enabled: true, start: '22:00', end: '07:00' };
    const p = S.profile.prefs || {};
    const link = `${location.origin}/#join=${S.group.inviteCode}`;
    const mem = members().map(u => `<li><span>${esc(S.group.names?.[u] || 'Someone')}${u === S.uid ? ' (you)' : ''}${S.group.members[u] === 'owner' ? ', owner' : ''}</span>
      ${isOwner() && u !== S.uid ? `<button class="link" data-remove="${esc(u)}">Remove</button>` : ''}</li>`).join('');
    openSheet(`<div class="stack">
      <h2>Settings</h2>
      ${pushSection()}
      <section class="settings-section"><h3>Quiet hours</h3>
        <label class="toggle"><span>Hold reminders overnight</span><input type="checkbox" id="q-on" ${q.enabled !== false ? 'checked' : ''}></label>
        <div class="two"><label class="field"><span>From</span><input type="time" id="q-start" value="${esc(q.start || '22:00')}"></label>
        <label class="field"><span>Until</span><input type="time" id="q-end" value="${esc(q.end || '07:00')}"></label></div>
        <p class="muted small">Reminders that land in quiet hours arrive when they end. This is just for you.</p>
        <label class="toggle"><span>When a task is due</span><input type="checkbox" id="p-due" ${p.due !== false ? 'checked' : ''}></label>
        <label class="toggle"><span>When a snoozed task comes back</span><input type="checkbox" id="p-back" ${p.back !== false ? 'checked' : ''}></label>
        <label class="toggle"><span>When someone comments</span><input type="checkbox" id="p-comments" ${p.comments !== false ? 'checked' : ''}></label>
      </section>
      <section class="settings-section" id="calendar-settings"><h3>Calendar</h3>
        ${Hb && Hb.supported ? `<label class="toggle"><span>Show Hebrew dates and holidays</span><input type="checkbox" id="p-hebrew" ${hebOn() ? 'checked' : ''}></label>
        <p class="muted small">Yamim Tovim, fasts, Chanukah, Purim and Rosh Chodesh, as kept outside Israel.</p>
        <label class="toggle"><span>Show the weekly parsha</span><input type="checkbox" id="p-parsha" ${parshaOn() ? 'checked' : ''}></label>
        <label class="toggle"><span>Show the Daf Yomi</span><input type="checkbox" id="p-daf" ${dafOn() ? 'checked' : ''}></label>` : '<p class="muted small">This browser can’t show Hebrew dates.</p>'}
        <div id="feed-box">${feedHtml()}</div>
      </section>
      <section class="settings-section" id="claude"><h3>Connect to Claude</h3>
        <div id="claude-box">${claudeHtml()}</div>
      </section>
      <section class="settings-section" id="colors"><h3>Colors</h3>
        <p class="muted small">Used in the lanes and the calendar, on everyone’s phone.</p>
        ${[...members(), 'shared'].map(k => `<div class="color-row" data-key="${esc(k)}">
          <span class="color-name"><i class="dot" style="background:${personColor(k)}"></i>${esc(k === 'shared' ? 'Shared' : (S.group.names?.[k] || 'Someone') + (k === S.uid ? ' (you)' : ''))}</span>
          <div class="swatches" role="group" aria-label="Color for ${esc(k === 'shared' ? 'shared tasks' : S.group.names?.[k] || 'this person')}">
            ${PALETTE.map(c => `<button type="button" class="swatch" style="background:${c}" data-color="${c}" aria-label="${c}" aria-pressed="${customColor(k) === c}"></button>`).join('')}
            <label class="swatch custom" aria-label="Custom color"><input type="color" value="${customColor(k) || '#888888'}" data-custom></label>
          </div></div>`).join('')}
        <button class="link" data-act="colors-reset" ${S.group.colors && Object.keys(S.group.colors).length ? '' : 'hidden'}>Back to the original colors</button>
      </section>
      <section class="settings-section" id="invite"><h3>${esc(S.group.name)}</h3>
        <ul class="members">${mem}</ul>
        <p class="muted small">Invite someone with this code or link:</p>
        <div class="code">${esc(S.group.inviteCode)}</div>
        <button class="btn quiet" data-act="share-invite" data-link="${esc(link)}">Share invite link</button>
        ${isOwner() ? `<label class="field"><span>Household name</span><input type="text" id="g-name" maxlength="60" value="${esc(S.group.name)}"></label>
          <button class="link" data-act="new-code">Make a new code (the old one stops working)</button>` : '<button class="link" data-act="leave">Leave this household</button>'}
      </section>
      <section class="settings-section"><h3>Import tasks</h3>
        <p class="muted small">Paste an import code or link to add a list of tasks to your plate.</p>
        <textarea id="import-code" rows="3" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Import code"></textarea>
        <button class="btn quiet" data-act="import-preview">Preview</button>
      </section>
      <section class="settings-section"><h3>You</h3>
        <label class="field"><span>Your name in this household</span><input type="text" id="my-name" maxlength="60" value="${esc(myName())}"></label>
        <p class="muted small">Signed in as ${esc(S.email)}</p>
        <button class="btn line" data-act="signout">Sign out</button>
      </section>
      <button class="btn block" data-act="close">Done</button>
    </div>`, sheet => {
      const saveQuiet = () => B.saveProfile({
        quiet: { enabled: sheet.querySelector('#q-on').checked, start: sheet.querySelector('#q-start').value || '22:00', end: sheet.querySelector('#q-end').value || '07:00' },
        prefs: { due: sheet.querySelector('#p-due').checked, back: sheet.querySelector('#p-back').checked, comments: sheet.querySelector('#p-comments').checked }
      }).catch(e => fail(e, 'save quiet hours'));
      ['#q-on', '#q-start', '#q-end', '#p-due', '#p-back', '#p-comments'].forEach(s => sheet.querySelector(s).addEventListener('change', saveQuiet));
      [['#p-hebrew', 'hebrew'], ['#p-parsha', 'parsha'], ['#p-daf', 'daf']].forEach(([sel, key]) => sheet.querySelector(sel)?.addEventListener('change', e => {
        S.profile.prefs = { ...(S.profile.prefs || {}), [key]: e.target.checked };
        B.saveProfile({ prefs: { [key]: e.target.checked } }).catch(er => fail(er, 'save that setting'));
        render();
      }));
      sheet.querySelector('#my-name').addEventListener('change', e => {
        const v = e.target.value.trim().slice(0, 60); if (!v) return;
        B.updateGroup(S.gid, { [`names.${S.uid}`]: v }).catch(er => fail(er, 'save your name'));
        B.saveProfile({ displayName: v }).catch(() => {});
      });
      sheet.querySelector('#g-name')?.addEventListener('change', e => {
        const v = e.target.value.trim().slice(0, 60); if (v) B.updateGroup(S.gid, { name: v }).catch(er => fail(er, 'rename the household'));
      });
      sheet.querySelectorAll('[data-remove]').forEach(b => {
        b.onclick = () => {
          const u = b.dataset.remove;
          if (!confirm(`Remove ${S.group.names?.[u] || 'this person'} from the household? Their tasks stay.`)) return;
          B.updateGroup(S.gid, { [`members.${u}`]: undefined, [`names.${u}`]: undefined }).then(() => { closeSheet(); openSettings(); }).catch(er => fail(er, 'remove them'));
        };
      });
      const setColor = (key, c) => {
        if (!HEX.test(c)) return;
        c = c.toLowerCase();
        const r = sheet.querySelector(`.color-row[data-key="${CSS.escape(key)}"]`);
        r.querySelectorAll('[data-color]').forEach(b => b.setAttribute('aria-pressed', b.dataset.color === c));
        r.querySelector('.dot').style.background = c;
        sheet.querySelector('[data-act=colors-reset]').hidden = false;
        B.updateGroup(S.gid, { [`colors.${key}`]: c }).then(() => refreshColors(sheet)).catch(er => fail(er, 'save the color'));
      };
      sheet.querySelectorAll('.color-row').forEach(r => {
        r.addEventListener('click', e => { const b = e.target.closest('[data-color]'); if (b) setColor(r.dataset.key, b.dataset.color); });
        r.querySelector('[data-custom]').addEventListener('change', e => setColor(r.dataset.key, e.target.value));
      });
      if (focus) sheet.querySelector('#' + focus)?.scrollIntoView({ block: 'start' });
    });
  }

  // ---------- Calendar feed (Google Calendar / Apple Calendar) ----------
  function feedUrls(who) {
    const token = S.profile.feedToken;
    const https = `${location.origin}/cal/${token}.ics${who === 'all' ? '?who=all' : ''}`;
    const webcal = https.replace(/^https?:/, 'webcal:');
    return { https, webcal, google: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}` };
  }
  function feedHtml() {
    if (!S.profile.feedToken) return `<div class="feed">
      <h4>Show tasks in your calendar</h4>
      <p class="muted small">Get a private link that Google Calendar or Apple Calendar can subscribe to. Tasks with a due date show up there and stay up to date.</p>
      <button class="btn quiet" data-act="feed-make">Make a calendar link</button></div>`;
    const who = S.feedWho || 'mine', u = feedUrls(who);
    return `<div class="feed">
      <h4>Show tasks in your calendar</h4>
      <div class="seg" role="group" aria-label="Which tasks">
        <button type="button" data-act="feed-who" data-who="mine" aria-pressed="${who === 'mine'}">Mine and shared</button>
        <button type="button" data-act="feed-who" data-who="all" aria-pressed="${who === 'all'}">Everyone’s</button>
      </div>
      <a class="btn block" href="${esc(u.webcal)}">Add to Apple Calendar</a>
      <a class="btn quiet block" href="${esc(u.google)}" target="_blank" rel="noopener">Add to Google Calendar</a>
      <button class="btn line block" data-act="feed-copy" data-url="${esc(u.https)}">Copy link</button>
      <p class="muted small">Calendars check for changes on their own schedule: Apple about every hour, Google every few hours. In Google Calendar on a phone, open the link in a browser, since the app can’t add calendars by link.</p>
      <p class="muted small">Anyone with the link can see these tasks. <button class="link" data-act="feed-off">Turn off this link</button></p></div>`;
  }
  // ---------- Claude connector (one private link per person) ----------
  function claudeHtml() {
    const token = S.profile.claudeToken;
    if (!token) return `<p class="muted small">Add and check tasks by asking Claude, like “remind Leah to call the plumber Tuesday at 10”. Each of you makes your own link on your own phone, so Claude knows who “me” is.</p>
      <button class="btn quiet" data-act="claude-make">Make my Claude link</button>`;
    const url = `${location.origin}/mcp/${token}`;
    return `<label class="field"><span>Your Claude link</span><input type="text" readonly value="${esc(url)}" id="claude-url" onclick="this.select()"></label>
      <button class="btn block" data-act="claude-copy" data-url="${esc(url)}">Copy link</button>
      <ol class="steps small">
        <li>Open <b>claude.ai</b> (on a computer, or in your phone’s browser) and go to <b>Customize → Connectors</b>.</li>
        <li>Tap <b>+ Add</b>, then <b>Add custom connector</b>. Name it <b>Shared Plate</b> and paste your link.</li>
        <li>Tap <b>Continue</b>, choose <b>No sign in</b>, then <b>Add</b>.</li>
        <li>In a chat, turn it on under <b>+ → Connectors</b>, then ask away.</li>
      </ol>
      <p class="muted small">The link is yours only: tasks added through it count as added by you. Anyone with it can see and change your household’s tasks, so keep it private. <button class="link" data-act="claude-off">Turn off this link</button></p>`;
  }
  const refreshClaude = () => { const box = $('#claude-box'); if (box) box.innerHTML = claudeHtml(); };

  const refreshFeed = () => { const box = $('#feed-box'); if (box) box.innerHTML = feedHtml(); };
  function makeFeedToken() {
    const a = new Uint8Array(24); crypto.getRandomValues(a);
    return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // Repaints the Colors section after a change, without closing Settings.
  function refreshColors(sheet) {
    setTimeout(() => {
      sheet.querySelectorAll('.color-row').forEach(r => {
        const k = r.dataset.key;
        r.querySelector('.dot').style.background = personColor(k);
        r.querySelectorAll('[data-color]').forEach(b => b.setAttribute('aria-pressed', customColor(k) === b.dataset.color));
      });
    }, 50);
  }

  async function enablePush() {
    const btn = $('[data-act=push-on]'); if (btn) btn.disabled = true;
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { toast('Notifications weren’t allowed.'); return refreshPushSection(); }
      const tok = await getPushToken();
      if (tok) toast('Notifications are on for this phone.');
    } catch (e) { fail(e, 'turn on notifications'); }
    refreshPushSection();
  }

  async function getPushToken() {
    if (PREVIEW || !window.firebase?.messaging || !C.vapidKey) return null;
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    const token = await firebase.messaging().getToken({ vapidKey: C.vapidKey, serviceWorkerRegistration: reg });
    if (!token) return null;
    await B.saveToken(token, isIOS ? 'ios' : /Android/.test(navigator.userAgent) ? 'android' : 'web');
    try { localStorage.setItem('sp_token', token); } catch (e) {}
    if (!window.__spOnMsg) {
      window.__spOnMsg = true;
      firebase.messaging().onMessage(m => toast(m.notification?.title || 'Reminder'));
    }
    return token;
  }

  // Keeps this phone's token fresh each time the app opens (tokens can change).
  function refreshPushToken() {
    if (PREVIEW || !C.vapidKey || (isIOS && !standalone) || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    getPushToken().catch(() => {});
  }

  async function disablePush() {
    let tok = ''; try { tok = localStorage.getItem('sp_token') || ''; } catch (e) {}
    try {
      if (tok) await B.dropToken(tok);
      await firebase.messaging().deleteToken().catch(() => {});
      try { localStorage.removeItem('sp_token'); } catch (e) {}
      toast('Notifications are off for this phone.');
    } catch (e) { fail(e, 'turn off notifications'); }
    refreshPushSection();
  }
  function refreshPushSection() { const s = $('#push-section'); if (s) s.outerHTML = pushSection(); }

  // ---------- Import a list of tasks ----------
  // An import code is base64url JSON: { v: 1, tasks: [{ title, status: open|snoozed|done, back: 'YYYY-MM-DD', due: 'YYYY-MM-DD[THH:MM]', notes, owner: 'me'|'shared' }] }.
  // Everything lands on the importer's plate unless owner is 'shared'. Open tasks already on the plate (same title) are skipped.
  function parseImport(text) {
    let raw = String(text || '').trim();
    const m = /import=([A-Za-z0-9_-]+)/.exec(raw); if (m) raw = m[1];
    let data;
    try {
      if (raw.startsWith('{')) data = JSON.parse(raw);
      else {
        const bin = atob(raw.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, ''));
        data = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
      }
    } catch (e) { return null; }
    const list = Array.isArray(data) ? data : data && data.tasks;
    if (!Array.isArray(list)) return null;
    const day = (s, h) => { const r = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(s || ''); return r ? new Date(+r[1], r[2] - 1, +r[3], r[4] != null ? +r[4] : h, r[5] != null ? +r[5] : 0).getTime() : null; };
    return list.slice(0, 200).map(x => {
      const title = String(x.title || '').trim().slice(0, 200);
      if (!title) return null;
      let status = ['open', 'snoozed', 'done'].includes(x.status) ? x.status : 'open';
      const back = day(x.back, 8);
      if (status === 'snoozed' && !(back > now())) status = 'open';
      return { title, status, back: status === 'snoozed' ? back : null, due: day(x.due, 9), notes: String(x.notes || '').slice(0, 2000), shared: x.owner === 'shared',
        category: String(x.category || '').trim().slice(0, 40), priority: String(x.priority || '').trim().slice(0, 3) };
    }).filter(Boolean);
  }

  function openImport(text) {
    const items = parseImport(text);
    if (!items) return toast('That import code isn’t complete. Copy the whole code and try again.');
    const have = new Set(S.open.map(x => x.title.trim().toLowerCase()));
    const fresh = items.filter(x => !have.has(x.title.toLowerCase()));
    const skipped = items.length - fresh.length;
    const n = k => fresh.filter(x => x.status === k).length;
    const t = now();
    openSheet(`<div class="stack">
      <h2>Add ${fresh.length} ${fresh.length === 1 ? 'task' : 'tasks'}?</h2>
      <p class="muted">${n('open')} open, ${n('snoozed')} snoozed and ${n('done')} already done (those go to Completed).
        They go on your plate${fresh.some(x => x.shared) ? ', except the ones marked shared' : ''}.${skipped ? ` ${skipped} already on the plate will be skipped.` : ''}</p>
      <ul class="list import-list">${fresh.map(x => `<li class="row-wrap lane ${x.shared ? 'shared' : 'mine'}"><div class="task" style="grid-template-columns:1fr">
        <div class="body"><div class="title" ${x.status === 'done' ? 'style="text-decoration:line-through"' : ''}>${esc(x.title)}</div>
        <div class="meta">${x.status === 'snoozed' ? `<span>Back ${esc(L.fmtWhen(x.back, t))}</span>` : ''}${x.due ? `<span>Due ${esc(L.fmtWhen(x.due, t))}</span>` : ''}${x.status === 'done' ? '<span>Done</span>' : ''}${x.notes ? '<span>Note</span>' : ''}</div></div></div></li>`).join('')}</ul>
      <button class="btn block" data-act="import-go" ${fresh.length ? '' : 'disabled'}>Add ${fresh.length} to the plate</button>
      <button class="btn quiet block" data-act="close">Cancel</button>
    </div>`, sheet => {
      sheet.querySelector('[data-act=import-go]').onclick = () => {
        for (const x of fresh) {
          const d = {
            title: x.title, notes: x.notes, owner: x.shared ? 'shared' : S.uid, claimedBy: null, status: x.status,
            dueAt: x.due, repeat: 'none', createdBy: S.uid, createdAt: 'NOW', updatedAt: 'NOW', category: x.category, priority: x.priority
          };
          if (x.status === 'snoozed') d.showAgainOn = x.back;
          if (x.status === 'done') { d.completedAt = 'NOW'; d.completedBy = S.uid; }
          d.notifyAt = L.notifyAtFor({ ...d, showAgainOn: x.back }, now());
          B.setTask(S.gid, B.newId(S.gid), d);
        }
        closeSheet();
        toast(`Added ${fresh.length} ${fresh.length === 1 ? 'task' : 'tasks'}.`);
      };
    });
  }

  // ---------- Deep links from notifications: #task=groupId/taskId ----------
  function openDeepLink() {
    const sm = /shop=([^&]+)/.exec(location.hash);
    if (sm) {
      const [gid, iid] = decodeURIComponent(sm[1]).split('/');
      if (gid !== S.gid) { if ((S.profile.groupIds || []).includes(gid)) startGroup(gid); return; }
      if (!(S.shop || []).some(i => i.id === iid)) return; // wait for the list to load
      history.replaceState(null, '', location.pathname + location.search);
      if (S.view !== 'shopping') openView('shopping', renderShopping);
      return openShopChat(iid);
    }
    const m = /task=([^&]+)/.exec(location.hash);
    if (!m) return;
    const [gid, tid] = decodeURIComponent(m[1]).split('/');
    if (gid !== S.gid) { if ((S.profile.groupIds || []).includes(gid)) { startGroup(gid); } return; }
    history.replaceState(null, '', location.pathname + location.search);
    if (findTask(tid)) openTask(tid);
  }
  addEventListener('hashchange', () => { if (S.loaded) openDeepLink(); });

  // =====================================================================
  // Clicks
  // =====================================================================
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-act]'); if (!el) return;
    const task = el.closest('.task');
    if (task?.dataset.justDragged || task?.dataset.swiped) return;
    const id = el.dataset.id, act = el.dataset.act;
    switch (act) {
      case 'google': return signInGoogle();
      case 'welcome': return renderWelcome();
      case 'signout': return B ? B.signOut() : firebase.auth().signOut().then(() => location.reload());
      case 'add': return openTask(null);
      case 'edit': return openTask(id);
      case 'done': return markDone(id);
      case 'take': return take(id);
      case 'undo': return undoDone(id);
      case 'settings': return openSettings();
      case 'close': return closeSheet();
      case 'show-done': return openView('done', renderDone);
      case 'cat': S.cat = el.dataset.cat; try { localStorage.setItem('sp_cat', S.cat); } catch (er) {} return render();
      case 'feed-make': {
        const token = makeFeedToken();
        el.disabled = true;
        return B.createFeed(token, S.gid).then(() => { S.profile.feedToken = token; refreshFeed(); }).catch(er => { el.disabled = false; fail(er, 'make the link'); });
      }
      case 'claude-make': {
        const token = makeFeedToken();
        el.disabled = true;
        return B.createConnector(token, S.gid).then(() => { S.profile.claudeToken = token; refreshClaude(); }).catch(er => { el.disabled = false; fail(er, 'make the link'); });
      }
      case 'claude-copy': return navigator.clipboard?.writeText(el.dataset.url).then(() => toast('Claude link copied.'), () => { $('#claude-url')?.select(); toast('Select the link and copy it.'); });
      case 'claude-off':
        if (!confirm('Turn off your Claude link? Claude won’t be able to reach Shared Plate until you make a new one.')) return;
        return B.deleteConnector(S.profile.claudeToken).then(() => { S.profile.claudeToken = null; refreshClaude(); toast('Claude link turned off.'); }).catch(er => fail(er, 'turn off the link'));
      case 'feed-who': S.feedWho = el.dataset.who; return refreshFeed();
      case 'feed-copy': return navigator.clipboard?.writeText(el.dataset.url).then(() => toast('Calendar link copied.'), () => toast(el.dataset.url));
      case 'feed-off':
        if (!confirm('Turn off this calendar link? Calendars subscribed to it will stop updating.')) return;
        return B.deleteFeed(S.profile.feedToken).then(() => { S.profile.feedToken = null; refreshFeed(); toast('Calendar link turned off.'); }).catch(er => fail(er, 'turn off the link'));
      case 'shopping': S.shopFilter = ''; return openView('shopping', renderShopping);
      case 'shop-toggle': {
        const x = (S.shop || []).find(i => i.id === id); if (!x) return;
        if (navigator.vibrate) navigator.vibrate(8);
        return B.updateItem(S.gid, id, x.checked ? { checked: false, checkedBy: null, checkedAt: null } : { checked: true, checkedBy: S.uid, checkedAt: 'NOW' });
      }
      case 'shop-edit': return openShopItem(id);
      case 'shop-chat': return openShopChat(id);
      case 'shop-to': S.shopList = el.dataset.list; try { localStorage.setItem('sp_shoplist', S.shopList); } catch (er) {} renderShopping(); return $('#shop-add input')?.focus();
      case 'shop-filter': S.shopFilter = el.dataset.list; return renderShopping();
      case 'shop-newlist': {
        const n = (prompt('Name the new list (for example Costco or Pharmacy)') || '').trim().slice(0, 40);
        if (!n) return;
        S.newLists = [...(S.newLists || []), n]; S.shopList = n;
        return renderShopping();
      }
      case 'shop-delete': {
        const x = (S.shop || []).find(i => i.id === el.dataset.id); if (!x) return;
        const keep = { ...x }; delete keep.id;
        B.deleteItem(S.gid, x.id); closeSheet();
        return toast(`Deleted ${x.name}.`, 'Undo', () => B.setItem(S.gid, x.id, keep));
      }
      case 'shop-clear': {
        const gone = (S.shop || []).filter(x => x.checked && sameList(x.list, el.dataset.list));
        gone.forEach(x => B.deleteItem(S.gid, x.id));
        return toast(`Cleared ${gone.length} checked ${gone.length === 1 ? 'item' : 'items'}.`, 'Undo', () => gone.forEach(x => { const k = { ...x }; delete k.id; B.setItem(S.gid, x.id, k); }));
      }
      case 'calendar': S.calMode = null; S.calMonth = null; S.calDay = null; return openView('calendar', renderCalendar);
      case 'cal-mode':
        if (el.dataset.mode === S.calMode) return;
        S.calMode = el.dataset.mode;
        if (S.calMode === 'month') { S.calMonth = monthStart(S.calDay || now()); if (monthStart(now()) === S.calMonth) S.calDay = L.startOfDay(now()); }
        else if (S.calDay && weekStartOf(S.calDay) !== weekStartOf(now()) && monthStart(now()) === monthStart(S.calDay)) S.calDay = L.startOfDay(now());
        return renderCalendar();
      case 'cal-prev': case 'cal-next': {
        const dir = act === 'cal-next' ? 1 : -1;
        if (S.calMode === 'week') { const d = new Date(weekStartOf(S.calDay || now())); d.setDate(d.getDate() + 7 * dir); S.calDay = d.getTime(); }
        else { S.calMonth = addMonthsTo(S.calMonth, dir); S.calDay = null; }
        return renderCalendar();
      }
      case 'cal-today': S.calMonth = null; S.calDay = null; return renderCalendar();
      case 'add-on': return openTask(null, { day: +el.dataset.day });
      case 'cal-day': {
        const d = +el.dataset.day;
        if (monthStart(d) !== S.calMonth) S.calMonth = monthStart(d);
        S.calDay = d; renderCalendar();
        return document.querySelector('.cal-agenda')?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      }
      case 'add-on-day': return openTask(null, { day: S.calDay });
      case 'colors-reset': return B.updateGroup(S.gid, { colors: {} }).then(() => { closeSheet(); openSettings('colors'); }).catch(er => fail(er, 'reset the colors'));
      case 'home': return goHome();
      case 'push-on': return enablePush();
      case 'push-off': return disablePush();
      case 'share-invite': {
        const link = el.dataset.link, text = `Join our household on Shared Plate. Code: ${S.group.inviteCode}`;
        if (navigator.share) return navigator.share({ title: 'Shared Plate', text, url: link }).catch(() => {});
        return navigator.clipboard?.writeText(`${text}\n${link}`).then(() => toast('Invite link copied.'), () => toast(link));
      }
      case 'import-preview': { const v = $('#import-code')?.value || ''; if (!v.trim()) return toast('Paste an import code first.'); return openImport(v); }
      case 'new-code': return B.updateGroup(S.gid, { inviteCode: makeCode() }).then(() => { closeSheet(); openSettings('invite'); }).catch(er => fail(er, 'make a new code'));
      case 'leave':
        if (!confirm('Leave this household? You’ll stop seeing its tasks.')) return;
        return B.leaveGroup(S.gid).then(() => { closeSheet(); S.group = null; S.unsub.splice(1).forEach(u => u && u()); try { localStorage.removeItem('sp_group'); } catch (er) {} renderSetup(); }).catch(er => fail(er, 'leave'));
    }
  });

  // Redraw the dashboard each minute, so daily tasks come up on time and dates stay current.
  setInterval(() => {
    if (S.view === 'home' && S.group && !sheetRoot.innerHTML && !document.querySelector('.lifted, .dragging')) render();
  }, 60000);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
