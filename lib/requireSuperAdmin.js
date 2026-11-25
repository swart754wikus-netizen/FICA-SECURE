const { auth } = require('./firebaseAdmin');

async function requireSuperAdmin(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer (.+)$/);
  if (!match) {
    const err = new Error('Missing Authorization header');
    err.status = 401;
    throw err;
  }
  const decoded = await auth.verifyIdToken(match[1]);
  // Custom claim set by scripts/grantSuperAdmin.js — see firestore.rules isSuperAdmin().
  if (decoded.superAdmin !== true) {
    const err = new Error('Forbidden');
    err.status = 403;
    throw err;
  }
  return decoded;
}

module.exports = { requireSuperAdmin };
