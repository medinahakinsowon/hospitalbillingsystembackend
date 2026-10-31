import mongoose from 'mongoose';
import { appendOnly } from './appendOnly.js';
const { Schema } = mongoose;

const auditLogSchema = new Schema(
  {
    actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    actorRole: String,
    action: { type: String, required: true }, // e.g. patient.create, patient.view, auth.login.failed
    entity: { type: String, required: true },
    entityId: Schema.Types.ObjectId,
    before: Schema.Types.Mixed, // changed fields only
    after: Schema.Types.Mixed,
    meta: Schema.Types.Mixed,
    ip: String,
    userAgent: String,
    at: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

auditLogSchema.index({ entity: 1, entityId: 1, at: -1 });
auditLogSchema.index({ actorId: 1, at: -1 });
auditLogSchema.index({ action: 1, at: -1 });

appendOnly(auditLogSchema, 'AuditLog');
export const AuditLog = mongoose.model('AuditLog', auditLogSchema);
