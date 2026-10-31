import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { dateOnly, idParam, objectId, pagination } from '../utils/schemas.js';
import { reqContext } from '../services/audit.service.js';
import * as patients from '../services/patients.service.js';
import { getEligibility, listPatientCoverages } from '../services/coverage.service.js';

const router = Router();
router.use(authenticate());

const notFuture = (d) => d <= new Date();
const phone = z.string().trim().min(7).max(20);
const name = z.string().trim().min(1).max(80);

const base = z.object({
  firstName: name,
  lastName: name,
  otherNames: name.optional(),
  dob: dateOnly.refine(notFuture, 'cannot be in the future'),
  sex: z.enum(['male', 'female']),
  phone,
  email: z.string().email().optional(),
  address: z.object({ line: z.string().max(200).optional(), city: z.string().max(80).optional(), state: z.string().max(80).optional() }).optional(),
  nextOfKin: z.object({ name: z.string().max(120).optional(), phone: phone.optional(), relationship: z.string().max(60).optional() }).optional(),
});

router.post(
  '/',
  requirePermission('patients:create'),
  validate({ body: base.extend({ confirmNotDuplicate: z.boolean().optional() }) }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await patients.createPatient(req.body, reqContext(req)));
  })
);

router.get(
  '/',
  requirePermission('patients:read'),
  validate({ query: pagination.extend({ q: z.string().trim().min(2).max(80).optional() }) }),
  asyncHandler(async (req, res) => res.json(await patients.listPatients(req.query)))
);

router.get(
  '/:id',
  requirePermission('patients:read'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => res.json(await patients.getPatient(req.params.id, reqContext(req))))
);

router.patch(
  '/:id',
  requirePermission('patients:update'),
  validate({
    params: idParam,
    body: base.omit({ sex: true }).partial().extend({
      sex: z.enum(['male', 'female']).optional(),
      status: z.enum(['active', 'inactive', 'deceased']).optional(),
    }).refine((b) => Object.keys(b).length > 0, 'Nothing to update'),
  }),
  asyncHandler(async (req, res) => res.json(await patients.updatePatient(req.params.id, req.body, reqContext(req))))
);

router.get(
  '/:id/coverages',
  requirePermission('coverages:read'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => res.json(await listPatientCoverages(req.params.id)))
);

router.get(
  '/:id/eligibility',
  requirePermission('coverages:read'),
  validate({ params: idParam, query: z.object({ serviceId: objectId.optional(), qty: z.coerce.number().int().min(1).max(1000).default(1) }) }),
  asyncHandler(async (req, res) => res.json(await getEligibility(req.params.id, req.query)))
);

export default router;
