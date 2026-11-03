import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { objectId } from '../utils/schemas.js';
import { toCsv } from '../utils/csv.js';
import { recordAudit, reqContext } from '../services/audit.service.js';
import * as reports from '../services/reports.service.js';

const router = Router();
router.use(authenticate(), requirePermission('reports:read'));

const range = { from: z.coerce.date().optional(), to: z.coerce.date().optional() };
const format = { format: z.enum(['json', 'csv']).default('json') };

/** JSON by default; ?format=csv downloads a spreadsheet-safe file. Exports are audited because data is leaving the system. */
function respond(name) {
  return async (req, res) => {
    const { format: fmt, ...params } = req.query;
    const report = await reports[name](params);
    if (fmt !== 'csv') return res.json(report);
    await recordAudit(reqContext(req), { action: 'report.export', entity: 'Report', meta: { report: report.meta.report, params, rows: report.rows.length } });
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${report.meta.report}-${stamp}.csv"`);
    res.setHeader('Cache-Control', 'private, no-store');
    return res.send(toCsv(report.columns, report.rows));
  };
}

router.get('/aging', validate({ query: z.object({ ...format, payerType: z.enum(['corporate', 'family', 'individual']).optional(), payerId: objectId.optional() }) }), asyncHandler(respond('agingReport')));
router.get('/revenue-by-department', validate({ query: z.object({ ...range, ...format, payerId: objectId.optional(), payerType: z.enum(['corporate', 'family', 'individual']).optional() }) }), asyncHandler(respond('revenueByDepartment')));
router.get('/collections-by-cashier', validate({ query: z.object({ ...range, ...format }) }), asyncHandler(respond('collectionsByCashier')));
router.get('/card-usage', validate({ query: z.object({ ...range, ...format, payerId: objectId.optional() }) }), asyncHandler(respond('cardUsageReport')));

export default router;
