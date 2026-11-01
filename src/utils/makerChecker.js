import { env } from '../config/env.js';
import { AppError } from './AppError.js';

/**
 * The person who asked for something must not be the one who approves it.
 * Disabled only when ALLOW_SELF_APPROVAL=true (single-user development).
 */
export function assertDifferentPerson(requestedBy, ctx, what = 'request') {
  if (env.ALLOW_SELF_APPROVAL) return;
  if (requestedBy && ctx.actorId && String(requestedBy) === String(ctx.actorId)) {
    throw new AppError(403, 'SELF_APPROVAL', `You cannot approve your own ${what}. Ask a colleague with approval rights.`);
  }
}
