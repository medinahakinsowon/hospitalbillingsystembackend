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
import { invoicePayerPeriod } from '../services/billing-cycle.service.js';
import { getAccountStatement, getPayerSummary } from '../services/statements.service.js';
import { streamAccountStatementPdf } from '../services/pdf.service.js';

const router = Router();
router.use(authenticate());

// Corporate contracts ending soon (or already ended but still active). Must be declared before '/:id'.
router.get('/expiring', requirePermission('payers:read'),
  validate({ query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }) }),
  asyncHandler(async (req, res) => res.json({ items: await payers.listExpiringContracts(req.query) })));

const contact = z.object({ name: z.string().max(120).optional(), email: z.string().email().optional(), phone: z.string().max(20).optional() });
const guarantor = z.object({ name: z.string().trim().min(2).max(120), phone: z.string().trim().min(7).max(20), idRef: z.string().max(60).optional() });
const billingCycle = z.enum(['weekly', 'monthly', 'quarterly']);
// Patient pays this % of each covered service; empty appliesTo = all services (otherwise service codes, categories or departments).
const copay = z.object({ patientSharePercent: z.number().int().min(0).max(100), appliesTo: z.array(z.string().trim().min(1).max(60)).max(100).default([]) });
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
    copay: copay.optional(),
    authorizationThresholdKobo: kobo.min(0).optional(),
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
    maxMembers: z.number().int().min(2).max(50).optional(),
    lowBalanceThresholdKobo: kobo.min(0).optional(),
    copay: copay.optional(),
    authorizationThresholdKobo: kobo.min(0).optional(),
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
      maxMembers: z.number().int().min(2).max(50),
      lowBalanceThresholdKobo: kobo.min(0),
      copay,
      authorizationThresholdKobo: kobo.min(0),
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
  validate({ params: idParam, query: pagination.extend({ status: z.enum(['active', 'inactive', 'suspended']).optional() }) }),
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

// ---- Phase 3: members in bulk, contracts, card modes, periodic invoices, statements ----
router.post('/:id/coverages/bulk', requirePermission('coverages:manage'),
  validate({ params: idParam, body: z.object({
    members: z.array(z.object({
      hospitalNumber: z.string().trim().min(3).max(20),
      relationship: z.enum(['employee', 'dependant', 'member']),
      employeeRef: z.string().max(60).optional(),
      memberLimitKobo: kobo.min(0).nullable().optional(),
      validFrom: dateOnly.optional(),
      validTo: dateOnly.nullable().optional(),
    })).min(1).max(500),
  }) }),
  asyncHandler(async (req, res) => res.json(await coverage.bulkAddCoverage(req.params.id, req.body.members, reqContext(req)))));

router.get('/:id/summary', requirePermission('payers:read'), validate({ params: idParam }),
  asyncHandler(async (req, res) => res.json(await getPayerSummary(req.params.id))));

router.post('/:id/contract/renew', requirePermission('payers:update'),
  validate({ params: idParam, body: z.object({
    endsAt: dateOnly, creditLimitKobo: kobo.min(0).optional(), tariffId: objectId.optional(),
    reason: z.string().trim().min(5).max(200),
  }) }),
  asyncHandler(async (req, res) => res.json(await payers.renewContract(req.params.id, req.body, reqContext(req)))));

router.post('/:id/change-mode', requirePermission('payers:update'),
  validate({ params: idParam, body: z.object({
    mode: z.enum(['credit', 'prepaid']),
    creditLimitKobo: kobo.min(1).optional(),
    guarantor: guarantor.optional(),
    carryOverDeposit: z.boolean().default(false),
    reason: z.string().trim().min(5).max(200),
  }) }),
  asyncHandler(async (req, res) => res.json(await payers.changeFamilyCardMode(req.params.id, req.body, reqContext(req)))));

// Invoice a corporate payer's or credit card's uninvoiced charges now (the scheduled job does this automatically each cycle).
router.post('/:id/invoices', requirePermission('invoices:generate'),
  validate({ params: idParam, body: z.object({ periodStart: z.coerce.date().optional(), periodEnd: z.coerce.date().optional() }) }),
  asyncHandler(async (req, res) => {
    const r = await invoicePayerPeriod(req.params.id, req.body, reqContext(req));
    res.status(r.status === 'invoiced' ? 201 : 200).json(r);
  }));

const statementQuery = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() });
router.get('/:id/statement', requirePermission('ledger:read'),
  validate({ params: idParam, query: statementQuery.extend({ limit: z.coerce.number().int().min(1).max(2000).default(500) }) }),
  asyncHandler(async (req, res) => res.json(await getAccountStatement(req.params.id, req.query))));

router.get('/:id/statement/pdf', requirePermission('ledger:read'),
  validate({ params: idParam, query: statementQuery }),
  asyncHandler(async (req, res) => streamAccountStatementPdf(await getAccountStatement(req.params.id, { ...req.query, limit: 2000 }), res)));

export default router;
