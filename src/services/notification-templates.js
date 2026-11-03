import { env } from '../config/env.js';
import { formatMoney } from '../utils/money.js';

// Messages state amounts and document numbers only: no diagnoses, services or other clinical detail.
const date = (d) => new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Africa/Lagos' });
const sign = () => env.HOSPITAL_NAME;

export const templates = {
  payment_received: ({ payerName, receiptNo, amountKobo, method }) => ({
    subject: `Payment received (${receiptNo})`,
    body: `${sign()}: we received ${formatMoney(amountKobo)} (${method}) for ${payerName}. Receipt ${receiptNo}. Thank you.`,
  }),
  invoice_issued: ({ payerName, invoiceNo, totalKobo, dueAt }) => ({
    subject: `Invoice ${invoiceNo}`,
    body: `${sign()}: invoice ${invoiceNo} for ${payerName} is ${formatMoney(totalKobo)}, due ${date(dueAt)}. Please quote the invoice number with your payment.`,
  }),
  overdue_reminder: ({ payerName, invoiceNo, balanceKobo, daysOverdue }) => ({
    subject: `Payment reminder: invoice ${invoiceNo}`,
    body: `${sign()}: invoice ${invoiceNo} for ${payerName} has ${formatMoney(balanceKobo)} unpaid and is ${daysOverdue} day${daysOverdue === 1 ? '' : 's'} overdue. Please arrange payment or contact our billing office.`,
  }),
  low_balance: ({ payerName, availableKobo }) => ({
    subject: 'Your card balance is low',
    body: `${sign()}: the prepaid balance on ${payerName} is ${formatMoney(Math.max(0, availableKobo))}. Please top up to avoid interruption to care.`,
  }),
};
