import PDFDocument from 'pdfkit';
import { env } from '../config/env.js';
import { Invoice } from '../models/Invoice.js';
import { Payment } from '../models/Payment.js';
import { Payer } from '../models/Payer.js';
import { User } from '../models/User.js';
import { AppError } from '../utils/AppError.js';
import { formatMoney } from '../utils/money.js';

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Africa/Lagos' }) : '');
const fmtDateTime = (d) => (d ? new Date(d).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Lagos' }) : '');
const GREY = '#555555';
const LINE = '#cccccc';

function pipePdf(res, filename, build) {
  const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: filename, Producer: 'Hospital Billing' } });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}.pdf"`);
  res.setHeader('Cache-Control', 'private, no-store');
  doc.pipe(res);
  build(doc);
  doc.end();
}

function header(doc, title) {
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#000').text(env.HOSPITAL_NAME, 50, 50, { width: 300 });
  doc.font('Helvetica').fontSize(9).fillColor(GREY);
  if (env.HOSPITAL_ADDRESS) doc.text(env.HOSPITAL_ADDRESS, { width: 300 });
  if (env.HOSPITAL_PHONE) doc.text(env.HOSPITAL_PHONE, { width: 300 });
  doc.font('Helvetica-Bold').fontSize(title.length > 10 ? 15 : 22).fillColor('#000').text(title, 330, title.length > 10 ? 56 : 50, { width: 215, align: 'right' });
  doc.y = Math.max(doc.y, 100) + 10;
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor(LINE).stroke();
  doc.y += 12;
}

function kv(doc, x, y, label, value, width = 230) {
  doc.font('Helvetica').fontSize(8).fillColor(GREY).text(label.toUpperCase(), x, y, { width });
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#000').text(value || '-', x, doc.y, { width });
}

function totalsBlock(doc, y, inv) {
  if (y > 690) { doc.addPage(); y = 60; }
  y += 10;
  const row = (label, value, bold) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 10).fillColor('#000');
    doc.text(label, 340, y, { width: 100, align: 'right' });
    doc.text(value, 445, y, { width: 100, align: 'right' });
    y += bold ? 20 : 16;
  };
  row('Total', formatMoney(inv.totalKobo));
  if (inv.creditedKobo > 0) row('Credits & discounts', `-${formatMoney(inv.creditedKobo)}`);
  row('Paid', formatMoney(inv.paidKobo - (inv.creditedKobo || 0)));
  row('Balance due', formatMoney(inv.totalKobo - inv.paidKobo), true);
  doc.font('Helvetica').fontSize(8).fillColor(GREY).text('Thank you. Please quote the invoice number with any payment.', 50, Math.max(y + 30, 760), { width: 495, align: 'center' });
}

/** Single-visit invoice: one flat table. */
function visitTable(doc, inv) {
  const cols = { date: 50, desc: 115, qty: 360, unit: 400, amt: 475 };
  const head = (y) => {
    doc.rect(50, y - 4, 495, 18).fill('#f0f0f0');
    doc.fillColor('#000').font('Helvetica-Bold').fontSize(9);
    doc.text('Date', cols.date + 4, y, { width: 60 });
    doc.text('Description', cols.desc, y, { width: 240 });
    doc.text('Qty', cols.qty, y, { width: 35, align: 'right' });
    doc.text('Unit price', cols.unit, y, { width: 70, align: 'right' });
    doc.text('Amount', cols.amt, y, { width: 66, align: 'right' });
  };
  let y = doc.y + 4;
  head(y); y += 22;
  doc.font('Helvetica').fontSize(9);
  for (const l of inv.lines) {
    if (y > 730) { doc.addPage(); y = 60; head(y); y += 22; doc.font('Helvetica').fontSize(9); }
    const desc = `${l.description || ''}${l.credited ? ' (credited)' : ''}`;
    const h = Math.max(14, doc.heightOfString(desc, { width: 240 }) + 4);
    doc.fillColor('#000');
    doc.text(fmtDate(l.date), cols.date + 4, y, { width: 60 });
    doc.text(desc, cols.desc, y, { width: 240 });
    doc.text(String(l.qty), cols.qty, y, { width: 35, align: 'right' });
    doc.text(formatMoney(l.unitPriceKobo), cols.unit - 10, y, { width: 80, align: 'right' });
    doc.text(formatMoney(l.totalKobo), cols.amt - 10, y, { width: 76, align: 'right' });
    y += h;
    doc.moveTo(50, y - 2).lineTo(545, y - 2).strokeColor('#eeeeee').stroke();
  }
  return y;
}

/** Consolidated invoice / statement: treatments grouped per person with subtotals. */
function groupedTable(doc, inv) {
  const c = { date: 50, visit: 112, desc: 176, qty: 352, unit: 385, amt: 470 };
  const head = (y) => {
    doc.rect(50, y - 4, 495, 18).fill('#f0f0f0');
    doc.fillColor('#000').font('Helvetica-Bold').fontSize(8);
    doc.text('Date', c.date + 4, y, { width: 60 }); doc.text('Visit', c.visit, y, { width: 60 });
    doc.text('Description', c.desc, y, { width: 170 }); doc.text('Qty', c.qty, y, { width: 28, align: 'right' });
    doc.text('Unit price', c.unit, y, { width: 75, align: 'right' }); doc.text('Amount', c.amt, y, { width: 71, align: 'right' });
  };
  const groups = [];
  for (const l of inv.lines) {
    const key = String(l.patientId ?? l.patientName);
    let g = groups.find((x) => x.key === key);
    if (!g) { g = { key, name: l.patientName, hn: l.hospitalNumber, ref: l.employeeRef, lines: [] }; groups.push(g); }
    g.lines.push(l);
  }
  let y = doc.y + 4;
  head(y); y += 22;
  for (const g of groups) {
    if (y > 700) { doc.addPage(); y = 60; head(y); y += 22; }
    doc.rect(50, y - 3, 495, 16).fill('#e8eef5');
    doc.fillColor('#000').font('Helvetica-Bold').fontSize(9)
      .text(`${g.name}  (${g.hn || '-'})${g.ref ? `   Staff/ref: ${g.ref}` : ''}`, 54, y, { width: 480 });
    y += 18;
    doc.font('Helvetica').fontSize(8);
    for (const l of g.lines) {
      const desc = `${l.description || ''}${l.credited ? ' (credited)' : ''}`;
      const h = Math.max(13, doc.heightOfString(desc, { width: 170 }) + 3);
      if (y + h > 740) { doc.addPage(); y = 60; head(y); y += 22; doc.font('Helvetica').fontSize(8); }
      doc.fillColor('#000');
      doc.text(fmtDate(l.date), c.date + 4, y, { width: 60 });
      doc.text(l.encounterNo || '', c.visit, y, { width: 62 });
      doc.text(desc, c.desc, y, { width: 170 });
      doc.text(String(l.qty), c.qty, y, { width: 28, align: 'right' });
      doc.text(formatMoney(l.unitPriceKobo), c.unit - 5, y, { width: 80, align: 'right' });
      doc.text(formatMoney(l.totalKobo), c.amt - 5, y, { width: 76, align: 'right' });
      y += h;
    }
    const sub = g.lines.reduce((sum, l) => sum + l.totalKobo, 0);
    doc.font('Helvetica-Bold').fontSize(8).text(`Subtotal ${g.name}`, c.desc, y, { width: 200 });
    doc.text(formatMoney(sub), c.amt - 5, y, { width: 76, align: 'right' });
    y += 8;
    doc.moveTo(50, y + 6).lineTo(545, y + 6).strokeColor('#dddddd').stroke();
    y += 14;
  }
  return { y, people: groups.length };
}

export async function streamInvoicePdf(invoiceId, res) {
  const inv = await Invoice.findById(invoiceId).lean();
  if (!inv) throw new AppError(404, 'INVOICE_NOT_FOUND', 'Invoice not found');
  const payer = await Payer.findById(inv.payerId).select('billingContact').lean();
  const visit = inv.type === 'visit';
  const title = inv.type === 'statement' ? 'STATEMENT' : 'INVOICE';

  pipePdf(res, inv.invoiceNo, (doc) => {
    header(doc, title);
    const top = doc.y;
    kv(doc, 50, top, 'Billed to', inv.payerName);
    doc.font('Helvetica').fontSize(9).fillColor(GREY).text(`${inv.payerCode}${payer?.billingContact?.name ? ` | Attn: ${payer.billingContact.name}` : ''}`, 50, doc.y, { width: 230 });
    const leftEnd = doc.y;
    kv(doc, 320, top, 'Invoice no.', inv.invoiceNo, 225);
    kv(doc, 320, doc.y + 4, 'Issued / Due', `${fmtDate(inv.issuedAt)}  /  ${fmtDate(inv.dueAt)}`, 225);
    kv(doc, 320, doc.y + 4, 'Status', inv.status.toUpperCase(), 225);
    doc.y = Math.max(leftEnd, doc.y) + 14;

    if (visit && inv.patientName) {
      kv(doc, 50, doc.y, 'Patient', `${inv.patientName}  (${inv.hospitalNumber})`, 300);
      doc.font('Helvetica').fontSize(9).fillColor(GREY).text(`Visit ${inv.encounterNo || ''}`, 50, doc.y, { width: 300 });
      doc.y += 12;
    }
    if (!visit && inv.periodEnd) {
      const to = fmtDate(new Date(inv.periodEnd.getTime() - 1));
      kv(doc, 50, doc.y, 'Period', inv.periodStart ? `${fmtDate(inv.periodStart)} to ${to}` : `Up to ${to}`, 300);
      doc.y += 6;
    }

    let y;
    if (visit) {
      y = visitTable(doc, inv);
    } else {
      const g = groupedTable(doc, inv);
      y = g.y;
      doc.font('Helvetica').fontSize(8).fillColor(GREY).text(`${g.people} ${g.people === 1 ? 'person' : 'people'}, ${inv.lines.length} treatments`, 50, y);
      y += 12;
    }
    totalsBlock(doc, y, inv);
  });
}

/** Ledger statement for any payer (useful for prepaid cards, which have no invoices). */
export async function streamAccountStatementPdf(statement, res) {
  const { payer, from, to, openingKobo, closingKobo, entries, totals, truncated } = statement;
  const shown = entries.slice(0, 2000);
  pipePdf(res, `statement-${payer.code}`, (doc) => {
    header(doc, 'ACCOUNT STATEMENT');
    const top = doc.y;
    kv(doc, 50, top, 'Account', payer.name);
    doc.font('Helvetica').fontSize(9).fillColor(GREY).text(`${payer.code}${payer.mode ? ` | ${payer.mode} card` : ''}`, 50, doc.y, { width: 230 });
    const leftEnd = doc.y;
    kv(doc, 320, top, 'Period', `${fmtDate(from)} to ${fmtDate(new Date(to.getTime() - 1))}`, 225);
    kv(doc, 320, doc.y + 4, 'Opening / Closing', `${formatMoney(openingKobo)}  /  ${formatMoney(closingKobo)}`, 225);
    doc.y = Math.max(leftEnd, doc.y) + 12;
    doc.font('Helvetica').fontSize(8).fillColor(GREY).text('Positive balance = amount owed to the hospital. Negative balance = credit held for you.', 50, doc.y);
    doc.y += 14;

    const c = { date: 50, desc: 120, chg: 335, pay: 410, bal: 480 };
    const head = (y) => {
      doc.rect(50, y - 4, 495, 18).fill('#f0f0f0');
      doc.fillColor('#000').font('Helvetica-Bold').fontSize(8);
      doc.text('Date', c.date + 4, y, { width: 65 }); doc.text('Description', c.desc, y, { width: 210 });
      doc.text('Charges', c.chg, y, { width: 70, align: 'right' }); doc.text('Payments', c.pay, y, { width: 65, align: 'right' });
      doc.text('Balance', c.bal, y, { width: 61, align: 'right' });
    };
    let y = doc.y; head(y); y += 22;
    doc.font('Helvetica').fontSize(8);
    for (const e of shown) {
      const h = Math.max(13, doc.heightOfString(e.description || e.type, { width: 210 }) + 3);
      if (y + h > 740) { doc.addPage(); y = 60; head(y); y += 22; doc.font('Helvetica').fontSize(8); }
      doc.fillColor('#000');
      doc.text(fmtDate(e.at), c.date + 4, y, { width: 65 });
      doc.text(e.description || e.type, c.desc, y, { width: 210 });
      if (e.amountKobo > 0) doc.text(formatMoney(e.amountKobo), c.chg - 8, y, { width: 78, align: 'right' });
      else doc.text(formatMoney(-e.amountKobo), c.pay - 8, y, { width: 73, align: 'right' });
      doc.text(formatMoney(e.balanceAfterKobo), c.bal - 8, y, { width: 69, align: 'right' });
      y += h;
    }
    if (y > 700) { doc.addPage(); y = 60; }
    y += 10;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#000');
    doc.text(`Total charges ${formatMoney(totals.chargesKobo)}     Total payments ${formatMoney(totals.paymentsKobo)}     Closing balance ${formatMoney(closingKobo)}`, 50, y, { width: 495, align: 'right' });
    if (truncated || entries.length > shown.length) {
      doc.font('Helvetica').fontSize(8).fillColor(GREY).text('Only the first entries are shown. Choose a shorter period for the full list.', 50, y + 18, { width: 495 });
    }
  });
}

export async function streamReceiptPdf(paymentId, res) {
  const p = await Payment.findById(paymentId).lean();
  if (!p) throw new AppError(404, 'PAYMENT_NOT_FOUND', 'Payment not found');
  if (p.status !== 'success') throw new AppError(422, 'NO_RECEIPT', 'A receipt is only available for successful payments');
  const [payer, invoices, user] = await Promise.all([
    Payer.findById(p.payerId).select('name code').lean(),
    Invoice.find({ _id: { $in: p.allocations.map((a) => a.invoiceId) } }).select('invoiceNo').lean(),
    p.receivedBy ? User.findById(p.receivedBy).select('name').lean() : null,
  ]);
  const invNo = Object.fromEntries(invoices.map((i) => [String(i._id), i.invoiceNo]));
  const METHOD = { cash: 'Cash', pos: 'POS', transfer: 'Bank transfer', paystack: 'Paystack (online)' };

  pipePdf(res, p.receiptNo, (doc) => {
    header(doc, 'RECEIPT');
    const top = doc.y;
    kv(doc, 50, top, 'Received from', payer?.name);
    doc.font('Helvetica').fontSize(9).fillColor(GREY).text(payer?.code || '', 50, doc.y, { width: 230 });
    kv(doc, 320, top, 'Receipt no.', p.receiptNo, 225);
    kv(doc, 320, doc.y + 4, 'Date', fmtDateTime(p.completedAt), 225);
    kv(doc, 320, doc.y + 4, 'Method', METHOD[p.method] || p.method, 225);
    doc.y += 20;

    const boxY = doc.y;
    doc.rect(50, boxY, 495, 50).fill('#f0f0f0');
    doc.fillColor(GREY).font('Helvetica').fontSize(8).text('AMOUNT RECEIVED', 62, boxY + 8, { width: 200 });
    doc.fillColor('#000').font('Helvetica-Bold').fontSize(18).text(formatMoney(p.amountKobo), 62, boxY + 22, { width: 300 });
    doc.y = boxY + 66;

    doc.font('Helvetica-Bold').fontSize(10).fillColor('#000').text('Applied to', 50, doc.y);
    doc.font('Helvetica').fontSize(10);
    if (p.allocations.length) {
      for (const a of p.allocations) doc.text(`${invNo[String(a.invoiceId)] || 'Invoice'}   ${formatMoney(a.amountKobo)}`, 50, doc.y + 2);
    }
    if (p.unallocatedKobo > 0) doc.text(`Credit held on account   ${formatMoney(p.unallocatedKobo)}`, 50, doc.y + 2);
    if (!p.allocations.length && p.unallocatedKobo === 0) doc.text('-', 50, doc.y + 2);

    doc.y += 14;
    doc.font('Helvetica').fontSize(8).fillColor(GREY);
    const ref = p.paystack?.reference || p.externalRef;
    if (ref) doc.text(`Reference: ${ref}`, 50, doc.y);
    if (user?.name) doc.text(`Received by: ${user.name}`, 50, doc.y + 2);
    doc.text('This receipt confirms payment received. Thank you.', 50, 760, { width: 495, align: 'center' });
  });
}
