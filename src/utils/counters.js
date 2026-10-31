import { Counter } from '../models/Counter.js';

/** Atomically increment and return the next value of a named sequence. */
export async function nextSequence(key, session) {
  const doc = await Counter.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after', session }
  );
  return doc.seq;
}
export const pad = (n, width = 6) => String(n).padStart(width, '0');
