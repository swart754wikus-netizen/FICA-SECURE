const bcrypt = require('bcryptjs');
const { db } = require('../lib/firebaseAdmin');
const { requireSuperAdmin } = require('../lib/requireSuperAdmin');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    await requireSuperAdmin(req);
  } catch (err) {
    return res.status(err.status || 401).json({ error: err.message });
  }

  const { companyId, accessCode, agentPassword, ...fields } = req.body || {};
  if (!companyId) return res.status(400).json({ error: 'companyId is required' });

  const ref = db.collection('COMPANIES').doc(companyId);
  const snap = await ref.get();
  if (!snap.exists) return res.status(404).json({ error: 'not-found' });

  // Only these fields may be edited from the admin panel; anything else in the
  // request body (e.g. accessCodeHash) is ignored rather than trusted verbatim.
  const allowed = ['name', 'tagline', 'logoUrl', 'status', 'payment', 'requiredDocuments', 'lastPaidAt', 'nextDueAt', 'trialEndsAt'];
  const update = {};
  for (const key of allowed) {
    if (key in fields) update[key] = fields[key];
  }
  // Agent login looks companies up by name (see agentLogin.js), so this
  // normalized copy must stay in sync whenever the display name changes.
  if ('name' in update) update.nameLower = update.name.trim().toLowerCase();

  // Blank = keep existing hash, matching the v1 "leave blank to keep current password" UX.
  if (accessCode) update.accessCodeHash = await bcrypt.hash(accessCode, 10);
  if (agentPassword) update.agentPasswordHash = await bcrypt.hash(agentPassword, 10);

  if (Object.keys(update).length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  await ref.update(update);
  return res.status(200).json({ companyId });
};
