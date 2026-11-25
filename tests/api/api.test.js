const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');

process.env.DATA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
const fake = require('./fakeFirebase');
require.cache[path.resolve(__dirname, '../../lib/firebaseAdmin.js')] = { exports: fake, loaded: true, id: 'fake' };

const api = (name) => require(`../../api/${name}`);
const { totp } = require('../../lib/totp');
const { agentDocId } = require('../../lib/secrets');

let ip = 0;
async function call(name, body, { token } = {}) {
  const req = { method: 'POST', body, headers: { 'x-forwarded-for': `10.0.0.${++ip % 250}`, ...(token ? { authorization: `Bearer ${token}` } : {}) } };
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await api(name)(req, res);
  return res;
}
const asToken = (claims) => { const t = `tok:${crypto.randomUUID()}`; fake.tokens.set(t, { uid: claims.uid || 'u', ...claims }); return t; };
const ADMIN = () => asToken({ uid: 'admin', superAdmin: true });

beforeEach(async () => {
  fake.store.clear();
  await fake.db.collection('COMPANIES').doc('acme').set({ name: 'Acme Realty', nameLower: 'acme realty', slug: 'acme', status: 'active', agentPasswordHash: await require('bcryptjs').hash('shared-pass', 4), accessCodeHash: await require('bcryptjs').hash('code123', 4) });
  await fake.db.collection('COMPANIES').doc('other').set({ name: 'Other', slug: 'other', status: 'active' });
});

async function createAgent(email = 'naledi@acme.co.za', role = 'principal', by = ADMIN()) {
  return call('manageAgents', { action: 'create', companyId: 'acme', email, name: 'Naledi M', role, password: 'temporary-pass-1' }, { token: by });
}

async function fullLogin(email = 'naledi@acme.co.za') {
  const l = await call('agentAuth', { action: 'login', email, password: 'temporary-pass-1' });
  assert.equal(l.statusCode, 200, JSON.stringify(l.body));
  const secret = l.body.secret;
  const v = await call('agentAuth', { action: 'verify', challenge: l.body.challenge, code: totp(secret) });
  return { l, v, secret };
}

test('first login forces MFA enrolment, then issues per-agent token', async () => {
  assert.equal((await createAgent()).statusCode, 201);
  const { l, v } = await fullLogin();
  assert.equal(l.body.step, 'enroll');
  assert.match(l.body.otpauthUri, /^otpauth:\/\/totp\//);
  assert.equal(v.statusCode, 200, JSON.stringify(v.body));
  const minted = JSON.parse(v.body.token);
  assert.equal(minted.uid, `agent:acme:${agentDocId('naledi@acme.co.za')}`);
  assert.deepEqual({ role: minted.claims.role, companyId: minted.claims.companyId, agentRole: minted.claims.agentRole, name: minted.claims.name },
    { role: 'agent', companyId: 'acme', agentRole: 'principal', name: 'Naledi M' });
  const stored = fake.store.get(`AGENTS/${agentDocId('naledi@acme.co.za')}`);
  assert.ok(stored.totpSecretEnc && !stored.totpSecretEnc.includes(l.body.secret), 'TOTP secret encrypted at rest');
});

test('wrong password and wrong code are rejected; codes cannot be replayed', async () => {
  await createAgent();
  assert.equal((await call('agentAuth', { action: 'login', email: 'naledi@acme.co.za', password: 'nope-nope-nope' })).statusCode, 403);
  const { secret } = await fullLogin();
  const l2 = await call('agentAuth', { action: 'login', email: 'naledi@acme.co.za', password: 'temporary-pass-1' });
  assert.equal(l2.body.step, 'mfa');
  assert.equal(l2.body.secret, undefined, 'secret never re-sent after enrolment');
  assert.equal((await call('agentAuth', { action: 'verify', challenge: l2.body.challenge, code: '000000' })).statusCode, 401);
  const replay = await call('agentAuth', { action: 'verify', challenge: l2.body.challenge, code: totp(secret) });
  assert.equal(replay.statusCode, 401, 'same code as the enrolment login is refused');
  assert.equal((await call('agentAuth', { action: 'verify', challenge: l2.body.challenge + 'x', code: totp(secret) })).statusCode, 401);
});

test('deactivated agent cannot log in and is signed out', async () => {
  await createAgent();
  await createAgent('sipho@acme.co.za', 'agent');
  const id = agentDocId('sipho@acme.co.za');
  assert.equal((await call('manageAgents', { action: 'setActive', companyId: 'acme', agentId: id, active: false }, { token: ADMIN() })).statusCode, 200);
  assert.ok(fake.revoked.includes(`agent:acme:${id}`));
  assert.equal((await call('agentAuth', { action: 'login', email: 'sipho@acme.co.za', password: 'temporary-pass-1' })).statusCode, 403);
});

test('team management: principals own agency only; agents cannot manage', async () => {
  const principal = asToken({ uid: 'agent:acme:p', role: 'agent', companyId: 'acme', agentRole: 'principal', agentId: 'p' });
  const agent = asToken({ uid: 'agent:acme:a', role: 'agent', companyId: 'acme', agentRole: 'agent' });
  const otherPrincipal = asToken({ uid: 'agent:other:p', role: 'agent', companyId: 'other', agentRole: 'principal' });
  assert.equal((await createAgent('a1@acme.co.za', 'agent', principal)).statusCode, 201);
  assert.equal((await createAgent('a2@acme.co.za', 'agent', agent)).statusCode, 403);
  assert.equal((await createAgent('a3@acme.co.za', 'agent', otherPrincipal)).statusCode, 403);
  assert.equal((await createAgent('a1@acme.co.za', 'agent', principal)).statusCode, 409, 'one account per email');
  const weak = await call('manageAgents', { action: 'create', companyId: 'acme', email: 'w@acme.co.za', name: 'W', role: 'agent', password: 'short' }, { token: principal });
  assert.equal(weak.statusCode, 400);
  const list = await call('manageAgents', { action: 'list', companyId: 'acme' }, { token: principal });
  assert.equal(list.body.agents.length, 1);
  assert.equal(list.body.agents[0].passwordHash, undefined, 'hashes never returned');
});

test('shared agency password stops working once individual logins exist', async () => {
  assert.equal((await call('agentLogin', { name: 'Acme Realty', password: 'shared-pass' })).statusCode, 200);
  await createAgent();
  const r = await call('agentLogin', { name: 'Acme Realty', password: 'shared-pass' });
  assert.equal(r.statusCode, 403);
  assert.match(r.body.error, /individual logins/);
});

test('invites: create → redeem once → submitted/revoked/expired all refused', async () => {
  const agent = asToken({ uid: 'agent:acme:a', role: 'agent', companyId: 'acme', agentRole: 'agent', name: 'Sipho' });
  const c = await call('clientInvite', { action: 'create', clientName: 'Thandi Nkosi' }, { token: agent });
  assert.equal(c.statusCode, 201);
  const inv = fake.store.get(`INVITES/${c.body.inviteId}`);
  assert.equal(inv.companyId, 'acme');
  assert.ok(!JSON.stringify(inv).includes(c.body.token), 'raw token never stored');

  const r = await call('clientInvite', { action: 'redeem', slug: 'acme', invite: c.body.token });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual(JSON.parse(r.body.token).claims, { role: 'client', companyId: 'acme', inviteId: c.body.inviteId });
  assert.equal((await call('clientInvite', { action: 'redeem', slug: 'other', invite: c.body.token })).statusCode, 403, 'wrong agency');

  await fake.db.collection('FICA_SUBMISSIONS').doc(c.body.inviteId).set({ companyId: 'acme' });
  assert.equal((await call('clientInvite', { action: 'redeem', slug: 'acme', invite: c.body.token })).statusCode, 409, 'already submitted');

  const c2 = await call('clientInvite', { action: 'create', clientName: 'X' }, { token: agent });
  assert.equal((await call('clientInvite', { action: 'revoke', inviteId: c2.body.inviteId }, { token: agent })).statusCode, 200);
  assert.equal((await call('clientInvite', { action: 'redeem', slug: 'acme', invite: c2.body.token })).statusCode, 403);

  const c3 = await call('clientInvite', { action: 'create', clientName: 'Y' }, { token: agent });
  await fake.db.collection('INVITES').doc(c3.body.inviteId).update({ expiresAt: new Date(Date.now() - 1000) });
  assert.equal((await call('clientInvite', { action: 'redeem', slug: 'acme', invite: c3.body.token })).statusCode, 403);

  const otherAgent = asToken({ uid: 'agent:other:a', role: 'agent', companyId: 'other' });
  const c4 = await call('clientInvite', { action: 'create', clientName: 'Z' }, { token: agent });
  assert.equal((await call('clientInvite', { action: 'revoke', inviteId: c4.body.inviteId }, { token: otherAgent })).statusCode, 404);
  assert.equal((await call('clientInvite', { action: 'create', clientName: 'Z' })).statusCode, 401, 'needs agent login');
});

test('shared access code refused when agency switches it off', async () => {
  assert.equal((await call('checkClientAccessCode', { slug: 'acme', accessCode: 'code123' })).statusCode, 200);
  await fake.db.collection('COMPANIES').doc('acme').update({ sharedLinkEnabled: false });
  const r = await call('checkClientAccessCode', { slug: 'acme', accessCode: 'code123' });
  assert.equal(r.statusCode, 403);
  assert.match(r.body.error, /personal link/);
});

test('super admin endpoints need the claim, not an email', async () => {
  const impostor = asToken({ uid: 'x', email: 'owner@example.com', email_verified: true });
  assert.equal((await call('adminUpdateCompany', { companyId: 'acme', name: 'Hacked' }, { token: impostor })).statusCode, 403);
  assert.equal((await call('adminUpdateCompany', { companyId: 'acme', sharedLinkEnabled: false }, { token: ADMIN() })).statusCode, 200);
  assert.equal(fake.store.get('COMPANIES/acme').sharedLinkEnabled, false);
});

test('claimSuperAdmin: only the configured admin email, via password sign-in', async () => {
  process.env.SUPER_ADMIN_EMAIL = 'Owner@Example.com';
  const pw = (email, extra = {}) => asToken({ uid: `u-${email}`, email, firebase: { sign_in_provider: 'password' }, ...extra });
  assert.equal((await call('claimSuperAdmin', {}, { token: pw('someone@else.com') })).statusCode, 403);
  assert.equal((await call('claimSuperAdmin', {}, { token: asToken({ uid: 'g', email: 'owner@example.com', firebase: { sign_in_provider: 'google.com' } }) })).statusCode, 403);
  assert.equal((await call('claimSuperAdmin', {}, { token: asToken({ uid: 'agent:acme:x', role: 'agent', companyId: 'acme' }) })).statusCode, 403);
  assert.equal((await call('claimSuperAdmin', {})).statusCode, 401);
  const ok = await call('claimSuperAdmin', {}, { token: pw('owner@example.com') });
  assert.equal(ok.statusCode, 200);
  assert.equal(fake.auth.claims.get('u-owner@example.com').superAdmin, true);
  delete process.env.SUPER_ADMIN_EMAIL;
  assert.equal((await call('claimSuperAdmin', {}, { token: pw('owner@example.com') })).statusCode, 403, 'disabled once env var removed');
});
