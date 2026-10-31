import mongoose from 'mongoose';
import { env } from './env.js';
import { AppError } from '../utils/AppError.js';

// Cache the connection on globalThis so warm serverless invocations reuse it
// instead of opening a new connection each time (protects Atlas connection limits).
const cache = (globalThis.__mongooseCache ??= { conn: null, promise: null });

export async function connectDB() {
  if (cache.conn) return cache.conn;
  if (!cache.promise) {
    mongoose.set('strictQuery', true);
    cache.promise = mongoose.connect(env.MONGODB_URI, {
      bufferCommands: false,
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 8000,
      autoIndex: !env.isProd, // in production create indexes with `npm run db:init`
    });
  }
  try {
    cache.conn = await cache.promise;
  } catch (err) {
    cache.promise = null;
    console.error('MongoDB connection failed:', err.name);
    throw new AppError(503, 'DB_UNAVAILABLE', 'Database is temporarily unavailable');
  }
  return cache.conn;
}

export async function disconnectDB() {
  if (cache.conn) await mongoose.disconnect();
  cache.conn = null;
  cache.promise = null;
}

/**
 * Run `fn(session)` inside a MongoDB transaction. Retries transient errors.
 * `fn` may run more than once, so keep it free of side effects outside the DB.
 */
export async function withTransaction(fn) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(
      async () => {
        result = await fn(session);
      },
      { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } }
    );
    return result;
  } finally {
    await session.endSession();
  }
}
