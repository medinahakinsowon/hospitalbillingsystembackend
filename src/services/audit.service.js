import { AuditLog } from '../models/AuditLog.js';

export function reqContext(req) {
  return {
    actorId: req.user?.id ?? null,
    actorRole: req.user?.role ?? null,
    ip: req.ip,
    userAgent: req.get('user-agent')?.slice(0, 200),
  };
}

const strip = (o) => {
  if (!o) return o;
  const { passwordHash, ...rest } = o; // eslint-disable-line no-unused-vars
  return rest;
};

/** Write an audit record. Pass `session` to make it part of the same transaction as the change. */
export async function recordAudit(ctx, { action, entity, entityId, before, after, meta }, session) {
  await AuditLog.create(
    [{
      actorId: ctx.actorId, actorRole: ctx.actorRole, ip: ctx.ip, userAgent: ctx.userAgent,
      action, entity, entityId, before: strip(before), after: strip(after), meta,
    }],
    session ? { session } : {}
  );
}

/** Returns only the fields that actually changed, so audit entries stay small. */
export function changedFields(before, patch, keys) {
  const b = {};
  const a = {};
  for (const k of keys) {
    if (patch[k] === undefined) continue;
    if (JSON.stringify(before[k]) !== JSON.stringify(patch[k])) {
      b[k] = before[k] ?? null;
      a[k] = patch[k];
    }
  }
  return { before: b, after: a };
}
