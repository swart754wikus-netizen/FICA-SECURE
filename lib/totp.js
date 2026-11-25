// RFC 6238 TOTP (SHA-1, 30 s, 6 digits) — works with Google/Microsoft Authenticator, Authy.
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  let bits = 0, value = 0; const out = [];
  for (const ch of str.replace(/=+$/, '').toUpperCase().replace(/\s/g, '')) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32');
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const generateSecret = () => base32Encode(crypto.randomBytes(20));

function codeAt(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const off = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(off) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

const counterAt = (time = Date.now()) => Math.floor(time / 30_000);
const totp = (secret, time = Date.now()) => codeAt(secret, counterAt(time));

/**
 * Returns the matched time-step counter (so callers can reject replays of the same code),
 * or null. Accepts ±1 step for clock drift.
 */
function verifyTotp(secret, code, time = Date.now()) {
  if (!/^\d{6}$/.test(String(code))) return null;
  const now = counterAt(time);
  for (const c of [now - 1, now, now + 1]) {
    if (crypto.timingSafeEqual(Buffer.from(codeAt(secret, c)), Buffer.from(String(code)))) return c;
  }
  return null;
}

const otpauthUri = (secret, account, issuer = 'FICA Secure') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`;

module.exports = { generateSecret, totp, verifyTotp, otpauthUri, base32Encode, base32Decode };
