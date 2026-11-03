import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireAnyPermission, requirePermission } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { idParam, kobo, objectId, pagination } from '../utils/schemas.js';
import { reqContext } from '../services/audit.service.js';
import * as sessions from '../services/cashier-sessions.service.js';

const router = Router();
router.use(authenticate());
// Cashiers hold sessions:manage; finance managers hold sessions:review. Each route says who may use it.
const anySession = requireAnyPermission('sessions:manage', 'sessions:review');
const note = z.string().trim().max(300).optional();

router.post('/open', requirePermission('sessions:manage'), validate({ body: z.object({ openingFloatKobo: kobo.min(0).default(0) }) }),
  asyncHandler(async (req, res) => res.status(201).json(await sessions.openSession(req.body, reqContext(req)))));

router.get('/current', requirePermission('sessions:manage'), asyncHandler(async (req, res) => res.json(await sessions.getCurrentSession(reqContext(req)))));

// Count first, then submit: the expected amounts are revealed only after you close (blind count).
router.post('/:id/close', anySession,
  validate({ params: idParam, body: z.object({ countedCashKobo: kobo.min(0), countedPosKobo: kobo.min(0), countedTransferKobo: kobo.min(0), note }) }),
  asyncHandler(async (req, res) => res.json(await sessions.closeSession(req.params.id, req.body, reqContext(req)))));

router.post('/:id/review', requirePermission('sessions:review'), validate({ params: idParam, body: z.object({ note }) }),
  asyncHandler(async (req, res) => res.json(await sessions.reviewSession(req.params.id, req.body, reqContext(req)))));

router.get('/', anySession,
  validate({ query: pagination.extend({
    status: z.enum(['open', 'closed', 'reviewed']).optional(), cashierId: objectId.optional(),
    flagged: z.enum(['true', 'false']).transform((v) => v === 'true').optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional(),
  }) }),
  asyncHandler(async (req, res) => res.json(await sessions.listSessions(req.query, reqContext(req)))));

router.get('/:id', anySession, validate({ params: idParam }), asyncHandler(async (req, res) => res.json(await sessions.getSession(req.params.id, reqContext(req)))));

export default router;
