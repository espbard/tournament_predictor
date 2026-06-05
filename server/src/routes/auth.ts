import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { users } from '../db/schema';
import { lucia, requireAuth, requireAdmin } from '../middleware/auth';
import { LoginSchema, RegisterSchema, UpdateUserSchema } from '@tournament-predictor/shared';

export const authRouter = Router();

authRouter.post('/register', async (req, res) => {
  try {
    const { username, password, imageUrl, isLeaderboardUser } = RegisterSchema.parse(req.body);

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

    await db.insert(users).values({ id: userId, username, hashedPassword, isLeaderboardUser: isLeaderboardUser ?? false, imageUrl: imageUrl ?? null });

    const session = await lucia.createSession(userId, {});
    res.setHeader('Set-Cookie', lucia.createSessionCookie(session.id).serialize());

    return res.status(201).json({ id: userId, username, isAdmin: false, isTestAccount: false, isLeaderboardUser: isLeaderboardUser ?? false, imageUrl: imageUrl ?? null });
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

    return res.json({ id: user.id, username: user.username, isAdmin: user.isAdmin, isTestAccount: user.isTestAccount, isLeaderboardUser: user.isLeaderboardUser, imageUrl: user.imageUrl });
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

authRouter.get('/me', requireAuth, async (_req, res) => {
  const [user] = await db
    .select({ id: users.id, username: users.username, isAdmin: users.isAdmin, isTestAccount: users.isTestAccount, isLeaderboardUser: users.isLeaderboardUser, imageUrl: users.imageUrl })
    .from(users)
    .where(eq(users.id, res.locals.user.id))
    .limit(1);
  return res.json(user);
});

authRouter.patch('/me', requireAuth, async (req, res) => {
  try {
    const updates = UpdateUserSchema.parse(req.body);
    const [updated] = await db
      .update(users)
      .set(updates)
      .where(eq(users.id, res.locals.user.id))
      .returning({ id: users.id, username: users.username, isAdmin: users.isAdmin, isTestAccount: users.isTestAccount, isLeaderboardUser: users.isLeaderboardUser, imageUrl: users.imageUrl });
    return res.json(updated);
  } catch (err: any) {
    if (err?.name === 'ZodError') return res.status(400).json({ error: 'Invalid input', details: err.errors });
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

authRouter.get('/users', requireAdmin, async (_req, res) => {
  const allUsers = await db
    .select({ id: users.id, username: users.username, isAdmin: users.isAdmin, isTestAccount: users.isTestAccount, isLeaderboardUser: users.isLeaderboardUser, imageUrl: users.imageUrl })
    .from(users)
    .orderBy(users.username);
  return res.json(allUsers);
});

authRouter.patch('/users/:id', requireAdmin, async (req, res) => {
  const { isTestAccount, isLeaderboardUser } = req.body;
  const updates: Record<string, unknown> = {};
  if (typeof isTestAccount === 'boolean') updates.isTestAccount = isTestAccount;
  if (typeof isLeaderboardUser === 'boolean') updates.isLeaderboardUser = isLeaderboardUser;
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }
  const [updated] = await db
    .update(users)
    .set(updates)
    .where(eq(users.id, req.params.id))
    .returning({ id: users.id, username: users.username, isAdmin: users.isAdmin, isTestAccount: users.isTestAccount, isLeaderboardUser: users.isLeaderboardUser, imageUrl: users.imageUrl });
  if (!updated) return res.status(404).json({ error: 'User not found' });
  return res.json(updated);
});
