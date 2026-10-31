import { z } from 'zod';
const keySchema = z.string().trim().min(8).max(100).regex(/^[A-Za-z0-9._:-]+$/, 'may only contain letters, digits and . _ : -');

/** Idempotency-Key header (preferred) or body.idempotencyKey. Lets a client safely retry a request. */
export function idempotencyKeyOf(req) {
  const raw = req.get('idempotency-key') ?? req.body?.idempotencyKey;
  if (raw === undefined || raw === '') return undefined;
  return keySchema.parse(raw);
}
