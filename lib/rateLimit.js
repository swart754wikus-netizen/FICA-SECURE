const MAX_ATTEMPTS = 8;
const WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;

/**
 * Firestore-backed login attempt limiter, keyed per (slug + role [+ client IP]).
 * Cloud Function / Vercel serverless instances are stateless and ephemeral, so
 * in-memory counters don't work across invocations — this is why the counter
 * lives in Firestore instead.
 */
function attemptDocRef(db, key) {
  return db.collection('LOGIN_ATTEMPTS').doc(key);
}

async function assertNotLocked(db, key) {
  const snap = await attemptDocRef(db, key).get();
  if (!snap.exists) return;
  const data = snap.data();
  if (data.lockedUntil && data.lockedUntil.toMillis() > Date.now()) {
    const err = new Error('Too many attempts. Try again later.');
    err.code = 'locked';
    throw err;
  }
}

async function recordAttempt(db, key, success) {
  const ref = attemptDocRef(db, key);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();
    const admin = require('firebase-admin');

    if (success) {
      tx.set(ref, { count: 0, windowStart: admin.firestore.Timestamp.now(), lockedUntil: null });
      return;
    }

    const data = snap.exists ? snap.data() : null;
    const windowStart = data && data.windowStart ? data.windowStart.toMillis() : now;
    const withinWindow = now - windowStart < WINDOW_MS;
    const count = (withinWindow && data ? data.count : 0) + 1;

    const update = {
      count,
      windowStart: withinWindow && data ? data.windowStart : admin.firestore.Timestamp.now(),
      lockedUntil: null,
    };
    if (count >= MAX_ATTEMPTS) {
      update.lockedUntil = admin.firestore.Timestamp.fromMillis(now + LOCKOUT_MS);
    }
    tx.set(ref, update);
  });
}

function clientKey(slug, role, req) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  return `${slug}:${role}:${ip}`;
}

module.exports = { assertNotLocked, recordAttempt, clientKey };
