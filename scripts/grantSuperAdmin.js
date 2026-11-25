// Grants (or revokes) the super admin custom claim on an existing Firebase Auth user.
// Run once after deploying the new rules, then sign out and back in to /superadmin.
//
//   FIREBASE_PROJECT_ID=... FIREBASE_CLIENT_EMAIL=... FIREBASE_PRIVATE_KEY=... \
//     node scripts/grantSuperAdmin.js you@example.com          # grant
//     node scripts/grantSuperAdmin.js you@example.com --revoke # revoke
const { auth } = require('../lib/firebaseAdmin');

(async () => {
  const [email, flag] = process.argv.slice(2);
  if (!email) {
    console.error('Usage: node scripts/grantSuperAdmin.js <email> [--revoke]');
    process.exit(1);
  }
  const user = await auth.getUserByEmail(email);
  const claims = { ...(user.customClaims || {}) };
  if (flag === '--revoke') delete claims.superAdmin;
  else claims.superAdmin = true;
  await auth.setCustomUserClaims(user.uid, claims);
  await auth.revokeRefreshTokens(user.uid); // force a fresh token carrying the new claim
  console.log(`${flag === '--revoke' ? 'Revoked' : 'Granted'} super admin for ${email} (uid ${user.uid}). Sign in again to pick it up.`);
  process.exit(0);
})().catch((err) => { console.error(err.message); process.exit(1); });
