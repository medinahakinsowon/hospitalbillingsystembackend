import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { idParam, kobo, objectId, pagination } from '../utils/schemas.js';
import { reqContext } from '../services/audit.service.js';
import * as auth from '../services/authorizations.service.js';

const router = Router();
router.use(authenticate());
const note = z.string().trim().max(300).optional();

router.post('/', requirePermission('authorizations:request'),
  validate({ body: z.object({
    payerId: objectId, patientId: objectId, serviceId: objectId.optional(), encounterId: objectId.optional(),
    requestedAmountKobo: kobo.min(1), description: z.string().trim().max(200).optional(),
  }) }),
  asyncHandler(async (req, res) => res.status(201).json(await auth.requestAuthorization(req.body, reqContext(req)))));

router.get('/', requirePermission('authorizations:read'),
  validate({ query: pagination.extend({
    payerId: objectId.optional(), patientId: objectId.optional(), status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(),
  }) }),
  asyncHandler(async (req, res) => res.json(await auth.listAuthorizations(req.query))));

router.get('/:id', requirePermission('authorizations:read'), validate({ params: idParam }),
  asyncHandler(async (req, res) => res.json(await auth.getAuthorization(req.params.id))));

// Approve = record the payer's own approval. externalRef is mandatory so every approval can be traced to the payer.
router.post('/:id/approve', requirePermission('authorizations:decide'),
  validate({ params: idParam, body: z.object({
    approvedAmountKobo: kobo.min(1), expiresAt: z.coerce.date(), externalRef: z.string().trim().min(3).max(80), note,
  }) }),
  asyncHandler(async (req, res) => res.json(await auth.decideAuthorization(req.params.id, { decision: 'approve', ...req.body }, reqContext(req)))));

router.post('/:id/reject', requirePermission('authorizations:decide'),
  validate({ params: idParam, body: z.object({ note }) }),
  asyncHandler(async (req, res) => res.json(await auth.decideAuthorization(req.params.id, { decision: 'reject', note: req.body.note }, reqContext(req)))));

router.post('/:id/cancel', requirePermission('authorizations:request'),
  validate({ params: idParam, body: z.object({ reason: z.string().trim().min(5).max(200) }) }),
  asyncHandler(async (req, res) => res.json(await auth.cancelAuthorization(req.params.id, req.body.reason, reqContext(req)))));

export default router;
