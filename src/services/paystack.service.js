import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { AppError } from '../utils/AppError.js';

const BASE_URL = 'https://api.paystack.co';

function secretKey() {
  if (!env.PAYSTACK_SECRET_KEY) throw new AppError(503, 'PAYSTACK_NOT_CONFIGURED', 'Paystack is not configured on this server');
  return env.PAYSTACK_SECRET_KEY;
}

async function call(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(BASE_URL + path, {
      method,
      headers: { Authorization: `Bearer ${secretKey()}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(502, 'PAYSTACK_UNREACHABLE', 'Could not reach Paystack. Please try again.');
  }
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok || !json?.status) {
    throw new AppError(502, 'PAYSTACK_ERROR', json?.message || `Paystack responded with HTTP ${res.status}`);
  }
  return json;
}

/** amount is in kobo, which is exactly what Paystack expects for NGN. */
export const initializeTransaction = (payload) => call('/transaction/initialize', { method: 'POST', body: payload });
export const verifyTransaction = (reference) => call(`/transaction/verify/${encodeURIComponent(reference)}`);

/** Webhook authenticity: HMAC-SHA512 of the RAW request body, keyed with your secret key. */
export function verifySignature(rawBody, signature) {
  if (!rawBody || !signature) return false;
  const expected = crypto.createHmac('sha512', secretKey()).update(rawBody).digest();
  const given = Buffer.from(String(signature), 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
