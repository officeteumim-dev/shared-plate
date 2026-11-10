// Security rules tests, run against the Firestore emulator by GitHub on every push and pull request.
// Run locally (needs Java): from the repo root,
//   npx firebase-tools emulators:exec --only firestore --project demo-shared-plate "npm --prefix tests/rules test"
import { test, before, after, beforeEach } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, serverTimestamp, Timestamp, deleteField } from 'firebase/firestore';

// Read the allowlist from firestore.rules so the tests keep working when it changes.
const RULES = fs.readFileSync(path.resolve(import.meta.dirname, '../../firestore.rules'), 'utf8');
const ALLOWED = [...RULES.matchAll(/'([^'@\s]+@[^'\s]+)'/g)].map(m => m[1]);
// Test rules with two allowed people plus one outsider. The allowlist is swapped for test addresses.
const TEST_RULES = RULES.replace(/in \[\s*'[^']+@[^\]]*\]/, "in ['a@test.com', 'b@test.com', 'c@test.com']");

let env;
const A = 'uidA', B = 'uidB', C = 'uidC', X = 'uidX';
const ctx = (uid, email, verified = true) => env.authenticatedContext(uid, { email, email_verified: verified }).firestore();
const db = { A: () => ctx(A, 'a@test.com'), B: () => ctx(B, 'b@test.com'), C: () => ctx(C, 'c@test.com'), X: () => ctx(X, 'stranger@test.com') };
const G = 'g1';
const future = () => Timestamp.fromMillis(Date.now() + 86400e3);

before(async () => {
  if (!ALLOWED.length) throw new Error('No allowlist found in firestore.rules');
  env = await initializeTestEnvironment({
    projectId: 'demo-shared-plate',
    firestore: { rules: TEST_RULES, host: '127.0.0.1', port: 8080 }
  });
});
after(async () => { await env?.cleanup(); });

beforeEach(async () => {
  await env.clearFirestore();
  // Group g1: A owns it, B is a member. C is allowed to sign up but isn't in the group.
  await env.withSecurityRulesDisabled(async c => {
    const f = c.firestore();
    await setDoc(doc(f, 'groups', G), {
      name: 'Home', createdBy: A, createdAt: Timestamp.now(), inviteCode: 'ABCD2345',
      members: { [A]: 'owner', [B]: 'member' }, names: { [A]: 'Avi', [B]: 'Leah' }
    });
    await setDoc(doc(f, 'groups', G, 'tasks', 't1'), {
      title: 'Call the plumber', owner: 'shared', claimedBy: null, status: 'open', repeat: 'none',
      createdBy: A, createdAt: Timestamp.now()
    });
    await setDoc(doc(f, 'users', A), { displayName: 'Avi', email: 'a@test.com', groupIds: [G] });
  });
});

const newTask = (over = {}) => ({
  title: 'Buy milk', owner: A, claimedBy: null, status: 'open', repeat: 'none',
  createdBy: A, createdAt: serverTimestamp(), ...over
});

// ----- Groups -----
test('members can read their group; others cannot', async () => {
  await assertSucceeds(getDoc(doc(db.A(), 'groups', G)));
  await assertSucceeds(getDoc(doc(db.B(), 'groups', G)));
  await assertFails(getDoc(doc(db.C(), 'groups', G)));
  await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'groups', G)));
});

test('the allowlist blocks people who are not on it', async () => {
  await assertFails(setDoc(doc(db.X(), 'groups', 'gx'), {
    name: 'Mine', createdBy: X, createdAt: serverTimestamp(), inviteCode: 'ZZZZ2345', members: { [X]: 'owner' }, names: { [X]: 'X' }
  }));
  await assertFails(setDoc(doc(db.X(), 'users', X), { displayName: 'X' }));
});

test('unverified emails are refused', async () => {
  const f = ctx(C, 'c@test.com', false);
  await assertFails(setDoc(doc(f, 'users', C), { displayName: 'C' }));
});

test('an allowed person can create a group they own', async () => {
  await assertSucceeds(setDoc(doc(db.C(), 'groups', 'g2'), {
    name: 'Our home', createdBy: C, createdAt: serverTimestamp(), inviteCode: 'QWER2345', members: { [C]: 'owner' }, names: { [C]: 'Cy' }
  }));
});

test('nobody can create a group with other members already in it', async () => {
  await assertFails(setDoc(doc(db.C(), 'groups', 'g2'), {
    name: 'Sneaky', createdBy: C, createdAt: serverTimestamp(), inviteCode: 'QWER2345', members: { [C]: 'owner', [A]: 'member' }, names: { [C]: 'Cy' }
  }));
  await assertFails(setDoc(doc(db.C(), 'groups', 'g2'), {
    name: 'Sneaky', createdBy: A, createdAt: serverTimestamp(), inviteCode: 'QWER2345', members: { [C]: 'owner' }, names: { [C]: 'Cy' }
  }));
});

test('only the owner can manage members', async () => {
  await assertFails(updateDoc(doc(db.B(), 'groups', G), { [`members.${C}`]: 'member' }));
  await assertFails(updateDoc(doc(db.B(), 'groups', G), { [`members.${B}`]: 'owner' }));
  await assertSucceeds(updateDoc(doc(db.A(), 'groups', G), { [`members.${C}`]: 'member' }));
  await assertSucceeds(updateDoc(doc(db.A(), 'groups', G), { [`members.${B}`]: deleteField() }));
});

test('the owner cannot demote themselves or rewrite who created the group', async () => {
  await assertFails(updateDoc(doc(db.A(), 'groups', G), { [`members.${A}`]: 'member' }));
  await assertFails(updateDoc(doc(db.A(), 'groups', G), { createdBy: B }));
});

test('outsiders cannot add themselves to a group', async () => {
  await assertFails(updateDoc(doc(db.C(), 'groups', G), { [`members.${C}`]: 'member' }));
});

test('a member can change only their own name, and can leave', async () => {
  await assertSucceeds(updateDoc(doc(db.B(), 'groups', G), { [`names.${B}`]: 'Leah K' }));
  await assertFails(updateDoc(doc(db.B(), 'groups', G), { [`names.${A}`]: 'Someone' }));
  await assertFails(updateDoc(doc(db.B(), 'groups', G), { name: 'Renamed' }));
  await assertSucceeds(updateDoc(doc(db.B(), 'groups', G), { [`members.${B}`]: deleteField(), [`names.${B}`]: deleteField() }));
});

test('any member can change the household colors; outsiders cannot', async () => {
  await assertSucceeds(updateDoc(doc(db.B(), 'groups', G), { [`colors.${B}`]: '#2f5fa8', 'colors.shared': '#a8741a' }));
  await assertSucceeds(updateDoc(doc(db.A(), 'groups', G), { name: 'Home sweet home' }));
  await assertFails(updateDoc(doc(db.C(), 'groups', G), { [`colors.${C}`]: '#000000' }));
  await assertFails(updateDoc(doc(db.B(), 'groups', G), { colors: 'red' }));
});

test('only the owner can delete the group', async () => {
  await assertFails(deleteDoc(doc(db.B(), 'groups', G)));
  await assertSucceeds(deleteDoc(doc(db.A(), 'groups', G)));
});

// ----- Tasks -----
test('members can read and add tasks; outsiders cannot', async () => {
  await assertSucceeds(getDoc(doc(db.B(), 'groups', G, 'tasks', 't1')));
  await assertFails(getDoc(doc(db.C(), 'groups', G, 'tasks', 't1')));
  await assertSucceeds(setDoc(doc(db.A(), 'groups', G, 'tasks', 'n1'), newTask()));
  await assertFails(setDoc(doc(db.C(), 'groups', G, 'tasks', 'n2'), newTask({ createdBy: C })));
});

test('a task owner must be a member or "shared"', async () => {
  await assertSucceeds(setDoc(doc(db.A(), 'groups', G, 'tasks', 'n1'), newTask({ owner: B })));
  await assertSucceeds(setDoc(doc(db.A(), 'groups', G, 'tasks', 'n2'), newTask({ owner: 'shared' })));
  await assertFails(setDoc(doc(db.A(), 'groups', G, 'tasks', 'n3'), newTask({ owner: C })));
});

test('createdBy must be you, and it cannot change later', async () => {
  await assertFails(setDoc(doc(db.A(), 'groups', G, 'tasks', 'n1'), newTask({ createdBy: B })));
  await assertFails(updateDoc(doc(db.B(), 'groups', G, 'tasks', 't1'), { createdBy: B }));
});

test('claiming a shared task works only for members, and only on shared tasks', async () => {
  await assertSucceeds(updateDoc(doc(db.B(), 'groups', G, 'tasks', 't1'), { claimedBy: B, claimedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(db.B(), 'groups', G, 'tasks', 't1'), { claimedBy: C }));
  await assertFails(setDoc(doc(db.A(), 'groups', G, 'tasks', 'n1'), newTask({ owner: A, claimedBy: B })));
});

test('status must be valid, and snoozed needs a date', async () => {
  await assertFails(updateDoc(doc(db.A(), 'groups', G, 'tasks', 't1'), { status: 'maybe' }));
  await assertFails(updateDoc(doc(db.A(), 'groups', G, 'tasks', 't1'), { status: 'snoozed' }));
  await assertSucceeds(updateDoc(doc(db.A(), 'groups', G, 'tasks', 't1'), { status: 'snoozed', showAgainOn: future() }));
  await assertSucceeds(updateDoc(doc(db.A(), 'groups', G, 'tasks', 't1'), { status: 'done', completedAt: serverTimestamp(), completedBy: A }));
});

test('unknown fields and oversized titles are refused', async () => {
  await assertFails(setDoc(doc(db.A(), 'groups', G, 'tasks', 'n1'), newTask({ hack: true })));
  await assertFails(setDoc(doc(db.A(), 'groups', G, 'tasks', 'n1'), newTask({ title: 'x'.repeat(201) })));
  await assertFails(setDoc(doc(db.A(), 'groups', G, 'tasks', 'n1'), newTask({ title: '' })));
});

test('category, priority and order are accepted within limits', async () => {
  await assertSucceeds(setDoc(doc(db.A(), 'groups', G, 'tasks', 'n1'), newTask({ category: 'Car', priority: 'A1', order: 2000 })));
  await assertSucceeds(updateDoc(doc(db.B(), 'groups', G, 'tasks', 't1'), { order: 500 }));
  await assertFails(setDoc(doc(db.A(), 'groups', G, 'tasks', 'n2'), newTask({ priority: 'URGENT' })));
  await assertFails(setDoc(doc(db.A(), 'groups', G, 'tasks', 'n3'), newTask({ category: 'x'.repeat(41) })));
  await assertFails(setDoc(doc(db.A(), 'groups', G, 'tasks', 'n4'), newTask({ order: 'first' })));
});

test('a custom repeat rule is accepted', async () => {
  await assertSucceeds(setDoc(doc(db.A(), 'groups', G, 'tasks', 'n1'), newTask({ repeat: { every: 2, unit: 'week', weekdays: [1, 4] }, dueAt: future() })));
});

test('members can delete tasks; outsiders cannot', async () => {
  await assertFails(deleteDoc(doc(db.C(), 'groups', G, 'tasks', 't1')));
  await assertSucceeds(deleteDoc(doc(db.B(), 'groups', G, 'tasks', 't1')));
});

// ----- Users -----
test('you can read and write only your own user record', async () => {
  await assertSucceeds(getDoc(doc(db.A(), 'users', A)));
  await assertFails(getDoc(doc(db.B(), 'users', A)));
  await assertSucceeds(setDoc(doc(db.B(), 'users', B), { displayName: 'Leah', tokens: { tok1: { platform: 'ios' } }, quiet: { start: '22:00', end: '07:00' }, tz: 'America/New_York' }));
  await assertFails(updateDoc(doc(db.B(), 'users', A), { displayName: 'Hacked' }));
  await assertFails(setDoc(doc(db.B(), 'users', B), { isAdmin: true }));
});

test('anything outside groups and users is closed', async () => {
  await assertFails(setDoc(doc(db.A(), 'config', 'x'), { a: 1 }));
  await assertFails(getDoc(doc(db.A(), 'config', 'x')));
});
