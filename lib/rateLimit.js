const admin = require('firebase-admin');

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

/**
 * Atomically checks the lock and reserves this attempt's slot in the same
 * transaction, BEFORE the (slow) credential check runs — this is what makes
 * the limiter hold under concurrent/parallel requests, not just sequential
 * ones. A plain "check lock, then separately record the attempt" (the
 * previous implementation) lets N simultaneous requests all read
 * not-yet-locked state before any of them commits, so all N proceed
 * regardless of MAX_ATTEMPTS.
 */
async function reserveAttempt(db, key) {
  const ref = attemptDocRef(db, key);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();
    const data = snap.exists ? snap.data() : null;

    if (data && data.lockedUntil && data.lockedUntil.toMillis() > now) {
      const err = new Error('Too many attempts. Try again later.');
      err.code = 'locked';
      throw err;
    }

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

async function clearAttempts(db, key) {
  await attemptDocRef(db, key).set({ count: 0, windowStart: admin.firestore.Timestamp.now(), lockedUntil: null });
}

function clientKey(slug, role, req) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  return `${slug}:${role}:${ip}`;
}

module.exports = { reserveAttempt, clearAttempts, clientKey };
