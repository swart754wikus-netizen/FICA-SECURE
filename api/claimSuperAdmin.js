// One-time, no-terminal way to become super admin: log in to /superadmin with the
// Firebase Auth email/password account whose email matches SUPER_ADMIN_EMAIL (a Vercel
// env var), and this grants that account the `superAdmin` custom claim the rules check.
// This is the same trust the old email-based rules gave that account — it only converts
// it to a claim. Remove SUPER_ADMIN_EMAIL from Vercel afterwards to switch this off;
// scripts/grantSuperAdmin.js remains for adding/removing admins later.
const { auth } = require('../lib/firebaseAdmin');
const { requireAuth } = require('../lib/requireAuth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let decoded;
  try { decoded = await requireAuth(req); } catch (err) { return res.status(err.status || 401).json({ error: err.message }); }

  if (decoded.superAdmin === true) return res.status(200).json({ ok: true, already: true });

  const allowed = String(process.env.SUPER_ADMIN_EMAIL || '').trim().toLowerCase();
  const email = String(decoded.email || '').trim().toLowerCase();
  // Only a password sign-in to the existing admin account — not a custom token, and not
  // some other provider that could carry the same email address.
  if (!allowed || email !== allowed || decoded.firebase?.sign_in_provider !== 'password') {
    return res.status(403).json({ error: 'This account is not a super admin.' });
  }

  const user = await auth.getUser(decoded.uid);
  await auth.setCustomUserClaims(decoded.uid, { ...(user.customClaims || {}), superAdmin: true });
  console.log(`Granted superAdmin claim to uid ${decoded.uid}`);
  return res.status(200).json({ ok: true });
};
