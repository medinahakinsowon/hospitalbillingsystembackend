import crypto from 'node:crypto';

// RFC 6238 time-based one-time passwords (what Google Authenticator, Microsoft Authenticator and Authy use).
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = str.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0; let value = 0; const out = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('Invalid base32 character');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; value &= (1 << bits) - 1; }
  }
  return Buffer.from(out);
}

export const generateSecret = () => base32Encode(crypto.randomBytes(20));

export function hotp(secretBuf, counter, digits = 6) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secretBuf).update(msg).digest();
  const o = h[19] & 0xf;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const stepOf = (timeMs = Date.now(), stepSeconds = 30) => Math.floor(timeMs / 1000 / stepSeconds);
export const totpAt = (secretB32, timeMs = Date.now(), digits = 6) => hotp(base32Decode(secretB32), stepOf(timeMs), digits);

/**
 * Check a 6-digit code, allowing one 30-second step either side for clock drift.
 * Returns the matched step, or null. Steps at or below `lastStep` are refused, so a code cannot be replayed.
 */
export function verifyTotp(secretB32, code, { timeMs = Date.now(), window = 1, lastStep = 0 } = {}) {
  if (!/^\d{6}$/.test(String(code))) return null;
  const secret = base32Decode(secretB32);
  const now = stepOf(timeMs);
  const given = Buffer.from(String(code));
  for (let off = -window; off <= window; off++) {
    const step = now + off;
    if (step <= lastStep) continue;
    const expected = Buffer.from(hotp(secret, step));
    if (crypto.timingSafeEqual(expected, given)) return step;
  }
  return null;
}

export function otpauthUri({ secret, account, issuer }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
