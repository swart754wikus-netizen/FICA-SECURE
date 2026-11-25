// Team management for individual agent logins. Callable by the super admin (any agency)
// or by an agency principal (own agency only).
//   { action: 'list',   companyId }
//   { action: 'create', companyId, email, name, role, password }
//   { action: 'setActive', companyId, agentId, active }
//   { action: 'resetMfa' | 'resetPassword', companyId, agentId, [password] }
const bcrypt = require('bcryptjs');
const { db, auth } = require('../lib/firebaseAdmin');
const { requireAuth, isSuperAdmin, isPrincipalFor } = require('../lib/requireAuth');
const { agentDocId } = require('../lib/secrets');

const ROLES = ['principal', 'agent'];
const MIN_PASSWORD = 10;
const fail = (res, status, error) => res.status(status).json({ error });

module.exports = async (req, res) => {
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');
  let caller;
  try { caller = await requireAuth(req); } catch (err) { return fail(res, err.status || 401, err.message); }

  const { action, companyId } = req.body || {};
  if (!companyId) return fail(res, 400, 'companyId is required');
  if (!isSuperAdmin(caller) && !isPrincipalFor(caller, companyId)) return fail(res, 403, 'Only the agency principal can manage the team');

  const company = await db.collection('COMPANIES').doc(companyId).get();
  if (!company.exists) return fail(res, 404, 'Agency not found');
  const audit = (act, detail) => db.collection('AUDIT_LOG').add({ companyId, actor: caller.uid, action: act, submissionId: null, detail, ts: new Date() });

  if (action === 'list') {
    const snap = await db.collection('AGENTS').where('companyId', '==', companyId).get();
    const agents = snap.docs.map((d) => {
      const a = d.data();
      return { id: d.id, email: a.email, name: a.name, role: a.role, active: a.active !== false, mfaEnrolled: Boolean(a.totpSecretEnc), lastLoginAt: a.lastLoginAt?.toDate?.()?.toISOString() || null };
    }).sort((x, y) => x.name.localeCompare(y.name));
    return res.status(200).json({ agents });
  }

  if (action === 'create') {
    const email = String(req.body.email || '').trim().toLowerCase();
    const name = String(req.body.name || '').trim().slice(0, 100);
    const role = ROLES.includes(req.body.role) ? req.body.role : 'agent';
    const password = String(req.body.password || '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !name) return fail(res, 400, 'Enter a name and a valid email address');
    if (password.length < MIN_PASSWORD) return fail(res, 400, `Temporary password must be at least ${MIN_PASSWORD} characters`);
    const id = agentDocId(email);
    try {
      // Doc ID is derived from the email, so .create() enforces one account per email atomically.
      await db.collection('AGENTS').doc(id).create({
        companyId, email, name, role, active: true,
        passwordHash: await bcrypt.hash(password, 10),
        totpSecretEnc: null, pendingTotpEnc: null, totpLastCounter: 0,
        createdAt: new Date(), createdBy: caller.uid,
      });
    } catch (err) {
      if (err.code === 6) return fail(res, 409, 'An account with this email already exists');
      throw err;
    }
    await audit('team.agent_created', { agentId: id, role });
    return res.status(201).json({ agentId: id });
  }

  const agentId = String(req.body.agentId || '');
  const ref = db.collection('AGENTS').doc(agentId);
  const snap = await ref.get();
  if (!snap.exists || snap.data().companyId !== companyId) return fail(res, 404, 'Agent not found');
  const uid = `agent:${companyId}:${agentId}`;
  const revoke = () => auth.revokeRefreshTokens(uid).catch(() => {}); // user may never have logged in

  if (action === 'setActive') {
    const active = req.body.active === true;
    if (!active && caller.agentId === agentId) return fail(res, 400, "You can't deactivate your own account");
    await ref.update({ active });
    if (!active) await revoke();
    await audit(active ? 'team.agent_activated' : 'team.agent_deactivated', { agentId });
    return res.status(200).json({ ok: true });
  }
  if (action === 'resetMfa') {
    await ref.update({ totpSecretEnc: null, pendingTotpEnc: null, totpLastCounter: 0 });
    await revoke();
    await audit('team.mfa_reset', { agentId });
    return res.status(200).json({ ok: true });
  }
  if (action === 'resetPassword') {
    const password = String(req.body.password || '');
    if (password.length < MIN_PASSWORD) return fail(res, 400, `Password must be at least ${MIN_PASSWORD} characters`);
    await ref.update({ passwordHash: await bcrypt.hash(password, 10) });
    await revoke();
    await audit('team.password_reset', { agentId });
    return res.status(200).json({ ok: true });
  }
  return fail(res, 400, 'Unknown action');
};
