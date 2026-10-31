import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { dateOnly, idParam, kobo, objectId, pagination } from '../utils/schemas.js';
import { reqContext } from '../services/audit.service.js';
import * as payers from '../services/payers.service.js';
import * as coverage from '../services/coverage.service.js';
import { listLedger, reconcilePayer } from '../services/ledger.service.js';

const router = Router();
router.use(authenticate());

const contact = z.object({ name: z.string().max(120).optional(), email: z.string().email().optional(), phone: z.string().max(20).optional() });
const guarantor = z.object({ name: z.string().trim().min(2).max(120), phone: z.string().trim().min(7).max(20), idRef: z.string().max(60).optional() });
const billingCycle = z.enum(['weekly', 'monthly', 'quarterly']);
const contract = z.object({
  startsAt: dateOnly,
  endsAt: dateOnly,
  coveredServices: z.array(z.string().max(60)).max(200).default([]),
  excludedServices: z.array(z.string().max(60)).max(200).default([]),
}).refine((c) => c.endsAt > c.startsAt, { message: 'endsAt must be after startsAt', path: ['endsAt'] });

const createBody = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('corporate'),
    name: z.string().trim().min(2).max(160),
    billingContact: contact.extend({ name: z.string().min(2).max(120), email: z.string().email() }),
    creditLimitKobo: kobo.min(0),
    paymentTermsDays: z.number().int().min(0).max(365),
    billingCycle: billingCycle.default('monthly'),
    contract,
    tariffId: objectId.optional(),
  }),
  z.object({
    type: z.literal('family'),
    holderPatientId: objectId,
    name: z.string().trim().min(2).max(160).optional(),
    mode: z.enum(['credit', 'prepaid']).default('credit'),
    creditLimitKobo: kobo.min(0).default(0),
    paymentTermsDays: z.number().int().min(0).max(365).optional(),
    billingCycle: billingCycle.optional(),
    guarantor: guarantor.optional(),
    billingContact: contact.optional(),
  }),
]);

router.post(
  '/',
  requirePermission('payers:create'),
  validate({ body: createBody }),
  asyncHandler(async (req, res) => res.status(201).json(await payers.createPayer(req.body, reqContext(req))))
);

router.get(
  '/',
  requirePermission('payers:read'),
  validate({
    query: pagination.extend({
      type: z.enum(['corporate', 'family', 'individual']).optional(),
      status: z.enum(['active', 'suspended', 'closed']).optional(),
      q: z.string().trim().min(1).max(80).optional(),
    }),
  }),
  asyncHandler(async (req, res) => res.json(await payers.listPayers(req.query)))
);

router.get(
  '/:id',
  requirePermission('payers:read'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => res.json(await payers.getPayer(req.params.id)))
);

router.patch(
  '/:id',
  requirePermission('payers:update'),
  validate({
    params: idParam,
    body: z.object({
      name: z.string().trim().min(2).max(160),
      status: z.enum(['active', 'suspended', 'closed']),
      billingContact: contact,
      creditLimitKobo: kobo.min(0),
      paymentTermsDays: z.number().int().min(0).max(365),
      billingCycle,
      guarantor,
      contract,
      tariffId: objectId,
    }).partial().refine((b) => Object.keys(b).length > 0, 'Nothing to update'),
  }),
  asyncHandler(async (req, res) => res.json(await payers.updatePayer(req.params.id, req.body, reqContext(req))))
);

// ---- coverage under a payer ----
router.post(
  '/:id/coverages',
  requirePermission('coverages:manage'),
  validate({
    params: idParam,
    body: z.object({
      patientId: objectId,
      relationship: z.enum(['employee', 'dependant', 'member']),
      employeeRef: z.string().max(60).optional(),
      memberLimitKobo: kobo.min(0).nullable().optional(),
      validFrom: dateOnly.optional(),
      validTo: dateOnly.nullable().optional(),
    }),
  }),
  asyncHandler(async (req, res) => res.status(201).json(await coverage.addCoverage(req.params.id, req.body, reqContext(req))))
);

router.get(
  '/:id/coverages',
  requirePermission('coverages:read'),
  validate({ params: idParam, query: z.object({ status: z.enum(['active', 'inactive', 'suspended']).optional() }) }),
  asyncHandler(async (req, res) => res.json(await coverage.listPayerCoverages(req.params.id, req.query)))
);

// ---- ledger ----
router.get(
  '/:id/ledger',
  requirePermission('ledger:read'),
  validate({
    params: idParam,
    query: pagination.extend({ type: z.enum(['charge', 'payment', 'refund', 'adjustment', 'writeoff', 'reversal']).optional() }),
  }),
  asyncHandler(async (req, res) => res.json(await listLedger(req.params.id, req.query)))
);

router.get(
  '/:id/reconcile',
  requirePermission('ledger:reconcile'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => res.json(await reconcilePayer(req.params.id)))
);

export default router;
