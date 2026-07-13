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
  if (decoded.email !== process.env.SUPER_ADMIN_EMAIL) {
    const err = new Error('Forbidden');
    err.status = 403;
    throw err;
  }
  return decoded;
}

module.exports = { requireSuperAdmin };
