import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { idParam, objectId, pagination } from '../utils/schemas.js';
import { idempotencyKeyOf } from '../utils/idempotency.js';
import { reqContext } from '../services/audit.service.js';
import * as encounters from '../services/encounters.service.js';
import * as charges from '../services/charges.service.js';
import { invoiceEncounter } from '../services/invoices.service.js';

const router = Router();
router.use(authenticate());
const reason = z.string().trim().min(5).max(200);

router.post('/', requirePermission('encounters:create'),
  validate({ body: z.object({
    patientId: objectId,
    type: z.enum(['outpatient', 'inpatient', 'emergency']).default('outpatient'),
    payerId: objectId.optional(), // omit for walk-in / self-pay
    department: z.string().trim().max(60).optional(),
    allowSecondOpen: z.boolean().optional(),
  }) }),
  asyncHandler(async (req, res) => res.status(201).json(await encounters.openEncounter(req.body, reqContext(req)))));

router.get('/', requirePermission('encounters:read'),
  validate({ query: pagination.extend({
    status: z.enum(['open', 'closed', 'cancelled']).optional(), type: z.enum(['outpatient', 'inpatient', 'emergency']).optional(),
    patientId: objectId.optional(), payerId: objectId.optional(),
  }) }),
  asyncHandler(async (req, res) => res.json(await encounters.listEncounters(req.query))));

router.get('/:id', requirePermission('encounters:read'), validate({ params: idParam }),
  asyncHandler(async (req, res) => res.json(await encounters.getEncounterDetail(req.params.id))));

// ---- charge capture (departments post services here) ----
router.post('/:id/charges', requirePermission('charges:create'),
  validate({ params: idParam, body: z.object({
    serviceId: objectId,
    qty: z.number().int().min(1).max(1000).default(1),
    payerId: objectId.optional(), // e.g. the patient's own payer for a service their company plan excludes
    overrideLimit: z.boolean().default(false),
    overrideReason: reason.optional(),
    idempotencyKey: z.string().optional(),
  }) }),
  asyncHandler(async (req, res) => {
    const { charge, charges: all, duplicate } = await charges.captureCharge(
      { ...req.body, encounterId: req.params.id, idempotencyKey: idempotencyKeyOf(req) }, reqContext(req));
    // Top level is the main charge; "charges" lists every share when a co-payment split it in two.
    res.status(duplicate ? 200 : 201).json({ ...charge, charges: all, duplicate });
  }));

router.get('/:id/charges', requirePermission('charges:read'), validate({ params: idParam }),
  asyncHandler(async (req, res) => res.json(await charges.listCharges(req.params.id))));

// ---- billing actions ----
router.post('/:id/invoices', requirePermission('invoices:create'),
  validate({ params: idParam, body: z.object({ payerId: objectId.optional() }) }),
  asyncHandler(async (req, res) => {
    const issued = await invoiceEncounter(req.params.id, { payerId: req.body.payerId }, reqContext(req));
    res.status(issued.length ? 201 : 200).json({ items: issued });
  }));

router.post('/:id/close', requirePermission('encounters:update'),
  validate({ params: idParam, body: z.object({ overrideReason: reason.optional() }) }),
  asyncHandler(async (req, res) => res.json(await encounters.closeEncounter(req.params.id, req.body, reqContext(req)))));

router.post('/:id/cancel', requirePermission('encounters:update'),
  validate({ params: idParam, body: z.object({ reason }) }),
  asyncHandler(async (req, res) => res.json(await encounters.cancelEncounter(req.params.id, req.body.reason, reqContext(req)))));

router.post('/:id/reassign-payer', requirePermission('encounters:update'),
  validate({ params: idParam, body: z.object({ payerId: objectId, reason }) }),
  asyncHandler(async (req, res) => res.json(await encounters.reassignEncounterPayer(req.params.id, req.body, reqContext(req)))));

export default router;
