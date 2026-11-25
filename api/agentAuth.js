// Individual agent login: email + password, then a mandatory authenticator-app code.
//   POST { action: 'login', email, password }  -> { step: 'mfa' | 'enroll', challenge, [secret, otpauthUri] }
//   POST { action: 'verify', challenge, code } -> { token, ...agency }
const bcrypt = require('bcryptjs');
const { db, auth } = require('../lib/firebaseAdmin');
const { reserveAttempt, clearAttempts, clientKey } = require('../lib/rateLimit');
const { agentDocId, encrypt, decrypt, signChallenge, verifyChallenge } = require('../lib/secrets');
const { generateSecret, verifyTotp, otpauthUri } = require('../lib/totp');

const DUMMY_HASH = '$2a$10$56jm2Mmao0MDGMdaJY3.Y.7n1HCQtFyAgI.fdty2Dg2qMEruLC6vy';
const fail = (res, status, error) => res.status(status).json({ error });

async function limited(keys) {
  for (const k of keys) await reserveAttempt(db, k);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');
  const { action } = req.body || {};
  try {
    if (action === 'login') return await login(req, res);
    if (action === 'verify') return await verify(req, res);
    return fail(res, 400, 'Unknown action');
  } catch (err) {
    if (err.code === 'locked') return fail(res, 429, 'Too many attempts. Try again later.');
    console.error('agentAuth error', err.message);
    return fail(res, 500, 'Something went wrong. Please try again.');
  }
};

async function login(req, res) {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!email || !password) return fail(res, 400, 'Email and password are required');

  // Per-IP and per-account limits: stops both guessing from one machine and
  // spreading guesses for one account across many IPs.
  await limited([clientKey(email, 'agent2', req), `${agentDocId(email)}:agent2:any`]);

  const ref = db.collection('AGENTS').doc(agentDocId(email));
  const snap = await ref.get();
  const agent = snap.exists ? snap.data() : null;
  const ok = await bcrypt.compare(password, agent?.passwordHash || DUMMY_HASH);
  if (!agent || !ok || agent.active === false) return fail(res, 403, 'Wrong email or password');

  const company = (await db.collection('COMPANIES').doc(agent.companyId).get()).data();
  if (!company || company.status === 'suspended') return fail(res, 403, 'Wrong email or password');

  if (agent.totpSecretEnc) {
    return res.status(200).json({ step: 'mfa', challenge: signChallenge({ agentId: snap.id, purpose: 'mfa' }) });
  }
  // First login (or MFA was reset): enrol an authenticator app before any access.
  const secret = generateSecret();
  await ref.update({ pendingTotpEnc: encrypt(secret, `totp:${snap.id}`) });
  return res.status(200).json({
    step: 'enroll',
    challenge: signChallenge({ agentId: snap.id, purpose: 'enroll' }),
    secret,
    otpauthUri: otpauthUri(secret, `${company.name} — ${email}`),
  });
}

async function verify(req, res) {
  const payload = verifyChallenge(req.body.challenge);
  if (!payload) return fail(res, 401, 'Your login step expired. Please start again.');
  await limited([`${payload.agentId}:mfa:any`]);

  const ref = db.collection('AGENTS').doc(payload.agentId);
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const agent = snap.data();
    if (!agent || agent.active === false) return { error: 'Account disabled' };
    const enc = payload.purpose === 'enroll' ? agent.pendingTotpEnc : agent.totpSecretEnc;
    if (!enc) return { error: 'Please start again.' };
    const counter = verifyTotp(decrypt(enc, `totp:${snap.id}`), req.body.code);
    // Reject a code already used (replay), even inside its 30-second window.
    if (counter === null || (agent.totpLastCounter && counter <= agent.totpLastCounter)) return { error: 'Invalid code' };
    const update = { totpLastCounter: counter, lastLoginAt: new Date() };
    if (payload.purpose === 'enroll') Object.assign(update, { totpSecretEnc: agent.pendingTotpEnc, pendingTotpEnc: null, mfaEnrolledAt: new Date() });
    tx.update(ref, update);
    return { agent };
  });
  if (result.error) return fail(res, 401, result.error);

  const { agent } = result;
  const companyDoc = await db.collection('COMPANIES').doc(agent.companyId).get();
  const company = companyDoc.data();
  if (!company || company.status === 'suspended') return fail(res, 403, 'This agency is unavailable');
  await clearAttempts(db, `${payload.agentId}:mfa:any`);
  await clearAttempts(db, `${payload.agentId}:agent2:any`);

  const uid = `agent:${agent.companyId}:${payload.agentId}`;
  const token = await auth.createCustomToken(uid, {
    role: 'agent',
    companyId: agent.companyId,
    agentId: payload.agentId,
    agentRole: agent.role,
    name: agent.name,
  });
  await db.collection('AUDIT_LOG').add({
    companyId: agent.companyId, actor: uid, action: payload.purpose === 'enroll' ? 'auth.mfa_enrolled' : 'auth.login',
    submissionId: null, detail: null, ts: new Date(),
  });
  return res.status(200).json({
    token,
    companyId: companyDoc.id,
    name: company.name,
    slug: company.slug,
    logoUrl: company.logoUrl || '',
    sharedLinkEnabled: company.sharedLinkEnabled !== false,
    agent: { name: agent.name, email: agent.email, role: agent.role },
  });
}

