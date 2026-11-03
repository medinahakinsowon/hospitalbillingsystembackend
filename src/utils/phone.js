// Normalise Nigerian phone numbers to the local 11-digit form (0XXXXXXXXXX)
// so duplicate detection and search are consistent.
export function normalizePhone(input) {
  if (!input) return input;
  let d = String(input).replace(/\D/g, '');
  if (d.startsWith('234') && d.length === 13) d = '0' + d.slice(3);
  else if (d.length === 10 && !d.startsWith('0')) d = '0' + d;
  return d;
}

/** International form for SMS gateways: 08012345678 -> 2348012345678. Other numbers are returned as digits only. */
export function toInternationalNg(input) {
  const d = String(input ?? '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('0')) return `234${d.slice(1)}`;
  return d;
}
