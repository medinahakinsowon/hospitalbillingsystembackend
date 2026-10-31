import crypto from 'node:crypto';
import { Router } from 'express';
import { env } from '../config/env.js';
import { AppError } from '../utils/AppError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { reconcilePendingPayments } from '../services/payments.service.js';
import { generateDueInvoices } from '../services/billing-cycle.service.js';

const router = Router();

// Scheduled job endpoint (Vercel Cron or any scheduler). Protected by CRON_SECRET as a Bearer token.
function requireCronSecret(req, res, next) {
  if (!env.CRON_SECRET) return next(new AppError(503, 'JOBS_DISABLED', 'Set CRON_SECRET to enable scheduled jobs'));
  const given = Buffer.from((req.get('authorization') || '').replace(/^Bearer /, ''));
  const wanted = Buffer.from(env.CRON_SECRET);
  if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) {
    return next(new AppError(401, 'UNAUTHENTICATED', 'Invalid job credentials'));
  }
  next();
}

router.get('/generate-invoices', requireCronSecret, asyncHandler(async (req, res) => res.json(await generateDueInvoices())));
router.get('/reconcile-payments', requireCronSecret, asyncHandler(async (req, res) => res.json(await reconcilePendingPayments())));

export default router;
