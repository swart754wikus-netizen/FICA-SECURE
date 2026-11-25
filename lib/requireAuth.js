const { auth } = require('./firebaseAdmin');

/** Verifies the Firebase ID token in "Authorization: Bearer <token>". Throws {status}. */
async function requireAuth(req) {
  const match = (req.headers.authorization || '').match(/^Bearer (.+)$/);
  if (!match) throw Object.assign(new Error('Missing Authorization header'), { status: 401 });
  try {
    return await auth.verifyIdToken(match[1], true); // checkRevoked: deactivated agents are cut off
  } catch {
    throw Object.assign(new Error('Session expired. Please log in again.'), { status: 401 });
  }
}

const isSuperAdmin = (t) => t.superAdmin === true;
const isAgent = (t) => t.role === 'agent' && typeof t.companyId === 'string';
const isPrincipalFor = (t, companyId) => isAgent(t) && t.companyId === companyId && t.agentRole === 'principal';

module.exports = { requireAuth, isSuperAdmin, isAgent, isPrincipalFor };
