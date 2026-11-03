import mongoose from 'mongoose';
const { Schema } = mongoose;

const koboField = { type: Number, validate: { validator: Number.isSafeInteger, message: 'must be an integer number of kobo' } };
const byMethod = { cashKobo: koboField, posKobo: koboField, transferKobo: koboField };

// A cashier's till shift. Everything taken in cash, by POS or by transfer, and every refund paid out, belongs to one.
const cashierSessionSchema = new Schema(
  {
    sessionNo: { type: String, required: true },
    cashierId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['open', 'closed', 'reviewed'], default: 'open' },
    openedAt: { type: Date, default: Date.now },
    openingFloatKobo: { ...koboField, min: 0, default: 0 },
    paymentCount: { type: Number, default: 0 }, // touched by every payment, so closing and paying cannot interleave
    closedAt: Date,
    expected: byMethod, // computed from the ledger at close; hidden from the cashier while the shift is open (blind count)
    counted: byMethod, // what the cashier reports counting
    variance: byMethod, // counted minus expected
    flagged: { type: Boolean, default: false }, // any variance beyond CASH_VARIANCE_ALERT_KOBO
    closeNote: { type: String, maxlength: 300 },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
    reviewNote: { type: String, maxlength: 300 },
  },
  { timestamps: true }
);
cashierSessionSchema.index({ sessionNo: 1 }, { unique: true });
// A cashier can have only one open shift at a time.
cashierSessionSchema.index({ cashierId: 1 }, { unique: true, partialFilterExpression: { status: 'open' } });
cashierSessionSchema.index({ status: 1, openedAt: -1 });
cashierSessionSchema.index({ cashierId: 1, openedAt: -1 });

export const CashierSession = mongoose.model('CashierSession', cashierSessionSchema);
