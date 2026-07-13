const { db } = require('../lib/firebaseAdmin');

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const slug = req.method === 'GET' ? req.query.slug : req.body?.slug;
  if (!slug) return res.status(400).json({ error: 'slug is required' });

  const snap = await db.collection('COMPANIES').where('slug', '==', slug).limit(1).get();
  if (snap.empty) return res.status(404).json({ error: 'not-found' });

  const company = snap.docs[0].data();
  return res.status(200).json({
    companyId: snap.docs[0].id,
    name: company.name,
    tagline: company.tagline || '',
    logoUrl: company.logoUrl || '',
    status: company.status,
  });
};
