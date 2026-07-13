const bcrypt = require('bcryptjs');
const { db, auth } = require('../lib/firebaseAdmin');
const { reserveAttempt, clearAttempts, clientKey } = require('../lib/rateLimit');

// Fixed dummy hash compared against when no company matches, so a missing
// slug takes the same amount of time as a wrong-code check against a real
// one — otherwise response latency alone reveals whether a slug exists,
// regardless of the generic error message.
const DUMMY_HASH = '$2a$10$56jm2Mmao0MDGMdaJY3.Y.7n1HCQtFyAgI.fdty2Dg2qMEruLC6vy';

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { slug, accessCode } = req.body || {};
  if (!slug || !accessCode) return res.status(400).json({ error: 'slug and accessCode are required' });

  const key = clientKey(slug, 'client', req);

  try {
    await reserveAttempt(db, key);
  } catch (err) {
    return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  }

  const snap = await db.collection('COMPANIES').where('slug', '==', slug).limit(1).get();

  // Generic failure for both "no such company" and "wrong code" — never reveal which.
  if (snap.empty) {
    await bcrypt.compare(accessCode, DUMMY_HASH);
    return res.status(403).json({ error: 'Wrong access code' });
  }

  const companyDoc = snap.docs[0];
  const company = companyDoc.data();

  if (company.status === 'suspended') {
    await bcrypt.compare(accessCode, DUMMY_HASH);
    return res.status(403).json({ error: 'Wrong access code' });
  }

  const valid = await bcrypt.compare(accessCode, company.accessCodeHash || DUMMY_HASH);
  if (!valid) return res.status(403).json({ error: 'Wrong access code' });

  await clearAttempts(db, key);

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
