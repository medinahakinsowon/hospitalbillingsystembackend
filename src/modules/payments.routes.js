import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { idParam, kobo, objectId, pagination } from '../utils/schemas.js';
import { idempotencyKeyOf } from '../utils/idempotency.js';
import { reqContext } from '../services/audit.service.js';
import * as payments from '../services/payments.service.js';
import { streamReceiptPdf } from '../services/pdf.service.js';

const router = Router();
router.use(authenticate());

const target = {
  payerId: objectId,
  amountKobo: kobo.min(1),
  invoiceId: objectId.optional(),
  encounterId: objectId.optional(),
};
const oneTarget = (b) => !(b.invoiceId && b.encounterId);
const oneTargetMsg = { message: 'Provide invoiceId or encounterId, not both', path: ['invoiceId'] };

// Cash, POS or bank transfer received by a cashier
router.post('/', requirePermission('payments:create'),
  validate({ body: z.object({
    ...target, method: z.enum(['cash', 'pos', 'transfer']),
    externalRef: z.string().trim().max(80).optional(), idempotencyKey: z.string().optional(),
    autoAllocate: z.boolean().default(false), // lump sum: clear the payer's oldest open invoices first
  }).refine(oneTarget, oneTargetMsg) }),
  asyncHandler(async (req, res) => {
    const { payment, duplicate } = await payments.recordManualPayment({ ...req.body, idempotencyKey: idempotencyKeyOf(req) }, reqContext(req));
    res.status(duplicate ? 200 : 201).json({ ...payment, duplicate });
  }));

// Start an online payment; send the customer to authorizationUrl
router.post('/paystack/initiate', requirePermission('payments:create'),
  validate({ body: z.object({ ...target, email: z.string().email().optional(), autoAllocate: z.boolean().default(false) }).refine(oneTarget, oneTargetMsg) }),
  asyncHandler(async (req, res) => res.status(201).json(await payments.initiatePaystackPayment(req.body, reqContext(req)))));

router.get('/', requirePermission('payments:read'),
  validate({ query: pagination.extend({
    payerId: objectId.optional(), patientId: objectId.optional(),
    status: z.enum(['pending', 'success', 'failed', 'abandoned', 'flagged']).optional(),
    method: z.enum(['cash', 'pos', 'transfer', 'paystack']).optional(),
  }) }),
  asyncHandler(async (req, res) => res.json(await payments.listPayments(req.query))));

router.get('/:id', requirePermission('payments:read'), validate({ params: idParam }),
  asyncHandler(async (req, res) => res.json(await payments.getPayment(req.params.id))));

// Ask Paystack about this payment now (use when the customer returns from checkout)
router.post('/:id/verify', requirePermission('payments:verify'), validate({ params: idParam }),
  asyncHandler(async (req, res) => res.json(await payments.verifyPaymentById(req.params.id))));

// Apply credit already sitting on a successful payment (deposit, lump sum, overpayment) to open invoices
router.post('/:id/allocate', requirePermission('payments:create'),
  validate({ params: idParam, body: z.object({ invoiceId: objectId.optional() }) }),
  asyncHandler(async (req, res) => res.json(await payments.allocateExistingCredit(req.params.id, req.body, reqContext(req)))));

router.get('/:id/receipt', requirePermission('payments:read'), validate({ params: idParam }),
  asyncHandler(async (req, res) => streamReceiptPdf(req.params.id, res)));

export default router;
