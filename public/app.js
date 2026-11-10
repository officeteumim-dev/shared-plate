// Shared Plate app. Plain JavaScript, no build step (same approach as sfsp-wgroup).
// - Live data: Firebase Auth + Firestore (compat SDK from Google's CDN), with Firestore's offline cache.
// - Preview mode (?preview): sample household kept in memory, no sign-in. Used by the automated tests.
(function () {
  'use strict';
  const C = self.SP_CONFIG || {};
  const L = self.SP_LOGIC;
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
    cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
    next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
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
  const TIME_KEYS = ['dueAt', 'showAgainOn', 'completedAt', 'createdAt', 'updatedAt', 'notifyAt', 'claimedAt'];

  function previewBackend() {
    const me = 'me', her = 'leah', t0 = now();
    const day = n => { const d = new Date(t0); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n); return d.getTime(); };
    const at = (n, h, m = 0) => day(n) + h * H + m * 60000;
    let seq = 100;
    const group = { name: 'Our home', createdBy: me, members: { [me]: 'owner', [her]: 'member' }, names: { [me]: 'Avi', [her]: 'Leah' }, inviteCode: 'PLATE234' };
    const base = { claimedBy: null, status: 'open', repeat: 'none', createdBy: me, createdAt: t0 - 2 * H };
    const tasks = new Map([
      ['p1', { ...base, title: 'Call the plumber about the kitchen sink', owner: 'shared', createdAt: t0 - 30 * H, notes: 'Number is on the fridge.' }],
      ['p2', { ...base, title: 'Pick up challah', owner: me, dueAt: at(0, 15), repeat: 'weekly' }],
      ['p3', { ...base, title: 'Pay the electric bill', owner: me, dueAt: at(-1, 18) }],
      ['p4', { ...base, title: 'Pediatrician appointment for Noa', owner: her, dueAt: at(0, 10, 30), createdBy: her }],
      ['p5', { ...base, title: 'Take out recycling', owner: 'shared', claimedBy: her, claimedAt: t0 - H, dueAt: at(0, 20), repeat: 'weekly' }],
      ['p6', { ...base, title: 'Order birthday gift for Grandma', owner: 'shared', dueAt: at(2, 12) }],
      ['p7', { ...base, title: 'Renew car registration', owner: me, dueAt: at(5, 9) }],
      ['p8', { ...base, title: 'Book the summer camp', owner: her, status: 'snoozed', showAgainOn: at(3, 8), createdBy: her }],
      ['p9', { ...base, title: 'Water the plants', owner: me, status: 'done', completedAt: t0 - 3 * H, completedBy: me }]
    ]);
    let onOpen = () => {}, onDone = () => {}, onGroup = () => {}, onProfile = () => {};
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
      saveProfile(p) { profile = { ...profile, ...p }; onProfile(profile); return Promise.resolve(); },
      watchGroup(gid, cb) { onGroup = cb; setTimeout(() => cb({ id: gid, ...group })); return () => {}; },
      updateGroup(gid, patch) {
        for (const [k, v] of Object.entries(patch)) {
          const [a, b] = k.split('.');
          if (b) { group[a] = group[a] || {}; if (v === undefined) delete group[a][b]; else group[a][b] = v; } else group[a] = v;
        }
        onGroup({ id: gid, ...group }); return Promise.resolve();
      },
      watchTasks(gid, a, b) { onOpen = a; onDone = b; emit(); return () => {}; },
      newId() { return 'n' + (++seq); },
      setTask(gid, id, data) { tasks.set(id, resolve(data)); emit(); return Promise.resolve(id); },
      updateTask(gid, id, patch) { tasks.set(id, { ...tasks.get(id), ...resolve(patch) }); emit(); return Promise.resolve(); },
      deleteTask(gid, id) { tasks.delete(id); emit(); return Promise.resolve(); },
      createGroup() { return Promise.resolve('demo'); },
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
      async joinGroup(code, name) {
        const r = await firebase.app().functions('us-central1').httpsCallable('joinGroup')({ code, name });
        return r.data;
      },
      async leaveGroup(gid) {
        await db.doc(`groups/${gid}`).update({ [`members.${uid}`]: FV.delete(), [`names.${uid}`]: FV.delete() });
        await db.doc(`users/${uid}`).set({ groupIds: FV.arrayRemove(gid) }, { merge: true });
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
    if (S.view === 'calendar') return renderCalendar();
    S.view = 'home';
    const t = now();
    const l = L.lanes(S.open, S.uid, t);
    const counts = { mine: l.mine.length, theirs: l.theirs.length, shared: l.shared.length };
    const others1 = others().length === 1 ? (S.group.names?.[others()[0]] || 'Them') : 'Theirs';
    const date = new Date(t).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    const todayN = l.today.length;
    app.innerHTML = `
      <header class="top">
        <h1>${esc(S.group.name || 'Shared Plate')}</h1>
        <div style="display:flex;gap:8px;align-items:center">
          ${PREVIEW ? '<span class="preview-flag">Preview</span>' : ''}
          <button class="icon-btn" data-act="calendar" aria-label="Calendar">${ICON.cal}</button>
          <button class="icon-btn" data-act="settings" aria-label="Settings">${ICON.gear}</button>
        </div>
      </header>
      <section class="hello">
        ${plate(counts, todayN)}
        <div>
          <h2>${!S.loaded ? 'Loading…' : todayN ? `${todayN} ${todayN === 1 ? 'thing' : 'things'} today` : 'Nothing due today'}</h2>
          <p>${esc(date)}</p>
          <div class="legend">
            <span><i class="dot mine"></i>Mine <b>${counts.mine}</b></span>
            <span><i class="dot theirs"></i>${esc(others1)} <b>${counts.theirs}</b></span>
            <span><i class="dot shared"></i>Shared <b>${counts.shared}</b></span>
          </div>
        </div>
      </section>
      ${todayN ? `<nav class="today" aria-label="Due today">${l.today.map(x => chip(x, t)).join('')}</nav>` : ''}
      <div class="lanes">
        ${lane('mine', 'Mine', l.mine, t, 'Nothing on your plate. Nice.')}
        ${lane('theirs', theirsTitle(), l.theirs, t, others().length ? 'Nothing on their plate right now.' : 'Invite someone from Settings to share the plate.')}
        ${lane('shared', 'Shared', l.shared, t, 'No shared tasks waiting. Add one for whoever gets to it first.')}
      </div>
      ${l.snoozed.length ? `<section style="margin-top:28px"><details class="more"><summary>Snoozed (${l.snoozed.length})</summary>
        <ul class="list">${l.snoozed.map(x => row(x, t, L.laneOf(x, S.uid), true)).join('')}</ul></details></section>` : ''}
      <div class="more-row"><button class="btn line" data-act="show-done">Completed</button></div>
      <button class="fab" data-act="add" aria-label="Add a task">${ICON.plus}<span>Add</span></button>`;
    bindSwipes();
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
      <text x="56" y="61" text-anchor="middle" font-size="26" font-weight="700">${total}</text>
      <text x="56" y="77" text-anchor="middle" font-size="11" fill="var(--ink-2)" style="fill:var(--ink-2)">open</text></svg>`;
  }

  function chip(x, t) {
    const k = L.laneOf(x, S.uid), late = L.isOverdue(x, t);
    const who = k === 'mine' ? '' : k === 'shared' ? ', shared' : `, ${nameOf(L.responsible(x))}`;
    return `<button class="chip ${k}" data-act="edit" data-id="${esc(x.id)}">
      <span class="when ${late ? 'late' : ''}">${late ? 'Overdue, ' : ''}${esc(L.fmtWhen(x.dueAt, t))}${esc(who)}</span>
      <span class="t">${esc(x.title)}</span></button>`;
  }

  function lane(k, title, list, t, empty) {
    return `<section class="lane ${k}" aria-label="${esc(title)}">
      <div class="lane-head"><h3>${esc(title)}</h3><span class="count">${list.length}</span></div>
      ${list.length ? `<ul class="list">${list.map(x => row(x, t, k)).join('')}</ul>` : `<div class="empty">${esc(empty)}</div>`}
    </section>`;
  }

  function row(x, t, k, snoozed) {
    const meta = [];
    if (snoozed) meta.push(`Back ${esc(L.fmtWhen(x.showAgainOn, t))}`);
    else if (x.dueAt) meta.push(`<span class="${L.isOverdue(x, t) ? 'late' : ''}">${L.isOverdue(x, t) ? 'Overdue, ' : ''}${esc(L.fmtWhen(x.dueAt, t))}</span>`);
    if (L.repeatLabel(x.repeat)) meta.push(esc(L.repeatLabel(x.repeat)));
    if (x.owner === 'shared' && x.claimedBy) meta.push(`<span class="tag">${x.claimedBy === S.uid ? 'Shared, you took it' : `Shared, ${esc(nameOf(x.claimedBy))} took it`}</span>`);
    else if (k === 'theirs' && others().length > 1) meta.push(`<span class="tag">${esc(nameOf(L.responsible(x)))}</span>`);
    if (x.notes) meta.push('Note');
    const unclaimed = x.owner === 'shared' && !x.claimedBy && !snoozed;
    const nudge = unclaimed && L.needsNudge(x, t, C.nudgeAfterHours || 24);
    return `<li class="row-wrap lane ${k}" data-id="${esc(x.id)}"><div class="swipe-hint" aria-hidden="true">Done</div>
      <div class="task" data-id="${esc(x.id)}">
        <button class="check" data-act="done" data-id="${esc(x.id)}" aria-label="Mark done: ${esc(x.title)}"><span></span></button>
        <button class="body" data-act="edit" data-id="${esc(x.id)}">
          <div class="title">${esc(x.title)}</div>${meta.length ? `<div class="meta">${meta.map(m => `<span>${m}</span>`).join('')}</div>` : ''}
        </button>
        ${unclaimed ? `<button class="take" data-act="take" data-id="${esc(x.id)}">Take it</button>` : '<span></span>'}
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
      if (L.normRepeat(x.repeat)) {
        let next = due;
        for (let i = 0; i < 62; i++) {
          next = L.nextDue(next, x.repeat, next);
          if (!next || next >= to) break;
          push(x, next, { repeat: true });
        }
      }
    }
    for (const x of S.done) { const due = L.toMs(x.dueAt); if (due != null) push(x, due, { done: true }); }
    return out.sort((a, b) => a.at - b.at);
  }

  function renderCalendar() {
    S.view = 'calendar';
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
    const todayKey = dayKey(t), selKey = dayKey(S.calDay);
    let cells = '';
    for (let i = 0; i < weeks * 7; i++) {
      const d = new Date(gridStart); d.setDate(gridStart.getDate() + i);
      const k = dayKey(d.getTime()), list = byDay[k] || [], inMonth = d.getMonth() === first.getMonth();
      const marks = list.slice(0, 4).map(it => `<i class="mark${it.done ? ' done' : ''}${it.repeat ? ' rep' : ''}" style="--c:${personColor(it.who)}"></i>`).join('');
      const peek = list.slice(0, 2).map(it => `<span class="peek${it.done ? ' done' : ''}" style="--c:${personColor(it.who)}">${esc(it.x.title)}</span>`).join('');
      const label = `${d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}, ${list.length ? list.length + (list.length === 1 ? ' task' : ' tasks') : 'nothing scheduled'}`;
      cells += `<button class="day${inMonth ? '' : ' out'}${k === todayKey ? ' is-today' : ''}${k === selKey ? ' sel' : ''}" data-act="cal-day" data-day="${d.getTime()}" aria-label="${esc(label)}" aria-pressed="${k === selKey}">
        <span class="num">${d.getDate()}</span><span class="marks">${marks}${list.length > 4 ? '<b>+</b>' : ''}</span><span class="peeks">${peek}${list.length > 2 ? `<span class="more-n">+${list.length - 2}</span>` : ''}</span></button>`;
    }
    const sel = byDay[selKey] || [];
    const whoName = k => k === 'shared' ? 'Shared' : k === S.uid ? 'You' : nameOf(k);
    const legendKeys = [S.uid, ...others(), 'shared'];
    const monthName = first.toLocaleDateString(undefined, { month: 'long', year: first.getFullYear() === new Date(t).getFullYear() ? undefined : 'numeric' });
    const selName = new Date(S.calDay).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    app.innerHTML = `<header class="top"><button class="icon-btn" data-act="home" aria-label="Back">${ICON.back}</button><h1>Calendar</h1>
        <button class="icon-btn" data-act="settings" aria-label="Settings">${ICON.gear}</button></header>
      <div class="cal-nav">
        <button class="icon-btn" data-act="cal-prev" aria-label="Previous month">${ICON.back}</button>
        <h2>${esc(monthName)}</h2>
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
        ${sel.length ? `<ul class="list">${sel.map(it => `<li class="row-wrap"><div class="task cal-task" style="--k:${personColor(it.who)}">
          <span class="bar"></span>
          <button class="body" data-act="edit" data-id="${esc(it.x.id)}">
            <div class="title"${it.done ? ' style="text-decoration:line-through"' : ''}>${esc(it.x.title)}</div>
            <div class="meta"><span>${esc(whoName(it.who))}</span>${(new Date(it.at).getHours() || new Date(it.at).getMinutes()) ? `<span>${esc(L.fmtTime(it.at))}</span>` : ''}${it.repeat ? `<span>${esc(L.repeatLabel(it.x.repeat))}</span>` : ''}${it.snoozed ? '<span>Snoozed</span>' : ''}${it.done ? '<span>Done</span>' : ''}${!it.done && !it.repeat && L.isOverdue(it.x, t) ? '<span class="late">Overdue</span>' : ''}</div>
          </button></div></li>`).join('')}</ul>`
          : '<div class="empty">Nothing scheduled. Tap Add to put something on this day.</div>'}
      </section>
      <button class="fab" data-act="add-on-day" aria-label="Add a task on ${esc(selName)}">${ICON.plus}<span>Add</span></button>`;
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
      el.addEventListener('pointerdown', e => { if (e.button) return; active = true; dragging = false; x0 = e.clientX; y0 = e.clientY; dx = 0; });
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

  // =====================================================================
  // Sheets: add / edit task, settings
  // =====================================================================
  function openSheet(html, onOpen) {
    sheetRoot.innerHTML = `<div class="scrim" data-act="close"></div><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div>`;
    document.body.style.overflow = 'hidden';
    onOpen && onOpen(sheetRoot.querySelector('.sheet'));
  }
  function closeSheet() { sheetRoot.innerHTML = ''; document.body.style.overflow = ''; }
  addEventListener('keydown', e => { if (e.key === 'Escape' && sheetRoot.innerHTML) closeSheet(); });

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
      </div></form>`, sheet => {
      const form = sheet.querySelector('#task-form');
      if (!x) setTimeout(() => form.title.focus(), 60);
      sheet.querySelector('#owner-seg').onclick = e => {
        const b = e.target.closest('[data-owner]'); if (!b) return;
        f.owner = b.dataset.owner;
        sheet.querySelectorAll('[data-owner]').forEach(o => o.setAttribute('aria-pressed', o === b));
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
        prefs: { due: sheet.querySelector('#p-due').checked, back: sheet.querySelector('#p-back').checked }
      }).catch(e => fail(e, 'save quiet hours'));
      ['#q-on', '#q-start', '#q-end', '#p-due', '#p-back'].forEach(s => sheet.querySelector(s).addEventListener('change', saveQuiet));
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
      return { title, status, back: status === 'snoozed' ? back : null, due: day(x.due, 9), notes: String(x.notes || '').slice(0, 2000), shared: x.owner === 'shared' };
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
            dueAt: x.due, repeat: 'none', createdBy: S.uid, createdAt: 'NOW', updatedAt: 'NOW'
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
      case 'show-done': S.view = 'done'; window.scrollTo(0, 0); return renderDone();
      case 'calendar': S.view = 'calendar'; S.calMonth = null; S.calDay = null; window.scrollTo(0, 0); return renderCalendar();
      case 'cal-prev': S.calMonth = addMonthsTo(S.calMonth, -1); S.calDay = null; return renderCalendar();
      case 'cal-next': S.calMonth = addMonthsTo(S.calMonth, 1); S.calDay = null; return renderCalendar();
      case 'cal-today': S.calMonth = null; S.calDay = null; return renderCalendar();
      case 'cal-day': {
        const d = +el.dataset.day;
        if (monthStart(d) !== S.calMonth) S.calMonth = monthStart(d);
        S.calDay = d; renderCalendar();
        return document.querySelector('.cal-agenda')?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      }
      case 'add-on-day': return openTask(null, { day: S.calDay });
      case 'colors-reset': return B.updateGroup(S.gid, { colors: {} }).then(() => { closeSheet(); openSettings('colors'); }).catch(er => fail(er, 'reset the colors'));
      case 'home': closeSheet(); if (S.group && S.view !== 'setup') { S.view = 'home'; return render(); } return pickGroup();
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

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
