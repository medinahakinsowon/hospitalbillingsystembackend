import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { idParam, objectId, pagination } from '../utils/schemas.js';
import { reqContext } from '../services/audit.service.js';
import * as notifications from '../services/notifications.service.js';

const router = Router();
router.use(authenticate());

router.get('/', requirePermission('notifications:read'),
  validate({ query: pagination.extend({
    status: z.enum(['queued', 'sending', 'sent', 'failed']).optional(), channel: z.enum(['email', 'sms']).optional(), payerId: objectId.optional(),
  }) }),
  asyncHandler(async (req, res) => res.json(await notifications.listNotifications(req.query))));

router.post('/:id/retry', requirePermission('notifications:manage'), validate({ params: idParam }),
  asyncHandler(async (req, res) => res.json(await notifications.retryNotification(req.params.id, reqContext(req)))));

export default router;
