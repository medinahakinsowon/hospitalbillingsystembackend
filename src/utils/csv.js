// CSV output safe to open in Excel. Text that starts with = + - @ could be run as a formula by a spreadsheet
// (a patient named "=HYPERLINK(...)" would be an attack), so such text is prefixed with an apostrophe.
const FORMULA_START = /^[=+\-@\t\r]/;

/** "1234.50" from integer kobo (no thousands separators, so spreadsheets read it as a number). */
export function koboPlain(kobo) {
  const neg = kobo < 0;
  const abs = Math.abs(kobo);
  return `${neg ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function cell(value, type) {
  if (value === null || value === undefined) return '';
  let s;
  if (type === 'kobo') s = koboPlain(value);
  else if (type === 'number') s = String(value);
  else if (value instanceof Date) s = value.toISOString();
  else {
    s = String(value);
    if (FORMULA_START.test(s)) s = `'${s}`;
  }
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** columns: [{ key, header, type?: 'text' | 'number' | 'kobo' }]. Includes a BOM so Excel reads UTF-8 names correctly. */
export function toCsv(columns, rows) {
  const lines = [columns.map((c) => cell(c.header, 'text')).join(',')];
  for (const r of rows) lines.push(columns.map((c) => cell(r[c.key], c.type)).join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
