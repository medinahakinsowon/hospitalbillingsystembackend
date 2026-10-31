import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { idParam, kobo, objectId, pagination } from '../utils/schemas.js';
import { Payer } from '../models/Payer.js';
import { Service } from '../models/Service.js';
import { AppError } from '../utils/AppError.js';
import { reqContext } from '../services/audit.service.js';
import * as catalog from '../services/catalog.service.js';

const router = Router();
router.use(authenticate());

// Preview the price a payer would be charged for a service (shows which tariff supplied it).
router.get('/price-check', requirePermission('tariffs:read'),
  validate({ query: z.object({ payerId: objectId, serviceId: objectId }) }),
  asyncHandler(async (req, res) => {
    const [payer, service] = await Promise.all([Payer.findById(req.query.payerId).lean(), Service.findById(req.query.serviceId).lean()]);
    if (!payer) throw new AppError(404, 'PAYER_NOT_FOUND', 'Payer not found');
    if (!service) throw new AppError(404, 'SERVICE_NOT_FOUND', 'Service not found');
    const price = await catalog.resolvePrice(payer, service._id);
    const cover = catalog.checkServiceCoverage(payer, service);
    res.json({ service: { id: service._id, code: service.code, name: service.name }, ...price, covered: cover.covered, coverageReason: cover.reason });
  }));

router.post('/', requirePermission('tariffs:manage'),
  validate({ body: z.object({
    code: z.string().trim().min(2).max(30).regex(/^[A-Za-z0-9._-]+$/),
    name: z.string().trim().min(2).max(120),
    description: z.string().trim().max(300).optional(),
    isDefault: z.boolean().default(false),
  }) }),
  asyncHandler(async (req, res) => res.status(201).json(await catalog.createTariff(req.body, reqContext(req)))));

router.get('/', requirePermission('tariffs:read'), asyncHandler(async (req, res) => res.json(await catalog.listTariffs())));

router.patch('/:id', requirePermission('tariffs:manage'),
  validate({ params: idParam, body: z.object({
    name: z.string().trim().min(2).max(120), description: z.string().trim().max(300),
    status: z.enum(['active', 'archived']), isDefault: z.boolean(),
  }).partial().refine((b) => Object.keys(b).length > 0, 'Nothing to update') }),
  asyncHandler(async (req, res) => res.json(await catalog.updateTariff(req.params.id, req.body, reqContext(req)))));

router.get('/:id/items', requirePermission('tariffs:read'),
  validate({ params: idParam, query: pagination.extend({ q: z.string().trim().min(1).max(80).optional(), at: z.coerce.date().optional() }) }),
  asyncHandler(async (req, res) => res.json(await catalog.listTariffItems(req.params.id, req.query))));

router.put('/:id/prices', requirePermission('tariffs:manage'),
  validate({ params: idParam, body: z.object({
    items: z.array(z.object({ serviceId: objectId, priceKobo: kobo.min(0), effectiveFrom: z.coerce.date().optional() })).min(1).max(200),
  }) }),
  asyncHandler(async (req, res) => res.json({ results: await catalog.setTariffPrices(req.params.id, req.body.items, reqContext(req)) })));

export default router;
