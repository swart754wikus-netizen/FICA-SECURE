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

  const { name, slug, accessCode, agentPassword, status, payment, requiredDocuments } = req.body || {};
  if (!name || !slug || !accessCode || !agentPassword) {
    return res.status(400).json({ error: 'name, slug, accessCode, and agentPassword are required' });
  }

  const [accessCodeHash, agentPasswordHash] = await Promise.all([
    bcrypt.hash(accessCode, 10),
    bcrypt.hash(agentPassword, 10),
  ]);

  // slug doubles as the doc ID so .create() atomically enforces uniqueness —
  // no separate query-then-write race window.
  try {
    await db.collection('COMPANIES').doc(slug).create({
      name,
      slug,
      tagline: '',
      logoUrl: '',
      accessCodeHash,
      agentPasswordHash,
      status: status || 'trial',
      payment: payment || 'unpaid',
      requiredDocuments: requiredDocuments || null,
      createdAt: new Date(),
    });
  } catch (err) {
    if (err.code === 6 /* ALREADY_EXISTS */) {
      return res.status(409).json({ error: 'Slug already in use' });
    }
    throw err;
  }

  return res.status(201).json({ companyId: slug });
};
