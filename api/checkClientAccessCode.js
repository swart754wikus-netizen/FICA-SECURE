const bcrypt = require('bcryptjs');
const { db, auth } = require('../lib/firebaseAdmin');
const { assertNotLocked, recordAttempt, clientKey } = require('../lib/rateLimit');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { slug, accessCode } = req.body || {};
  if (!slug || !accessCode) return res.status(400).json({ error: 'slug and accessCode are required' });

  const key = clientKey(slug, 'client', req);

  try {
    await assertNotLocked(db, key);
  } catch (err) {
    return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  }

  const snap = await db.collection('COMPANIES').where('slug', '==', slug).limit(1).get();

  // Generic failure for both "no such company" and "wrong code" — never reveal which.
  const fail = async () => {
    await recordAttempt(db, key, false);
    return res.status(403).json({ error: 'Wrong access code' });
  };

  if (snap.empty) return fail();

  const companyDoc = snap.docs[0];
  const company = companyDoc.data();

  if (company.status === 'suspended') return fail();

  const valid = await bcrypt.compare(accessCode, company.accessCodeHash || '');
  if (!valid) return fail();

  await recordAttempt(db, key, true);

  const token = await auth.createCustomToken(`client:${companyDoc.id}`, {
    role: 'client',
    companyId: companyDoc.id,
  });

  return res.status(200).json({
    token,
    companyId: companyDoc.id,
    name: company.name,
    logoUrl: company.logoUrl || '',
    tagline: company.tagline || '',
    requiredDocuments: company.requiredDocuments || null,
  });
};
