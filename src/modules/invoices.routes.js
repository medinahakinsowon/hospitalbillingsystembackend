import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { idParam, objectId, pagination } from '../utils/schemas.js';
import { getInvoice, listInvoices } from '../services/invoices.service.js';
import { streamInvoicePdf } from '../services/pdf.service.js';

const router = Router();
router.use(authenticate(), requirePermission('invoices:read'));

router.get('/',
  validate({ query: pagination.extend({
    payerId: objectId.optional(), patientId: objectId.optional(), encounterId: objectId.optional(),
    status: z.enum(['issued', 'partial', 'paid', 'void']).optional(),
    overdue: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  }) }),
  asyncHandler(async (req, res) => res.json(await listInvoices(req.query))));

router.get('/:id', validate({ params: idParam }), asyncHandler(async (req, res) => res.json(await getInvoice(req.params.id))));
router.get('/:id/pdf', validate({ params: idParam }), asyncHandler(async (req, res) => streamInvoicePdf(req.params.id, res)));

export default router;
