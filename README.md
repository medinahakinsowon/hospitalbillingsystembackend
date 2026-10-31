# Hospital Billing API (Phase 1: Foundation)

Node.js + Express + MongoDB (Mongoose) backend for a hospital billing system covering three payer
scenarios: **corporate** (company pays), **family card** (credit by default, prepaid optional) and **walk-in** (self-pay).

## What Phase 1 includes
- Auth: login, lockout after 5 failed attempts, forced password change, instant token revocation
- Role-based permissions enforced on the server (admin, front_desk, cashier, doctor, pharmacist, lab, billing_officer, finance_manager)
- Patients: registration with duplicate detection, search, soft-delete-ready, every view audited
- Payers: corporate, family (credit/prepaid) and automatic individual "self" payers
- Coverage: links patients to payers, plus a registration-time eligibility check
- Ledger: append-only, integer kobo, atomic credit-limit enforcement, idempotency, reversals, reconciliation
- Audit log: append-only record of who did what and when
- Vercel-ready (cached DB connection, `api/index.js`, `vercel.json`)

## Setup
1. `npm install`
2. `cp .env.example .env`, then fill in `MONGODB_URI` (include a database name, e.g. `/hospital_billing`) and `JWT_SECRET`
   (`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`).
3. In MongoDB Atlas: create a database user with **readWrite** on this database only, and add your IP under Network Access.
4. `npm run db:init`: creates collections and indexes (transactions need collections to exist)
5. Set `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` in `.env`, run `npm run seed:admin`, then delete the password from `.env`
6. `npm run test:ledger`: end-to-end check of the ledger against your database (creates and removes a throwaway payer)
7. `npm run dev`: API on http://localhost:4000, health check at `/health`

## Endpoints (all under /api/v1 except /health)
| Method & path | Permission |
|---|---|
| POST /auth/login | public |
| GET /auth/me, POST /auth/change-password | any signed-in user |
| POST, GET /users, PATCH /users/:id | users:manage |
| POST, GET /patients, GET, PATCH /patients/:id | patients:create / read / update |
| GET /patients/:id/coverages, GET /patients/:id/eligibility | coverages:read |
| POST, GET /payers, GET, PATCH /payers/:id | payers:create / read / update |
| POST, GET /payers/:id/coverages, PATCH /coverages/:id | coverages:manage / read |
| GET /payers/:id/ledger | ledger:read |
| GET /payers/:id/reconcile | ledger:reconcile |
| POST /ledger/entries/:id/reverse | ledger:reverse |
| GET /audit-logs | audit:read |

Errors always look like `{ "error": { "code", "message", "details?" } }`.

## Money rules
- All amounts are **integer kobo**. Never send naira decimals.
- `balanceKobo` = what the payer owes. Negative means a deposit is held.
- `available = creditLimitKobo - balanceKobo` for payers with `enforceLimit: true` (corporate and family cards).
  Prepaid cards use a limit of 0, so available equals the deposit.
- Individual (walk-in) payers have `enforceLimit: false`; the visit workflow (Phase 2) enforces pay-before-service or pay-before-discharge.

## Production hardening checklist
- Give the production DB user **insert-only** rights on `ledgerentries` and `auditlogs` (custom Atlas role). The app-level guard is a safety net, not a substitute.
- Set `NODE_ENV=production` on Vercel; run `npm run db:init` once from your machine against the production database.
- Add environment variables in the Vercel dashboard. Never commit `.env`.
- Rate limiting is in-memory per serverless instance; add Vercel Firewall rules or a shared store before go-live.
- Check Atlas Network Access: Vercel uses dynamic IPs, so you will need `0.0.0.0/0` (with a strong DB password) or Atlas's Vercel integration.
- Review the Nigeria Data Protection Act requirements before holding real patient data.

## Next (Phase 2)
Services catalog, tariffs, encounters, charge capture (posting to the ledger), invoices and receipts, and Paystack payments with webhooks.
