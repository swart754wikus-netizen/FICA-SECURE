const bcrypt = require('bcryptjs');
const { db, auth } = require('../lib/firebaseAdmin');
const { reserveAttempt, clearAttempts, clientKey } = require('../lib/rateLimit');

// See checkClientAccessCode.js for why this exists: a fixed dummy hash keeps
// the "no such company" path taking the same time as a real wrong-password
// check, so response latency can't be used to enumerate valid slugs.
const DUMMY_HASH = '$2a$10$56jm2Mmao0MDGMdaJY3.Y.7n1HCQtFyAgI.fdty2Dg2qMEruLC6vy';

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { slug, password } = req.body || {};
  if (!slug || !password) return res.status(400).json({ error: 'slug and password are required' });

  const key = clientKey(slug, 'agent', req);

  try {
    await reserveAttempt(db, key);
  } catch (err) {
    return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  }

  const snap = await db.collection('COMPANIES').where('slug', '==', slug).limit(1).get();

  if (snap.empty) {
    await bcrypt.compare(password, DUMMY_HASH);
    return res.status(403).json({ error: 'Wrong company code or password' });
  }

  const companyDoc = snap.docs[0];
  const company = companyDoc.data();

  if (company.status === 'suspended') {
    await bcrypt.compare(password, DUMMY_HASH);
    return res.status(403).json({ error: 'Wrong company code or password' });
  }

  const valid = await bcrypt.compare(password, company.agentPasswordHash || DUMMY_HASH);
  if (!valid) return res.status(403).json({ error: 'Wrong company code or password' });

  await clearAttempts(db, key);

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
