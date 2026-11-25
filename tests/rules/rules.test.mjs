import { test, before, after } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc, deleteDoc, getDoc, addDoc, collection, serverTimestamp, Timestamp } from 'firebase/firestore';
import { ref, uploadBytes, deleteObject } from 'firebase/storage';

let env;
const A = 'agency-a', B = 'agency-b';
const now = () => Math.floor(Date.now() / 1000);
const client = (extra = {}) => env.authenticatedContext(`client:${A}`, { role: 'client', companyId: A, auth_time: now(), ...extra });
const inviteClient = (inviteId, extra = {}) => env.authenticatedContext(`client:${A}:${inviteId}`, { role: 'client', companyId: A, inviteId, auth_time: now(), ...extra });
const agent = (c = A, extra = {}) => env.authenticatedContext(`agent:${c}:x`, { role: 'agent', companyId: c, agentId: 'x', name: 'Naledi', auth_time: now(), ...extra });
const admin = () => env.authenticatedContext('admin', { superAdmin: true, auth_time: now() });
const impostor = () => env.authenticatedContext('evil', { email: 'owner@example.com', email_verified: true, auth_time: now() });
const sub = (extra = {}) => ({ companyId: A, companyName: 'A', type: 'natural', typeName: 'Natural Person', answers: { q: 'a' }, signature: 'data:x', createdAt: serverTimestamp(), ...extra });

async function seed(id, data, col = 'FICA_SUBMISSIONS') {
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), col, id), data));
}
const invite = (extra = {}) => ({ companyId: A, clientName: 'Thandi', status: 'pending', expiresAt: Timestamp.fromMillis(Date.now() + 864e5), ...extra });
const recent = () => ({ companyId: A, type: 'natural', answers: { q: 'a' }, signature: 's', createdAt: Timestamp.now() });
const old = () => ({ ...recent(), createdAt: Timestamp.fromMillis(Date.now() - 6 * 365 * 864e5) });

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-fica',
    firestore: { rules: readFileSync('../../firestore.rules', 'utf8'), host: '127.0.0.1', port: 8085 },
    storage: { rules: readFileSync('../../storage.rules', 'utf8'), host: '127.0.0.1', port: 9199 },
  });
});
after(() => env.cleanup());
import { beforeEach } from 'node:test';
beforeEach(async () => {
  await seed(A, { name: 'A', slug: A }, 'COMPANIES');
  await seed(B, { name: 'B', slug: B, sharedLinkEnabled: false }, 'COMPANIES');
});

test('client: valid create succeeds', async () => {
  await assertSucceeds(addDoc(collection(client().firestore(), 'FICA_SUBMISSIONS'), sub()));
});
test('client: cannot pick internal EDD form', async () => {
  await assertFails(addDoc(collection(client().firestore(), 'FICA_SUBMISSIONS'), sub({ type: 'enhanced' })));
});
test('client: cannot smuggle extra fields or backdate', async () => {
  await assertFails(addDoc(collection(client().firestore(), 'FICA_SUBMISSIONS'), sub({ eddAssessment: { x: 1 } })));
  await assertFails(addDoc(collection(client().firestore(), 'FICA_SUBMISSIONS'), sub({ createdAt: Timestamp.fromMillis(0) })));
});
test('client: cannot create for another agency', async () => {
  await assertFails(addDoc(collection(client().firestore(), 'FICA_SUBMISSIONS'), sub({ companyId: B })));
});
test('client: attachments once, never answers', async () => {
  await seed('s1', recent());
  const d = doc(client().firestore(), 'FICA_SUBMISSIONS', 's1');
  await assertFails(updateDoc(d, { answers: { q: 'changed' } }));
  await assertSucceeds(updateDoc(d, { attachments: { id: { path: 'p' } } }));
  await assertFails(updateDoc(d, { attachments: { id: { path: 'swapped' } } }));
});
test('client: cannot attach after 1 hour', async () => {
  await seed('s1b', { ...recent(), createdAt: Timestamp.fromMillis(Date.now() - 2 * 3600e3) });
  await assertFails(updateDoc(doc(client().firestore(), 'FICA_SUBMISSIONS', 's1b'), { attachments: {} }));
});
test('client: cannot read submissions', async () => {
  await seed('s2', recent());
  await assertFails(getDoc(doc(client().firestore(), 'FICA_SUBMISSIONS', 's2')));
});
test('agent: reads own agency only', async () => {
  await seed('s3', recent());
  await assertSucceeds(getDoc(doc(agent().firestore(), 'FICA_SUBMISSIONS', 's3')));
  await assertFails(getDoc(doc(agent(B).firestore(), 'FICA_SUBMISSIONS', 's3')));
});
test('agent: cannot delete or edit client evidence', async () => {
  await seed('s4', recent());
  const d = doc(agent().firestore(), 'FICA_SUBMISSIONS', 's4');
  await assertFails(deleteDoc(d));
  await assertFails(updateDoc(d, { answers: { q: 'edited' } }));
  await assertFails(updateDoc(d, { signature: 'forged' }));
});
test('agent: EDD assessment once, server-stamped, own uid', async () => {
  await seed('s5', recent());
  const d = doc(agent().firestore(), 'FICA_SUBMISSIONS', 's5');
  await assertFails(updateDoc(d, { eddAssessment: { answers: {}, completedAt: serverTimestamp(), completedBy: 'someone-else' } }));
  await assertFails(updateDoc(d, { eddAssessment: { answers: {}, completedAt: Timestamp.fromMillis(0), completedBy: `agent:${A}:x` } }));
  await assertFails(updateDoc(d, { eddAssessment: { answers: {}, completedAt: serverTimestamp(), completedBy: `agent:${A}:x`, completedByName: 'Someone Else' } }));
  await assertSucceeds(updateDoc(d, { eddAssessment: { answers: { r: '1' }, completedAt: serverTimestamp(), completedBy: `agent:${A}:x`, completedByName: 'Naledi' } }));
  await assertFails(updateDoc(d, { eddAssessment: { answers: { r: 'rewritten' }, completedAt: serverTimestamp(), completedBy: `agent:${A}:x` } }));
  await assertFails(updateDoc(doc(agent(B).firestore(), 'FICA_SUBMISSIONS', 's5'), { eddAssessment: { answers: {}, completedAt: serverTimestamp(), completedBy: `agent:${B}:x` } }));
});
test('super admin: cannot delete inside 5 years, can after', async () => {
  await seed('s6', recent());
  await seed('s7', old());
  await assertFails(deleteDoc(doc(admin().firestore(), 'FICA_SUBMISSIONS', 's6')));
  await assertSucceeds(deleteDoc(doc(admin().firestore(), 'FICA_SUBMISSIONS', 's7')));
});
test('super admin: cannot rewrite client answers', async () => {
  await seed('s8', recent());
  await assertFails(updateDoc(doc(admin().firestore(), 'FICA_SUBMISSIONS', 's8'), { answers: {} }));
});
test('audit log: append-only, actor and time enforced, agency-scoped', async () => {
  const col = collection(agent().firestore(), 'AUDIT_LOG');
  const entry = { companyId: A, actor: `agent:${A}:x`, action: 'submission.viewed', submissionId: 's1', detail: null, ts: serverTimestamp() };
  const r = await assertSucceeds(addDoc(col, entry));
  await assertFails(addDoc(col, { ...entry, actor: 'agent:someone-else' }));
  await assertFails(addDoc(col, { ...entry, ts: Timestamp.fromMillis(0) }));
  await assertFails(addDoc(collection(agent(B).firestore(), 'AUDIT_LOG'), entry));
  await assertFails(updateDoc(doc(agent().firestore(), 'AUDIT_LOG', r.id), { action: 'x' }));
  await assertFails(deleteDoc(doc(agent().firestore(), 'AUDIT_LOG', r.id)));
  await assertFails(deleteDoc(doc(admin().firestore(), 'AUDIT_LOG', r.id)));
  await assertFails(getDoc(doc(client().firestore(), 'AUDIT_LOG', r.id)));
  await assertSucceeds(getDoc(doc(agent().firestore(), 'AUDIT_LOG', r.id)));
});

const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
test('storage: client uploads PDF, not SVG, not to other agency', async () => {
  const st = client().storage();
  await assertSucceeds(uploadBytes(ref(st, `submissions/${A}/x1/id.pdf`), pdf, { contentType: 'application/pdf' }));
  await assertFails(uploadBytes(ref(st, `submissions/${A}/x1/evil.svg`), pdf, { contentType: 'image/svg+xml' }));
  await assertFails(uploadBytes(ref(st, `submissions/${B}/x1/id.pdf`), pdf, { contentType: 'application/pdf' }));
});
test('storage: client may retry upload within the hour', async () => {
  const st = client().storage();
  await uploadBytes(ref(st, `submissions/${A}/x2/id.pdf`), pdf, { contentType: 'application/pdf' });
  await assertSucceeds(uploadBytes(ref(st, `submissions/${A}/x2/id.pdf`), pdf, { contentType: 'application/pdf' }));
});
test('storage: nobody deletes a recent document', async () => {
  await uploadBytes(ref(client().storage(), `submissions/${A}/x3/id.pdf`), pdf, { contentType: 'application/pdf' });
  await assertFails(deleteObject(ref(agent().storage(), `submissions/${A}/x3/id.pdf`)));
  await assertFails(deleteObject(ref(admin().storage(), `submissions/${A}/x3/id.pdf`)));
});

// ---- Round 2: sessions, super admin claim, invites, company type -------------------
test('super admin is a claim, not an email address', async () => {
  await seed('s20', recent());
  await assertFails(getDoc(doc(impostor().firestore(), 'FICA_SUBMISSIONS', 's20')));
  await assertSucceeds(getDoc(doc(admin().firestore(), 'FICA_SUBMISSIONS', 's20')));
});
test('agent session expires 12h after sign-in', async () => {
  await seed('s21', recent());
  await assertFails(getDoc(doc(agent(A, { auth_time: now() - 13 * 3600 }).firestore(), 'FICA_SUBMISSIONS', 's21')));
});
test('client session expires 2h after sign-in', async () => {
  await assertFails(addDoc(collection(client({ auth_time: now() - 3 * 3600 }).firestore(), 'FICA_SUBMISSIONS'), sub()));
});
test('company (Pty/CC) type can be submitted', async () => {
  await assertSucceeds(addDoc(collection(client().firestore(), 'FICA_SUBMISSIONS'), sub({ type: 'company', typeName: 'Company' })));
});
test('shared-code client blocked once agency disables shared link', async () => {
  const c = env.authenticatedContext(`client:${B}`, { role: 'client', companyId: B, auth_time: now() });
  await assertFails(addDoc(collection(c.firestore(), 'FICA_SUBMISSIONS'), sub({ companyId: B })));
});
test('shared-code client cannot claim an invite ID', async () => {
  await assertFails(addDoc(collection(client().firestore(), 'FICA_SUBMISSIONS'), sub({ inviteId: 'inv' })));
});
test('invite: exactly one submission, at the invite ID', async () => {
  await seed('inv1', invite(), 'INVITES');
  const db = inviteClient('inv1').firestore();
  await assertFails(setDoc(doc(db, 'FICA_SUBMISSIONS', 'other-id'), sub({ inviteId: 'other-id' })));
  await assertFails(setDoc(doc(db, 'FICA_SUBMISSIONS', 'inv1'), sub()));
  await assertSucceeds(setDoc(doc(db, 'FICA_SUBMISSIONS', 'inv1'), sub({ inviteId: 'inv1' })));
  await assertFails(setDoc(doc(db, 'FICA_SUBMISSIONS', 'inv1'), sub({ inviteId: 'inv1' })), 'second submission denied');
});
test('invite: revoked or expired links cannot submit', async () => {
  await seed('inv2', invite({ status: 'revoked' }), 'INVITES');
  await seed('inv3', invite({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) }), 'INVITES');
  await assertFails(setDoc(doc(inviteClient('inv2').firestore(), 'FICA_SUBMISSIONS', 'inv2'), sub({ inviteId: 'inv2' })));
  await assertFails(setDoc(doc(inviteClient('inv3').firestore(), 'FICA_SUBMISSIONS', 'inv3'), sub({ inviteId: 'inv3' })));
});
test('invite client cannot touch another submission', async () => {
  await seed('s22', recent());
  await assertFails(updateDoc(doc(inviteClient('inv9').firestore(), 'FICA_SUBMISSIONS', 's22'), { attachments: {} }));
});
test('INVITES readable by own agency only; AGENTS never readable', async () => {
  await seed('inv4', invite(), 'INVITES');
  await seed('ag1', { companyId: A, passwordHash: 'x' }, 'AGENTS');
  await assertSucceeds(getDoc(doc(agent().firestore(), 'INVITES', 'inv4')));
  await assertFails(getDoc(doc(agent(B).firestore(), 'INVITES', 'inv4')));
  await assertFails(getDoc(doc(client().firestore(), 'INVITES', 'inv4')));
  await assertFails(setDoc(doc(agent().firestore(), 'INVITES', 'inv5'), invite()));
  await assertFails(getDoc(doc(agent().firestore(), 'AGENTS', 'ag1')));
  await assertFails(getDoc(doc(admin().firestore(), 'AGENTS', 'ag1')));
});
test('storage: invite client limited to own folder; old agent session cannot read', async () => {
  const st = inviteClient('inv6').storage();
  await assertSucceeds(uploadBytes(ref(st, `submissions/${A}/inv6/id.pdf`), pdf, { contentType: 'application/pdf' }));
  await assertFails(uploadBytes(ref(st, `submissions/${A}/someone-else/id.pdf`), pdf, { contentType: 'application/pdf' }));
  const { getBytes } = await import('firebase/storage');
  await assertSucceeds(getBytes(ref(agent().storage(), `submissions/${A}/inv6/id.pdf`)));
  await assertFails(getBytes(ref(agent(A, { auth_time: now() - 13 * 3600 }).storage(), `submissions/${A}/inv6/id.pdf`)));
  await assertFails(getBytes(ref(impostor().storage(), `submissions/${A}/inv6/id.pdf`)));
});
