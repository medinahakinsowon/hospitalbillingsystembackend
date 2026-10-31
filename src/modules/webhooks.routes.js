import { Router } from 'express';
import { connectDB } from '../config/db.js';
import { AppError } from '../utils/AppError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { verifySignature } from '../services/paystack.service.js';
import { handlePaystackWebhook } from '../services/payments.service.js';

const router = Router();

// No login here: authenticity comes from the HMAC signature over the raw body.
// The signature is checked BEFORE touching the database, so forged calls cost almost nothing.
router.post('/paystack', asyncHandler(async (req, res) => {
  if (!verifySignature(req.rawBody, req.get('x-paystack-signature'))) {
    throw new AppError(401, 'INVALID_SIGNATURE', 'Invalid signature');
  }
  await connectDB();
  const result = await handlePaystackWebhook(req.rawBody);
  res.status(200).json({ received: true, ...result }); // any 2xx tells Paystack to stop retrying
}));

export default router;
