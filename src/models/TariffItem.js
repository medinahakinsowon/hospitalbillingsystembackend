import mongoose from 'mongoose';
const { Schema } = mongoose;

// One row per price version. Prices are never edited: a change closes the old row
// (effectiveTo) and adds a new one, so historical invoices can always be explained.
const tariffItemSchema = new Schema(
  {
    tariffId: { type: Schema.Types.ObjectId, ref: 'Tariff', required: true },
    serviceId: { type: Schema.Types.ObjectId, ref: 'Service', required: true },
    priceKobo: {
      type: Number,
      required: true,
      min: 0,
      validate: { validator: Number.isSafeInteger, message: 'priceKobo must be an integer number of kobo' },
    },
    effectiveFrom: { type: Date, required: true },
    effectiveTo: { type: Date, default: null },
    isCurrent: { type: Boolean, default: true }, // the open-ended (latest) version
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);
tariffItemSchema.index({ tariffId: 1, serviceId: 1, effectiveFrom: -1 });
tariffItemSchema.index({ tariffId: 1, serviceId: 1 }, { unique: true, partialFilterExpression: { isCurrent: true } });

export const TariffItem = mongoose.model('TariffItem', tariffItemSchema);
