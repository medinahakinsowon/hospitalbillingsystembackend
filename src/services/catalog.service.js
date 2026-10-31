import { withTransaction } from '../config/db.js';
import { Service } from '../models/Service.js';
import { Tariff } from '../models/Tariff.js';
import { TariffItem } from '../models/TariffItem.js';
import { AppError } from '../utils/AppError.js';
import { escapeRegex } from '../utils/escapeRegex.js';
import { recordAudit, changedFields } from './audit.service.js';

// ------------------------------------------------------------------ services catalog
export async function createService(data, ctx) {
  const svc = await Service.create({ ...data, createdBy: ctx.actorId });
  await recordAudit(ctx, { action: 'service.create', entity: 'Service', entityId: svc._id, after: { code: svc.code, name: svc.name, department: svc.department } });
  return svc.toObject();
}

export async function listServices({ q, department, active, page, limit }) {
  const filter = {};
  if (department) filter.department = department;
  if (active !== undefined) filter.active = active;
  if (q) {
    const rx = new RegExp(escapeRegex(q.trim()), 'i');
    filter.$or = [{ name: rx }, { code: rx }];
  }
  const [items, total] = await Promise.all([
    Service.find(filter).sort({ department: 1, name: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    Service.countDocuments(filter),
  ]);
  return { items, page, limit, total };
}

export async function updateService(id, patch, ctx) {
  const svc = await Service.findById(id);
  if (!svc) throw new AppError(404, 'SERVICE_NOT_FOUND', 'Service not found');
  const before = svc.toObject();
  const diff = changedFields(before, patch, ['name', 'department', 'category', 'active']);
  if (!Object.keys(diff.after).length) return before;
  svc.set(diff.after);
  await svc.save();
  await recordAudit(ctx, { action: 'service.update', entity: 'Service', entityId: svc._id, ...diff });
  return svc.toObject();
}

/** Corporate contracts list covered/excluded services by code, category or department. */
export function checkServiceCoverage(payer, service) {
  if (payer.type !== 'corporate' || !payer.contract) return { covered: true };
  const keys = [service.code, service.category, service.department].filter(Boolean).map((x) => String(x).toLowerCase());
  const excluded = (payer.contract.excludedServices || []).map((x) => x.toLowerCase());
  const covered = (payer.contract.coveredServices || []).map((x) => x.toLowerCase());
  if (keys.some((k) => excluded.includes(k))) return { covered: false, reason: 'excluded' };
  if (covered.length && !keys.some((k) => covered.includes(k))) return { covered: false, reason: 'not_listed' };
  return { covered: true };
}

// ------------------------------------------------------------------ tariffs
export async function createTariff(data, ctx) {
  return withTransaction(async (session) => {
    if (data.isDefault) await Tariff.updateMany({ isDefault: true }, { $set: { isDefault: false } }, { session });
    const [t] = await Tariff.create([{ ...data, createdBy: ctx.actorId }], { session });
    await recordAudit(ctx, { action: 'tariff.create', entity: 'Tariff', entityId: t._id, after: { code: t.code, name: t.name, isDefault: t.isDefault } }, session);
    return t.toObject();
  });
}

export const listTariffs = () => Tariff.find().sort({ isDefault: -1, name: 1 }).lean();

export async function updateTariff(id, patch, ctx) {
  return withTransaction(async (session) => {
    const t = await Tariff.findById(id).session(session);
    if (!t) throw new AppError(404, 'TARIFF_NOT_FOUND', 'Tariff not found');
    if (t.isDefault && patch.status === 'archived') throw new AppError(422, 'NOT_ALLOWED', 'The default tariff cannot be archived. Make another tariff the default first.');
    const before = t.toObject();
    if (patch.isDefault === true && !t.isDefault) {
      if (t.status !== 'active') throw new AppError(422, 'NOT_ALLOWED', 'Only an active tariff can be the default');
      await Tariff.updateMany({ isDefault: true }, { $set: { isDefault: false } }, { session });
    }
    if (patch.isDefault === false && t.isDefault) throw new AppError(422, 'NOT_ALLOWED', 'To change the default, make another tariff the default instead');
    const diff = changedFields(before, patch, ['name', 'description', 'status', 'isDefault']);
    if (!Object.keys(diff.after).length) return before;
    t.set(diff.after);
    await t.save({ session });
    await recordAudit(ctx, { action: 'tariff.update', entity: 'Tariff', entityId: t._id, ...diff }, session);
    return t.toObject();
  });
}

/** Price list effective at `at` (default now), with service details. */
export async function listTariffItems(tariffId, { at, q, page, limit }) {
  const tariff = await Tariff.findById(tariffId).lean();
  if (!tariff) throw new AppError(404, 'TARIFF_NOT_FOUND', 'Tariff not found');
  const when = at ?? new Date();
  const filter = { tariffId, effectiveFrom: { $lte: when }, $or: [{ effectiveTo: null }, { effectiveTo: { $gt: when } }] };
  if (q) {
    const rx = new RegExp(escapeRegex(q.trim()), 'i');
    const ids = await Service.find({ $or: [{ name: rx }, { code: rx }] }).distinct('_id');
    filter.serviceId = { $in: ids };
  }
  const [items, total] = await Promise.all([
    TariffItem.find(filter).populate('serviceId', 'code name department category active').sort({ effectiveFrom: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    TariffItem.countDocuments(filter),
  ]);
  return { tariff, items, page, limit, total };
}

/**
 * Set prices in bulk. A changed price closes the current version and opens a new one;
 * an unchanged price is skipped. New versions cannot start before the current version started.
 */
export async function setTariffPrices(tariffId, items, ctx) {
  const tariff = await Tariff.findById(tariffId).lean();
  if (!tariff) throw new AppError(404, 'TARIFF_NOT_FOUND', 'Tariff not found');
  if (tariff.status !== 'active') throw new AppError(422, 'TARIFF_ARCHIVED', 'Archived tariffs cannot be changed');

  const ids = items.map((i) => String(i.serviceId));
  if (new Set(ids).size !== ids.length) throw new AppError(400, 'DUPLICATE_SERVICE', 'Each service may appear only once per request');
  if ((await Service.countDocuments({ _id: { $in: ids } })) !== ids.length) throw new AppError(404, 'SERVICE_NOT_FOUND', 'One or more services do not exist');

  return withTransaction(async (session) => {
    const results = [];
    for (const it of items) {
      const from = it.effectiveFrom ?? new Date();
      const current = await TariffItem.findOne({ tariffId, serviceId: it.serviceId, isCurrent: true }).session(session);
      if (current) {
        if (current.priceKobo === it.priceKobo) { results.push({ serviceId: it.serviceId, result: 'unchanged' }); continue; }
        if (from <= current.effectiveFrom) {
          throw new AppError(422, 'BACKDATED_PRICE', 'A new price must start after the current price started', { serviceId: it.serviceId, currentFrom: current.effectiveFrom });
        }
        current.effectiveTo = from;
        current.isCurrent = false;
        await current.save({ session });
      }
      await TariffItem.create([{ tariffId, serviceId: it.serviceId, priceKobo: it.priceKobo, effectiveFrom: from, createdBy: ctx.actorId }], { session });
      results.push({ serviceId: it.serviceId, result: current ? 'updated' : 'created', oldPriceKobo: current?.priceKobo ?? null, newPriceKobo: it.priceKobo });
    }
    await recordAudit(ctx, { action: 'tariff.prices.set', entity: 'Tariff', entityId: tariffId, meta: { changes: results.filter((r) => r.result !== 'unchanged') } }, session);
    return results;
  });
}

/**
 * Price for a service under a payer's tariff, falling back to the default tariff.
 * Throws if neither has an effective price: we never guess a price.
 */
export async function resolvePrice(payer, serviceId, at = new Date()) {
  const candidates = [];
  if (payer.tariffId) candidates.push({ id: payer.tariffId, source: 'payer_tariff' });
  const def = await Tariff.findOne({ isDefault: true, status: 'active' }).lean();
  if (def && String(def._id) !== String(payer.tariffId)) candidates.push({ id: def._id, source: 'default_tariff' });

  for (const c of candidates) {
    const item = await TariffItem.findOne({
      tariffId: c.id, serviceId, effectiveFrom: { $lte: at },
      $or: [{ effectiveTo: null }, { effectiveTo: { $gt: at } }],
    }).sort({ effectiveFrom: -1 }).lean();
    if (item) return { priceKobo: item.priceKobo, tariffId: c.id, tariffItemId: item._id, source: c.source };
  }
  throw new AppError(422, 'PRICE_NOT_FOUND', 'No price is set for this service on the payer\'s tariff or the default tariff');
}
