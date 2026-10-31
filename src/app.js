import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { env } from './config/env.js';
import { connectDB } from './config/db.js';
import { asyncHandler } from './utils/asyncHandler.js';
import { AppError } from './utils/AppError.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import routes from './routes.js';
import webhooks from './modules/webhooks.routes.js';

const app = express();
app.set('trust proxy', 1); // Vercel / reverse proxy: use the real client IP
app.disable('x-powered-by');

app.use(helmet());
app.use(
  cors({
    origin(origin, cb) {
      // Allow non-browser clients (no Origin header) and the configured frontend origins only.
      if (!origin || env.corsOrigins.includes(origin)) return cb(null, true);
      cb(new AppError(403, 'CORS_BLOCKED', 'Origin not allowed'));
    },
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    maxAge: 600,
  })
);
// Keep the raw bytes for webhooks: signature verification must use the exact body Paystack sent.
app.use(express.json({
  limit: '100kb',
  verify(req, res, buf) {
    if (req.originalUrl.startsWith('/api/v1/webhooks/')) req.rawBody = buf;
  },
}));
app.use(rateLimit({
  windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false,
  skip: (req) => req.originalUrl.startsWith('/api/v1/webhooks/'), // signature-protected; must never be throttled
}));

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.use('/api/v1/webhooks', webhooks); // verifies its signature before connecting to the database
app.use('/api/v1', asyncHandler(async (req, res, next) => { await connectDB(); next(); }), routes);

app.use(notFound);
app.use(errorHandler);

export default app;
