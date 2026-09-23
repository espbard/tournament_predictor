import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { users } from '../db/schema';
import { lucia, requireAuth, requireAdmin } from '../middleware/auth';
import {
  AdminUpdateUserSchema,
  ForgotPasswordSchema,
  LoginSchema,
  RegisterSchema,
  ResetPasswordSchema,
  UpdateUserSchema,
} from '@tournament-predictor/shared';
import { sendEmail } from '../lib/email';
import { RateLimiter } from '../lib/rateLimit';
import { decryptEmail, EmailNotConfiguredError, emailLookupHash, encryptEmail } from '../lib/emailCrypto';
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
// only the admin user list shows it to anybody else, and every other endpoint leaves it
// out. Select these, then pass the row through toOwnUser to decrypt the address.
const ownUserFields = { id: users.id, username: users.username, isAdmin: users.isAdmin, isTestAccount: users.isTestAccount, isLeaderboardUser: users.isLeaderboardUser, isComparisonUser: users.isComparisonUser, isLateAddition: users.isLateAddition, imageUrl: users.imageUrl, iconColor: users.iconColor, emailEncrypted: users.emailEncrypted };

function toOwnUser<T extends { emailEncrypted: string | null }>(row: T) {
  const { emailEncrypted, ...rest } = row;
  return { ...rest, email: decryptEmail(emailEncrypted) };
}

// The stored form of an address: encrypted, plus the keyed hash used to find it again.
function emailColumns(email: string | null) {
  return email
    ? { emailEncrypted: encryptEmail(email), emailHash: emailLookupHash(email) }
    : { emailEncrypted: null, emailHash: null };
}

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
      const [emailTaken] = await db.select({ id: users.id }).from(users).where(eq(users.emailHash, emailLookupHash(email))).limit(1);
      if (emailTaken) return res.status(409).json({ error: 'Email already in use' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = crypto.randomUUID();
    const color = iconColor ?? generateIconColor();

    await db.insert(users).values({
      id: userId,
      username,
      ...emailColumns(email ?? null),
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
    if (err instanceof EmailNotConfiguredError) {
      return res.status(503).json({ error: 'Email addresses cannot be saved right now. Leave the email empty, or try again later.' });
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

    return res.json({ id: user.id, username: user.username, isAdmin: user.isAdmin, isTestAccount: user.isTestAccount, isLeaderboardUser: user.isLeaderboardUser, isComparisonUser: user.isComparisonUser, isLateAddition: user.isLateAddition, imageUrl: user.imageUrl, iconColor: user.iconColor, email: decryptEmail(user.emailEncrypted) });
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
  return res.json(user && toOwnUser(user));
});

authRouter.patch('/me', requireAuth, async (req, res) => {
  try {
    const { email, ...updates } = UpdateUserSchema.parse(req.body);
    const [before] = await db
      .select({ emailHash: users.emailHash })
      .from(users)
      .where(eq(users.id, res.locals.user.id))
      .limit(1);
    const emailUpdate = email === undefined ? null : emailColumns(email);
    const [updated] = await db
      .update(users)
      .set({ ...updates, ...(emailUpdate ?? {}) })
      .where(eq(users.id, res.locals.user.id))
      .returning(ownUserFields);
    // A reset link already sent to the old address must not outlive the change.
    if (emailUpdate && emailUpdate.emailHash !== before?.emailHash) {
      await deleteResetTokensForUser(res.locals.user.id);
    }
    return res.json(toOwnUser(updated));
  } catch (err: any) {
    if (isUniqueViolation(err)) return res.status(409).json({ error: 'Email already in use' });
    if (err instanceof EmailNotConfiguredError) {
      return res.status(503).json({ error: 'Email addresses cannot be saved right now. Try again later.' });
    }
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
      .where(eq(users.emailHash, emailLookupHash(input.email)))
      .limit(1);
    if (!user) return;
    const token = await createResetToken(user.id);
    const link = `${appBaseUrl()}${resetPasswordPath(token)}`;
    await sendEmail({ to: input.email, ...buildResetEmail(user.username, link, input.language) });
  } catch (err) {
    // Never log the address or the link: the error message alone says what went wrong.
    console.error('Password reset email failed:', err instanceof Error ? err.message : err);
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
    return res.json(toOwnUser(user));
  } catch (err: any) {
    if (err?.name === 'ZodError') return res.status(400).json({ error: 'Invalid input', details: err.errors });
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// The admin's view of every account. Carries each email (decrypted) so an admin can set one
// for somebody who never entered it and has lost their password — see PATCH /users/:id.
const adminUserFields = { id: users.id, username: users.username, isAdmin: users.isAdmin, isTestAccount: users.isTestAccount, isLeaderboardUser: users.isLeaderboardUser, isComparisonUser: users.isComparisonUser, isLateAddition: users.isLateAddition, imageUrl: users.imageUrl, iconColor: users.iconColor, emailEncrypted: users.emailEncrypted };

authRouter.get('/users', requireAdmin, async (_req, res) => {
  try {
    const allUsers = await db
      .select(adminUserFields)
      .from(users)
      .orderBy(users.username);
    return res.json(allUsers.map(toOwnUser));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Change another account: the admin flags, and the email address.
 *
 * The email is the way back in for somebody who forgot their password without ever having
 * entered one: the admin sets it here, and with `sendResetLink` a reset link goes to it in
 * the same request — the normal "forgot password" email, one use and 30 minutes, like any
 * other. Changing the address voids links already sent to the old one.
 *
 * The save happens first. If the email then cannot be sent, the answer is a 502 that says
 * the address was saved, so the admin knows to retry the send rather than the save.
 */
authRouter.patch('/users/:id', requireAdmin, async (req, res) => {
  let input;
  try {
    input = AdminUpdateUserSchema.parse(req.body);
  } catch (err: any) {
    return res.status(400).json({ error: 'Invalid input', details: err?.errors });
  }
  const { email, sendResetLink, language, ...flags } = input;
  if (Object.keys(flags).length === 0 && email === undefined && !sendResetLink) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  let updated;
  try {
    const [before] = await db
      .select({ emailHash: users.emailHash })
      .from(users)
      .where(eq(users.id, req.params.id))
      .limit(1);
    if (!before) return res.status(404).json({ error: 'User not found' });

    const emailUpdate = email === undefined ? null : emailColumns(email);
    const changes = { ...flags, ...(emailUpdate ?? {}) };
    [updated] = Object.keys(changes).length
      ? await db.update(users).set(changes).where(eq(users.id, req.params.id)).returning(adminUserFields)
      : await db.select(adminUserFields).from(users).where(eq(users.id, req.params.id)).limit(1);
    // A reset link already sent to the old address must not outlive the change.
    if (emailUpdate && emailUpdate.emailHash !== before.emailHash) {
      await deleteResetTokensForUser(req.params.id);
    }
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(409).json({ error: 'Email already in use' });
    if (err instanceof EmailNotConfiguredError) {
      return res.status(503).json({ error: 'Email addresses cannot be saved right now. Try again later.' });
    }
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }

  const user = toOwnUser(updated);
  if (!sendResetLink) return res.json(user);

  if (!user.email) {
    return res.status(400).json({ error: 'This user has no email address to send a reset link to' });
  }
  try {
    const token = await createResetToken(user.id);
    const link = `${appBaseUrl()}${resetPasswordPath(token)}`;
    await sendEmail({ to: user.email, ...buildResetEmail(user.username, link, language) });
  } catch (err) {
    // Never log the address or the link: the error message alone says what went wrong.
    console.error('Admin password reset email failed:', err instanceof Error ? err.message : err);
    return res.status(502).json({ error: 'The email address was saved, but the reset email could not be sent.' });
  }
  return res.json({ ...user, resetLinkSent: true });
});
