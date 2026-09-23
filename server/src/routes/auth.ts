import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { users } from '../db/schema';
import { lucia, requireAuth, requireAdmin } from '../middleware/auth';
import {
  ForgotPasswordSchema,
  LoginSchema,
  RegisterSchema,
  ResetPasswordSchema,
  UpdateUserSchema,
} from '@tournament-predictor/shared';
import { sendEmail } from '../lib/email';
import { RateLimiter } from '../lib/rateLimit';
import {
  appBaseUrl,
  buildResetEmail,
  consumeResetToken,
  createResetToken,
  deleteResetTokensForUser,
  resetPasswordPath,
} from '../lib/passwordReset';

const HOUR = 60 * 60 * 1000;
// Generous for a person, tight for a script. Per IP and per address, so neither a single
// attacker nor a flood aimed at one victim's inbox gets far.
const forgotByIp = new RateLimiter(10, HOUR);
const forgotByEmail = new RateLimiter(3, HOUR);
const resetByIp = new RateLimiter(20, HOUR);

// Drizzle wraps the driver's error, so the Postgres code may sit one level down.
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | undefined;
  return e?.code === '23505' || e?.cause?.code === '23505';
}

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

// What the signed-in user sees of their own account. Includes the email, which is private:
// the admin user list and every other endpoint leave it out.
const ownUserFields = { id: users.id, username: users.username, isAdmin: users.isAdmin, isTestAccount: users.isTestAccount, isLeaderboardUser: users.isLeaderboardUser, isComparisonUser: users.isComparisonUser, isLateAddition: users.isLateAddition, imageUrl: users.imageUrl, iconColor: users.iconColor, email: users.email };

authRouter.post('/register', async (req, res) => {
  try {
    const { username, password, email, imageUrl, iconColor, isLeaderboardUser, isLateAddition } = RegisterSchema.parse(req.body);

    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, username))
      .limit(1);

    if (existing.length > 0) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    if (email) {
      const [emailTaken] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
      if (emailTaken) return res.status(409).json({ error: 'Email already in use' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = crypto.randomUUID();
    const color = iconColor ?? generateIconColor();

    await db.insert(users).values({
      id: userId,
      username,
      email: email ?? null,
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
      email: email ?? null,
    });
  } catch (err: any) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: 'Username or email already in use' });
    }
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

    return res.json({ id: user.id, username: user.username, isAdmin: user.isAdmin, isTestAccount: user.isTestAccount, isLeaderboardUser: user.isLeaderboardUser, isComparisonUser: user.isComparisonUser, isLateAddition: user.isLateAddition, imageUrl: user.imageUrl, iconColor: user.iconColor, email: user.email });
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
    .select(ownUserFields)
    .from(users)
    .where(eq(users.id, res.locals.user.id))
    .limit(1);
  return res.json(user);
});

authRouter.patch('/me', requireAuth, async (req, res) => {
  try {
    const updates = UpdateUserSchema.parse(req.body);
    const [before] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, res.locals.user.id))
      .limit(1);
    const [updated] = await db
      .update(users)
      .set(updates)
      .where(eq(users.id, res.locals.user.id))
      .returning(ownUserFields);
    // A reset link already sent to the old address must not outlive the change.
    if (updates.email !== undefined && updates.email !== before?.email) {
      await deleteResetTokensForUser(res.locals.user.id);
    }
    return res.json(updated);
  } catch (err: any) {
    if (isUniqueViolation(err)) return res.status(409).json({ error: 'Email already in use' });
    if (err?.name === 'ZodError') return res.status(400).json({ error: 'Invalid input', details: err.errors });
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Always answers the same way, whether or not the address belongs to anyone, and does the
// lookup and sending after responding — so neither the reply nor its timing tells a
// stranger which addresses have accounts.
authRouter.post('/forgot-password', async (req, res) => {
  let input;
  try {
    input = ForgotPasswordSchema.parse(req.body);
  } catch {
    return res.status(400).json({ error: 'Invalid email address' });
  }
  if (!forgotByIp.hit(req.ip ?? 'unknown')) {
    return res.status(429).json({ error: 'Too many requests. Try again later.' });
  }
  res.json({ ok: true });

  if (!forgotByEmail.hit(input.email)) return;
  try {
    const [user] = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(eq(users.email, input.email))
      .limit(1);
    if (!user) return;
    const token = await createResetToken(user.id);
    const link = `${appBaseUrl()}${resetPasswordPath(token)}`;
    await sendEmail({ to: input.email, ...buildResetEmail(user.username, link, input.language) });
  } catch (err) {
    console.error('Password reset email failed:', err);
  }
});

authRouter.post('/reset-password', async (req, res) => {
  try {
    if (!resetByIp.hit(req.ip ?? 'unknown')) {
      return res.status(429).json({ error: 'Too many requests. Try again later.' });
    }
    const { token, password } = ResetPasswordSchema.parse(req.body);
    const userId = await consumeResetToken(token);
    if (!userId) {
      return res.status(400).json({ error: 'This reset link is invalid or has expired. Ask for a new one.' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const [user] = await db
      .update(users)
      .set({ hashedPassword })
      .where(eq(users.id, userId))
      .returning(ownUserFields);
    await deleteResetTokensForUser(userId);
    // Whoever might have been signed in with the old password is signed out everywhere.
    await lucia.invalidateUserSessions(userId);
    const session = await lucia.createSession(userId, {});
    res.setHeader('Set-Cookie', lucia.createSessionCookie(session.id).serialize());
    return res.json(user);
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
