import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { users } from '../db/schema';
import { lucia, requireAuth } from '../middleware/auth';
import { LoginSchema, RegisterSchema } from '@tournament-predictor/shared';

export const authRouter = Router();

authRouter.post('/register', async (req, res) => {
  try {
    const { username, password } = RegisterSchema.parse(req.body);

    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, username))
      .limit(1);

    if (existing.length > 0) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = crypto.randomUUID();

    await db.insert(users).values({ id: userId, username, hashedPassword });

    const session = await lucia.createSession(userId, {});
    res.setHeader('Set-Cookie', lucia.createSessionCookie(session.id).serialize());

    return res.status(201).json({ id: userId, username, isAdmin: false });
  } catch (err: any) {
    if (err?.name === 'ZodError') {
      return res.status(400).json({ error: 'Invalid input', details: err.errors });
    }
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

authRouter.post('/login', async (req, res) => {
  try {
    const { username, password } = LoginSchema.parse(req.body);

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.username, username))
      .limit(1);

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.hashedPassword);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const session = await lucia.createSession(user.id, {});
    res.setHeader('Set-Cookie', lucia.createSessionCookie(session.id).serialize());

    return res.json({ id: user.id, username: user.username, isAdmin: user.isAdmin });
  } catch (err: any) {
    if (err?.name === 'ZodError') {
      return res.status(400).json({ error: 'Invalid input', details: err.errors });
    }
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

authRouter.post('/logout', requireAuth, async (_req, res) => {
  await lucia.invalidateSession(res.locals.session.id);
  res.setHeader('Set-Cookie', lucia.createBlankSessionCookie().serialize());
  return res.status(204).send();
});

authRouter.get('/me', requireAuth, (_req, res) => {
  const { id, username, isAdmin } = res.locals.user;
  return res.json({ id, username, isAdmin });
});
