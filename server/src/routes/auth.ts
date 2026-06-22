import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { users } from '../db/schema';
import { lucia, requireAuth, requireAdmin } from '../middleware/auth';
import { LoginSchema, RegisterSchema, UpdateUserSchema } from '@tournament-predictor/shared';

function generateIconColor(): string {
  const h = Math.floor(Math.random() * 360);
  const s = (55 + Math.floor(Math.random() * 30)) / 100;
  const l = (30 + Math.floor(Math.random() * 15)) / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const c = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(255 * c).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

export const authRouter = Router();

authRouter.post('/register', async (req, res) => {
  try {
    const { username, password, imageUrl, iconColor, isLeaderboardUser, isLateAddition } = RegisterSchema.parse(req.body);

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
    const color = iconColor ?? generateIconColor();

    await db.insert(users).values({
      id: userId,
      username,
      hashedPassword,
      isLeaderboardUser: isLeaderboardUser ?? false,
      isLateAddition: isLateAddition ?? false,
      imageUrl: imageUrl ?? null,
      iconColor: color,
    });

    const session = await lucia.createSession(userId, {});
    res.setHeader('Set-Cookie', lucia.createSessionCookie(session.id).serialize());

    return res.status(201).json({
      id: userId,
      username,
      isAdmin: false,
      isTestAccount: false,
      isLeaderboardUser: isLeaderboardUser ?? false,
      isComparisonUser: false,
      isLateAddition: isLateAddition ?? false,
      imageUrl: imageUrl ?? null,
      iconColor: color,
    });
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

    return res.json({ id: user.id, username: user.username, isAdmin: user.isAdmin, isTestAccount: user.isTestAccount, isLeaderboardUser: user.isLeaderboardUser, isComparisonUser: user.isComparisonUser, isLateAddition: user.isLateAddition, imageUrl: user.imageUrl, iconColor: user.iconColor });
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
    .select({ id: users.id, username: users.username, isAdmin: users.isAdmin, isTestAccount: users.isTestAccount, isLeaderboardUser: users.isLeaderboardUser, isComparisonUser: users.isComparisonUser, isLateAddition: users.isLateAddition, imageUrl: users.imageUrl, iconColor: users.iconColor })
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
      .returning({ id: users.id, username: users.username, isAdmin: users.isAdmin, isTestAccount: users.isTestAccount, isLeaderboardUser: users.isLeaderboardUser, isComparisonUser: users.isComparisonUser, isLateAddition: users.isLateAddition, imageUrl: users.imageUrl, iconColor: users.iconColor });
    return res.json(updated);
  } catch (err: any) {
    if (err?.name === 'ZodError') return res.status(400).json({ error: 'Invalid input', details: err.errors });
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

authRouter.get('/users', requireAdmin, async (_req, res) => {
  const allUsers = await db
    .select({ id: users.id, username: users.username, isAdmin: users.isAdmin, isTestAccount: users.isTestAccount, isLeaderboardUser: users.isLeaderboardUser, isComparisonUser: users.isComparisonUser, isLateAddition: users.isLateAddition, imageUrl: users.imageUrl, iconColor: users.iconColor })
    .from(users)
    .orderBy(users.username);
  return res.json(allUsers);
});

authRouter.patch('/users/:id', requireAdmin, async (req, res) => {
  const { isTestAccount, isLeaderboardUser, isComparisonUser, isLateAddition } = req.body;
  const updates: Record<string, unknown> = {};
  if (typeof isTestAccount === 'boolean') updates.isTestAccount = isTestAccount;
  if (typeof isLeaderboardUser === 'boolean') updates.isLeaderboardUser = isLeaderboardUser;
  if (typeof isComparisonUser === 'boolean') updates.isComparisonUser = isComparisonUser;
  if (typeof isLateAddition === 'boolean') updates.isLateAddition = isLateAddition;
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }
  const [updated] = await db
    .update(users)
    .set(updates)
    .where(eq(users.id, req.params.id))
    .returning({ id: users.id, username: users.username, isAdmin: users.isAdmin, isTestAccount: users.isTestAccount, isLeaderboardUser: users.isLeaderboardUser, isComparisonUser: users.isComparisonUser, isLateAddition: users.isLateAddition, imageUrl: users.imageUrl, iconColor: users.iconColor });
  if (!updated) return res.status(404).json({ error: 'User not found' });
  return res.json(updated);
});
