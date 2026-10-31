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
  doc.font('Helvetica-Bold').fontSize(22).fillColor('#000').text(title, 350, 50, { width: 195, align: 'right' });
  doc.y = Math.max(doc.y, 100) + 10;
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor(LINE).stroke();
  doc.y += 12;
}

function kv(doc, x, y, label, value, width = 230) {
  doc.font('Helvetica').fontSize(8).fillColor(GREY).text(label.toUpperCase(), x, y, { width });
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#000').text(value || '-', x, doc.y, { width });
}

export async function streamInvoicePdf(invoiceId, res) {
  const inv = await Invoice.findById(invoiceId).lean();
  if (!inv) throw new AppError(404, 'INVOICE_NOT_FOUND', 'Invoice not found');
  const payer = await Payer.findById(inv.payerId).select('billingContact').lean();

  pipePdf(res, inv.invoiceNo, (doc) => {
    header(doc, 'INVOICE');
    const top = doc.y;
    kv(doc, 50, top, 'Billed to', inv.payerName);
    doc.font('Helvetica').fontSize(9).fillColor(GREY).text(`${inv.payerCode}${payer?.billingContact?.name ? ` | Attn: ${payer.billingContact.name}` : ''}`, 50, doc.y, { width: 230 });
    const leftEnd = doc.y;
    kv(doc, 320, top, 'Invoice no.', inv.invoiceNo, 225);
    kv(doc, 320, doc.y + 4, 'Issued / Due', `${fmtDate(inv.issuedAt)}  /  ${fmtDate(inv.dueAt)}`, 225);
    kv(doc, 320, doc.y + 4, 'Status', inv.status.toUpperCase(), 225);
    doc.y = Math.max(leftEnd, doc.y) + 14;

    if (inv.patientName) {
      kv(doc, 50, doc.y, 'Patient', `${inv.patientName}  (${inv.hospitalNumber})`, 300);
      doc.font('Helvetica').fontSize(9).fillColor(GREY).text(`Visit ${inv.encounterNo || ''}`, 50, doc.y, { width: 300 });
      doc.y += 12;
    }

    // table
    const cols = { date: 50, desc: 115, qty: 360, unit: 400, amt: 475 };
    const rowHead = (y) => {
      doc.rect(50, y - 4, 495, 18).fill('#f0f0f0');
      doc.fillColor('#000').font('Helvetica-Bold').fontSize(9);
      doc.text('Date', cols.date + 4, y, { width: 60 });
      doc.text('Description', cols.desc, y, { width: 240 });
      doc.text('Qty', cols.qty, y, { width: 35, align: 'right' });
      doc.text('Unit price', cols.unit, y, { width: 70, align: 'right' });
      doc.text('Amount', cols.amt, y, { width: 66, align: 'right' });
    };
    let y = doc.y + 4;
    rowHead(y);
    y += 22;
    doc.font('Helvetica').fontSize(9);
    for (const l of inv.lines) {
      if (y > 730) { doc.addPage(); y = 60; rowHead(y); y += 22; doc.font('Helvetica').fontSize(9); }
      const h = Math.max(14, doc.heightOfString(l.description || '', { width: 240 }) + 4);
      doc.fillColor('#000');
      doc.text(fmtDate(l.date), cols.date + 4, y, { width: 60 });
      doc.text(l.description || '', cols.desc, y, { width: 240 });
      doc.text(String(l.qty), cols.qty, y, { width: 35, align: 'right' });
      doc.text(formatMoney(l.unitPriceKobo), cols.unit - 10, y, { width: 80, align: 'right' });
      doc.text(formatMoney(l.totalKobo), cols.amt - 10, y, { width: 76, align: 'right' });
      y += h;
      doc.moveTo(50, y - 2).lineTo(545, y - 2).strokeColor('#eeeeee').stroke();
    }

    if (y > 690) { doc.addPage(); y = 60; }
    y += 10;
    const totalRow = (label, value, bold) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 10).fillColor('#000');
      doc.text(label, 340, y, { width: 100, align: 'right' });
      doc.text(value, 445, y, { width: 100, align: 'right' });
      y += bold ? 20 : 16;
    };
    totalRow('Total', formatMoney(inv.totalKobo));
    totalRow('Paid', formatMoney(inv.paidKobo));
    totalRow('Balance due', formatMoney(inv.totalKobo - inv.paidKobo), true);
    doc.font('Helvetica').fontSize(8).fillColor(GREY).text('Thank you. Please quote the invoice number with any payment.', 50, Math.max(y + 30, 760), { width: 495, align: 'center' });
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
