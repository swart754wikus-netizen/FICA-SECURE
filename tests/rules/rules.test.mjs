import { test, before, after } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc, deleteDoc, getDoc, addDoc, collection, serverTimestamp, Timestamp } from 'firebase/firestore';
import { ref, uploadBytes, deleteObject } from 'firebase/storage';

let env;
const A = 'agency-a', B = 'agency-b';
const client = () => env.authenticatedContext(`client:${A}`, { role: 'client', companyId: A });
const agent = (c = A) => env.authenticatedContext(`agent:${c}`, { role: 'agent', companyId: c });
const admin = () => env.authenticatedContext('admin', { email: 'swart754wikus@gmail.com' });
const sub = (extra = {}) => ({ companyId: A, companyName: 'A', type: 'natural', typeName: 'Natural Person', answers: { q: 'a' }, signature: 'data:x', createdAt: serverTimestamp(), ...extra });

async function seed(id, data) {
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'FICA_SUBMISSIONS', id), data));
}
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
  await assertFails(updateDoc(d, { eddAssessment: { answers: {}, completedAt: Timestamp.fromMillis(0), completedBy: `agent:${A}` } }));
  await assertSucceeds(updateDoc(d, { eddAssessment: { answers: { r: '1' }, completedAt: serverTimestamp(), completedBy: `agent:${A}` } }));
  await assertFails(updateDoc(d, { eddAssessment: { answers: { r: 'rewritten' }, completedAt: serverTimestamp(), completedBy: `agent:${A}` } }));
  await assertFails(updateDoc(doc(agent(B).firestore(), 'FICA_SUBMISSIONS', 's5'), { eddAssessment: { answers: {}, completedAt: serverTimestamp(), completedBy: `agent:${B}` } }));
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
  const entry = { companyId: A, actor: `agent:${A}`, action: 'submission.viewed', submissionId: 's1', detail: null, ts: serverTimestamp() };
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
