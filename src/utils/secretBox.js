import crypto from 'node:crypto';
import { env } from '../config/env.js';

// AES-256-GCM encryption for small secrets stored in the database (authenticator secrets).
let key;
const getKey = () => (key ??= Buffer.from(crypto.hkdfSync('sha256', env.MFA_ENCRYPTION_KEY ?? env.JWT_SECRET, 'hospital-billing', 'secret-box-v1', 32)));

export function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}

export function decryptSecret(token) {
  const [v, iv, tag, enc] = String(token).split('.');
  if (v !== 'v1' || !iv || !tag || !enc) throw new Error('Unrecognised secret format');
  const d = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}
