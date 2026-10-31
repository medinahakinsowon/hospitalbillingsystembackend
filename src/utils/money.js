import { AppError } from './AppError.js';

// All money in this system is an integer number of kobo (1 naira = 100 kobo).
export function assertKobo(n, label = 'amount') {
  if (!Number.isSafeInteger(n)) {
    throw new AppError(400, 'INVALID_AMOUNT', `${label} must be an integer number of kobo`);
  }
  return n;
}
export const nairaToKobo = (naira) => Math.round(naira * 100);
export const formatNaira = (kobo) =>
  new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN' }).format(kobo / 100);

/** "NGN 1,234.50" from integer kobo (PDF-safe: built-in fonts lack the naira sign). */
export function formatMoney(kobo) {
  const neg = kobo < 0;
  const abs = Math.abs(kobo);
  const naira = Math.floor(abs / 100).toLocaleString('en-US');
  return `${neg ? '-' : ''}NGN ${naira}.${String(abs % 100).padStart(2, '0')}`;
}
