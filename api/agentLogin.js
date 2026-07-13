const bcrypt = require('bcryptjs');
const { db, auth } = require('../lib/firebaseAdmin');
const { assertNotLocked, recordAttempt, clientKey } = require('../lib/rateLimit');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { slug, password } = req.body || {};
  if (!slug || !password) return res.status(400).json({ error: 'slug and password are required' });

  const key = clientKey(slug, 'agent', req);

  try {
    await assertNotLocked(db, key);
  } catch (err) {
    return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  }

  const snap = await db.collection('COMPANIES').where('slug', '==', slug).limit(1).get();

  const fail = async () => {
    await recordAttempt(db, key, false);
    return res.status(403).json({ error: 'Wrong company code or password' });
  };

  if (snap.empty) return fail();

  const companyDoc = snap.docs[0];
  const company = companyDoc.data();

  if (company.status === 'suspended') return fail();

  const valid = await bcrypt.compare(password, company.agentPasswordHash || '');
  if (!valid) return fail();

  await recordAttempt(db, key, true);

  const token = await auth.createCustomToken(`agent:${companyDoc.id}`, {
    role: 'agent',
    companyId: companyDoc.id,
  });

  return res.status(200).json({
    token,
    companyId: companyDoc.id,
    name: company.name,
    slug: company.slug,
    logoUrl: company.logoUrl || '',
  });
};
