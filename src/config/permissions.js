// Permission-based RBAC. Roles map to permissions; routes require permissions.
const ALL = [
  'users:manage',
  'patients:create', 'patients:read', 'patients:update',
  'payers:create', 'payers:read', 'payers:update',
  'coverages:read', 'coverages:manage',
  'ledger:read', 'ledger:reconcile', 'ledger:reverse',
  'audit:read',
  'services:read', 'services:manage',
  'tariffs:read', 'tariffs:manage',
  'encounters:create', 'encounters:read', 'encounters:update', 'encounters:override',
  'charges:create', 'charges:read', 'charges:void', 'charges:override',
  'invoices:read', 'invoices:create', 'invoices:generate',
  'payments:create', 'payments:read', 'payments:verify',
  'authorizations:read', 'authorizations:request', 'authorizations:decide',
  'adjustments:read', 'adjustments:request', 'adjustments:approve',
  'refunds:read', 'refunds:request', 'refunds:approve', 'refunds:pay',
];

const clinical = ['patients:read', 'coverages:read', 'services:read', 'encounters:read', 'charges:create', 'charges:read'];

export const ROLE_PERMISSIONS = {
  admin: ALL,
  front_desk: [
    'patients:create', 'patients:read', 'patients:update', 'payers:read', 'coverages:read', 'coverages:manage',
    'services:read', 'tariffs:read', 'encounters:create', 'encounters:read', 'encounters:update',
    'authorizations:read', 'authorizations:request',
  ],
  cashier: [
    'patients:read', 'payers:read', 'coverages:read', 'ledger:read',
    'services:read', 'tariffs:read', 'encounters:read', 'encounters:update', 'charges:read',
    'invoices:read', 'invoices:create', 'payments:create', 'payments:read', 'payments:verify',
    'adjustments:read', 'adjustments:request', 'refunds:read', 'refunds:request', 'refunds:pay', 'authorizations:read',
  ],
  doctor: [...clinical, 'authorizations:read', 'authorizations:request'],
  pharmacist: clinical,
  lab: clinical,
  billing_officer: [
    'patients:read', 'payers:create', 'payers:read', 'payers:update',
    'coverages:read', 'coverages:manage', 'ledger:read',
    'services:read', 'tariffs:read', 'encounters:read', 'encounters:update', 'charges:read', 'charges:void',
    'invoices:read', 'invoices:create', 'invoices:generate', 'payments:create', 'payments:read', 'payments:verify',
    'authorizations:read', 'authorizations:request', 'authorizations:decide',
    'adjustments:read', 'adjustments:request', 'refunds:read', 'refunds:request',
  ],
  finance_manager: [
    'patients:read', 'payers:read', 'payers:update', 'coverages:read',
    'ledger:read', 'ledger:reconcile', 'ledger:reverse', 'audit:read',
    'services:read', 'services:manage', 'tariffs:read', 'tariffs:manage',
    'encounters:read', 'encounters:override', 'charges:read', 'charges:void', 'charges:override',
    'invoices:read', 'payments:read', 'payments:verify',
    'authorizations:read', 'authorizations:decide', 'adjustments:read', 'adjustments:approve', 'refunds:read', 'refunds:approve',
  ],
};

export const ROLES = Object.keys(ROLE_PERMISSIONS);
export const can = (role, permission) => ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
