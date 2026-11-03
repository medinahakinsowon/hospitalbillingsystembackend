import { generateDueInvoices } from './billing-cycle.service.js';
import { reconcilePendingPayments } from './payments.service.js';
import { processOverdue, queueLowBalanceAlerts } from './overdue.service.js';
import { dispatchNotifications } from './notifications.service.js';

/**
 * Everything that should happen once a day, in a sensible order. One failing step never stops the others,
 * and no new step starts after ~40 seconds (serverless time limits), so a slow day simply continues tomorrow.
 */
export async function runDailyJobs() {
  const steps = [
    ['invoices', () => generateDueInvoices()],
    ['payments', () => reconcilePendingPayments()],
    ['overdue', () => processOverdue()],
    ['lowBalance', () => queueLowBalanceAlerts()],
    ['notifications', () => dispatchNotifications()], // last, so reminders queued above go out the same run
  ];
  const started = Date.now();
  const results = {};
  for (const [name, fn] of steps) {
    if (Date.now() - started > 40_000) { results[name] = { skipped: 'time budget used up' }; continue; }
    try { results[name] = await fn(); } catch (err) { results[name] = { error: err.code || err.name }; }
  }
  return { ranAt: new Date(), seconds: Math.round((Date.now() - started) / 100) / 10, results };
}
