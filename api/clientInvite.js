// Per-client, single-use invite links.
//   Agent (Bearer ID token): { action: 'create', clientName } -> { token, inviteId, expiresAt }
//                            { action: 'revoke', inviteId }
//   Client (no auth):        { action: 'redeem', slug, invite } -> { token (Firebase custom token), branding... }
// The invite token is never stored — only its SHA-256, which doubles as the submission ID,
// so each invite can produce exactly one FICA submission (enforced in firestore.rules).
const { db, auth } = require('../lib/firebaseAdmin');
const { requireAuth, isAgent } = require('../lib/requireAuth');
const { reserveAttempt, clientKey } = require('../lib/rateLimit');
const { sha256, randomToken } = require('../lib/secrets');

const INVITE_DAYS = 7;
const fail = (res, status, error) => res.status(status).json({ error });

module.exports = async (req, res) => {
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');
  const { action } = req.body || {};
  try {
    if (action === 'redeem') return await redeem(req, res);
    let caller;
    try { caller = await requireAuth(req); } catch (err) { return fail(res, err.status || 401, err.message); }
    if (!isAgent(caller)) return fail(res, 403, 'Agents only');
    if (action === 'create') return await create(req, res, caller);
    if (action === 'revoke') return await revoke(req, res, caller);
    return fail(res, 400, 'Unknown action');
  } catch (err) {
    if (err.code === 'locked') return fail(res, 429, 'Too many attempts. Try again later.');
    console.error('clientInvite error', err.message);
    return fail(res, 500, 'Something went wrong. Please try again.');
  }
};

async function create(req, res, caller) {
  const clientName = String(req.body.clientName || '').trim().slice(0, 120);
  if (!clientName) return fail(res, 400, "Enter the client's name");
  const token = randomToken();
  const inviteId = sha256(token);
  const expiresAt = new Date(Date.now() + INVITE_DAYS * 864e5);
  await db.collection('INVITES').doc(inviteId).create({
    companyId: caller.companyId,
    clientName,
    status: 'pending',
    createdBy: caller.uid,
    createdByName: caller.name || 'Shared agency login',
    createdAt: new Date(),
    expiresAt,
  });
  await db.collection('AUDIT_LOG').add({ companyId: caller.companyId, actor: caller.uid, action: 'invite.created', submissionId: inviteId, detail: null, ts: new Date() });
  return res.status(201).json({ token, inviteId, expiresAt: expiresAt.toISOString() });
}

async function revoke(req, res, caller) {
  const ref = db.collection('INVITES').doc(String(req.body.inviteId || ''));
  const snap = await ref.get();
  if (!snap.exists || snap.data().companyId !== caller.companyId) return fail(res, 404, 'Invite not found');
  if (snap.data().status !== 'pending') return fail(res, 409, 'This invite is no longer pending');
  await ref.update({ status: 'revoked', revokedBy: caller.uid, revokedAt: new Date() });
  await db.collection('AUDIT_LOG').add({ companyId: caller.companyId, actor: caller.uid, action: 'invite.revoked', submissionId: snap.id, detail: null, ts: new Date() });
  return res.status(200).json({ ok: true });
}

async function redeem(req, res) {
  const { slug, invite } = req.body;
  if (!slug || !invite) return fail(res, 400, 'Invalid link');
  await reserveAttempt(db, clientKey('invite', 'redeem', req));

  const inviteId = sha256(invite);
  const [inviteSnap, companyQuery, existing] = await Promise.all([
    db.collection('INVITES').doc(inviteId).get(),
    // Older agencies' doc IDs may differ from their slug (pre-migration data), so look up by field.
    db.collection('COMPANIES').where('slug', '==', String(slug)).limit(1).get(),
    db.collection('FICA_SUBMISSIONS').doc(inviteId).get(),
  ]);
  const companySnap = companyQuery.docs[0] || { id: null, data: () => null };
  const inv = inviteSnap.data();
  const company = companySnap.data();
  const invalid = 'This link is invalid or has expired. Ask your agent for a new one.';
  if (!inv || !company || inv.companyId !== companySnap.id) return fail(res, 403, invalid);
  if (existing.exists) return fail(res, 409, 'This form has already been submitted. Thank you!');
  if (inv.status !== 'pending' || inv.expiresAt.toDate() < new Date()) return fail(res, 403, invalid);
  if (company.status === 'suspended') return fail(res, 403, 'This agency portal is currently unavailable.');

  const token = await auth.createCustomToken(`client:${companySnap.id}:${inviteId}`, {
    role: 'client',
    companyId: companySnap.id,
    inviteId,
  });
  return res.status(200).json({
    token,
    inviteId,
    clientName: inv.clientName,
    companyId: companySnap.id,
    name: company.name,
    logoUrl: company.logoUrl || '',
    tagline: company.tagline || '',
    requiredDocuments: company.requiredDocuments || null,
  });
}
