import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { can } from '../config/permissions.js';
import { User } from '../models/User.js';
import { AppError } from '../utils/AppError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export function authenticate({ allowPasswordChange = false, allowMfaSetup = false } = {}) {
  return asyncHandler(async (req, res, next) => {
    const [scheme, token] = (req.headers.authorization || '').split(' ');
    if (scheme !== 'Bearer' || !token) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');

    let payload;
    try {
      payload = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
    } catch {
      throw new AppError(401, 'INVALID_TOKEN', 'Invalid or expired token');
    }

    if (payload.purpose) throw new AppError(401, 'INVALID_TOKEN', 'Invalid or expired token'); // a half-finished MFA login token is not a session
    const user = await User.findById(payload.sub).lean();
    // tokenVersion lets us revoke tokens instantly (disable user, role change, password change).
    if (!user || user.status !== 'active' || user.tokenVersion !== payload.tv) {
      throw new AppError(401, 'INVALID_TOKEN', 'Invalid or expired token');
    }
    if (user.mustChangePassword && !allowPasswordChange) {
      throw new AppError(403, 'PASSWORD_CHANGE_REQUIRED', 'You must change your password before continuing');
    }
    // Roles listed in MFA_REQUIRED_ROLES must enrol before doing anything else.
    if (!allowMfaSetup && !user.mfaEnabled && env.MFA_REQUIRED_ROLES.includes(user.role)) {
      throw new AppError(403, 'MFA_ENROLLMENT_REQUIRED', 'Your role requires two-factor authentication. Set it up to continue.');
    }
    req.user = { id: user._id, name: user.name, email: user.email, role: user.role, mfaEnabled: Boolean(user.mfaEnabled) };
    next();
  });
}

/** Allow the request if the user holds AT LEAST ONE of these permissions. */
export const requireAnyPermission = (...permissions) => (req, res, next) => {
  if (!req.user) return next(new AppError(401, 'UNAUTHENTICATED', 'Authentication required'));
  if (!permissions.some((p) => can(req.user.role, p))) {
    return next(new AppError(403, 'FORBIDDEN', 'You do not have permission to perform this action'));
  }
  next();
};

/** Server-side permission check. UI hiding is never enough. */
export const requirePermission = (...permissions) => (req, res, next) => {
  if (!req.user) return next(new AppError(401, 'UNAUTHENTICATED', 'Authentication required'));
  if (!permissions.every((p) => can(req.user.role, p))) {
    return next(new AppError(403, 'FORBIDDEN', 'You do not have permission to perform this action'));
  }
  next();
};
