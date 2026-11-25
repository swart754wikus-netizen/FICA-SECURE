// Server-side secrets helpers. DATA_ENCRYPTION_KEY: 32 random bytes, base64
// (node -e "console.log(require('crypto').randomBytes(32).toString('base64'))").
const crypto = require('crypto');

function key() {
  const k = Buffer.from(process.env.DATA_ENCRYPTION_KEY || '', 'base64');
  if (k.length !== 32) throw new Error('DATA_ENCRYPTION_KEY must be 32 bytes (base64) — see .env.example');
  return k;
}

/** AES-256-GCM → base64 string "v1.<iv>.<tag>.<ciphertext>" (used for TOTP secrets at rest). */
function encrypt(plain, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join('.');
}

function decrypt(blob, aad) {
  const [v, iv, tag, ct] = String(blob).split('.');
  if (v !== 'v1') throw new Error('Unknown ciphertext version');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

/** Short-lived signed token for the password → MFA step (stateless, HMAC-SHA256). */
function signChallenge(payload, ttlMs = 5 * 60_000) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs })).toString('base64url');
  const sig = crypto.createHmac('sha256', key()).update(`challenge.${body}`).digest('base64url');
  return `${body}.${sig}`;
}

function verifyChallenge(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', key()).update(`challenge.${body}`).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  return payload.exp > Date.now() ? payload : null;
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

/** AGENTS doc ID: one account per email, enforced atomically with .create(). */
const agentDocId = (email) => sha256(String(email).trim().toLowerCase());

module.exports = { agentDocId, encrypt, decrypt, signChallenge, verifyChallenge, sha256, randomToken };
