import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { db } from './db';
import { signToken } from './auth';

export const authRouter = Router();

const NICKNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const MIN_PASSWORD_LEN = 6;
const BCRYPT_ROUNDS = 10;

interface UserRow {
  id: number;
  nickname: string;
  email: string;
  password_hash: string;
  created_at: number;
}

// POST /api/auth/register
authRouter.post('/register', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { nickname?: unknown; email?: unknown; password?: unknown };
  const { nickname, email, password } = body;

  if (typeof nickname !== 'string' || typeof email !== 'string' || typeof password !== 'string') {
    res.status(400).json({ ok: false, error: 'Missing nickname, email, or password' });
    return;
  }
  if (!NICKNAME_RE.test(nickname)) {
    res.status(400).json({ ok: false, error: 'Nickname must be 3-20 alphanumeric/underscore characters' });
    return;
  }
  if (password.length < MIN_PASSWORD_LEN) {
    res.status(400).json({ ok: false, error: `Password must be at least ${MIN_PASSWORD_LEN} characters` });
    return;
  }
  if (email.trim().length === 0 || !email.includes('@')) {
    res.status(400).json({ ok: false, error: 'Invalid email' });
    return;
  }

  // Check uniqueness up-front for friendlier error message.
  const existing = db.prepare(
    `SELECT id FROM users WHERE nickname = ? OR email = ?`
  ).get(nickname, email) as { id: number } | undefined;
  if (existing) {
    res.status(409).json({ ok: false, error: 'Nickname or email already taken' });
    return;
  }

  let passwordHash: string;
  try {
    passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Failed to hash password' });
    return;
  }

  let id: number;
  try {
    const info = db.prepare(
      `INSERT INTO users (nickname, email, password_hash) VALUES (?, ?, ?)`
    ).run(nickname, email, passwordHash);
    id = Number(info.lastInsertRowid);
  } catch (e: unknown) {
    // Race against the up-front check above (UNIQUE constraint violation).
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE')) {
      res.status(409).json({ ok: false, error: 'Nickname or email already taken' });
      return;
    }
    // Log the detail server-side; never echo raw DB errors to the client.
    console.error('Failed to create user:', msg);
    res.status(500).json({ ok: false, error: 'Failed to create user' });
    return;
  }

  const token = signToken({ id, nickname });
  res.status(201).json({ token, nickname });
});

// POST /api/auth/login
authRouter.post('/login', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { nickname?: unknown; password?: unknown };
  const { nickname, password } = body;

  if (typeof nickname !== 'string' || typeof password !== 'string') {
    res.status(400).json({ ok: false, error: 'Missing nickname or password' });
    return;
  }

  const user = db.prepare(
    `SELECT id, nickname, email, password_hash, created_at FROM users WHERE nickname = ?`
  ).get(nickname) as UserRow | undefined;

  if (!user) {
    res.status(401).json({ ok: false, error: 'Invalid nickname or password' });
    return;
  }

  let match = false;
  try {
    match = await bcrypt.compare(password, user.password_hash);
  } catch {
    match = false;
  }
  if (!match) {
    res.status(401).json({ ok: false, error: 'Invalid nickname or password' });
    return;
  }

  const token = signToken({ id: user.id, nickname: user.nickname });
  res.json({ token, nickname: user.nickname });
});
