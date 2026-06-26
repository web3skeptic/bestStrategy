import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

// ── Type augmentation ──
// Attach the authenticated user (if any) to the Express request object.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: { id: number; nickname: string };
    }
  }
}

function resolveJwtSecret(): string {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  // Fail-safe: never run with a hardcoded secret in production.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be set in production');
  }
  // Dev fallback — keep local dev working, but warn once so it's noticed.
  console.warn('[auth] JWT_SECRET not set — using insecure dev fallback secret. Do NOT use in production.');
  return 'dev-secret-do-not-use-in-production-change-me';
}

export const JWT_SECRET: string = resolveJwtSecret();

export const JWT_EXPIRES_IN = '30d';

export interface JwtUserPayload {
  id: number;
  nickname: string;
}

export function signToken(payload: JwtUserPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

export function verifyToken(token: string): JwtUserPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as jwt.JwtPayload & Partial<JwtUserPayload>;
    if (typeof decoded === 'object' && decoded !== null
        && typeof decoded.id === 'number'
        && typeof decoded.nickname === 'string') {
      return { id: decoded.id, nickname: decoded.nickname };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Express middleware: require a valid JWT in the Authorization header.
 * Format: `Authorization: Bearer <token>`. On success, populates `req.user`.
 * On missing/invalid token, returns 401.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers['authorization'] ?? req.headers['Authorization' as never];
  if (!header || typeof header !== 'string') {
    res.status(401).json({ ok: false, error: 'Missing Authorization header' });
    return;
  }
  const parts = header.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer' || !parts[1]) {
    res.status(401).json({ ok: false, error: 'Invalid Authorization header (expected: Bearer <token>)' });
    return;
  }
  const token = parts[1];
  const user = verifyToken(token);
  if (!user) {
    res.status(401).json({ ok: false, error: 'Invalid or expired token' });
    return;
  }
  req.user = user;
  next();
}
