import { createHash, randomBytes } from 'crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { db } from '../db/client';
import { passwordResetTokens } from '../db/schema';

// "Forgot password" links.
//
// The raw token only ever exists in the email; the database keeps its SHA-256. A token is
// good for RESET_TOKEN_TTL_MS and for one use, and asking for a new link voids older ones.

export const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

export function generateResetToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** The client-side route a reset link opens. */
export function resetPasswordPath(token: string): string {
  return `/reset-password/${token}`;
}

/**
 * The public URL of the app, used to build links in emails. Taken from configuration and
 * never from the request's Host header, which an attacker controls.
 */
export function appBaseUrl(): string {
  const url = process.env.APP_URL ?? process.env.CLIENT_URL ?? 'http://localhost:5173';
  return url.replace(/\/+$/, '');
}

/** Replaces any outstanding reset tokens for the user with a fresh one. Returns the raw token. */
export async function createResetToken(userId: string): Promise<string> {
  const token = generateResetToken();
  await db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, userId));
  await db.insert(passwordResetTokens).values({
    id: randomBytes(12).toString('base64url'),
    userId,
    tokenHash: hashResetToken(token),
    expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
  });
  return token;
}

/**
 * Marks the token used and returns its user, or null if it is unknown, expired or already
 * used. One conditional UPDATE, so two requests racing with the same link cannot both win.
 */
export async function consumeResetToken(token: string): Promise<string | null> {
  const [row] = await db
    .update(passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(and(
      eq(passwordResetTokens.tokenHash, hashResetToken(token)),
      isNull(passwordResetTokens.usedAt),
      gt(passwordResetTokens.expiresAt, new Date()),
    ))
    .returning({ userId: passwordResetTokens.userId });
  return row?.userId ?? null;
}

export async function deleteResetTokensForUser(userId: string): Promise<void> {
  await db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, userId));
}

export type EmailLanguage = 'en' | 'no' | 'de';

const COPY: Record<EmailLanguage, {
  subject: string;
  greeting: (username: string) => string;
  body: string;
  button: string;
  expiry: string;
  ignore: string;
}> = {
  en: {
    subject: 'Reset your password',
    greeting: (u) => `Hi ${u},`,
    body: 'Someone asked to reset the password for your Tournament Predictor account. Use the link below to choose a new one.',
    button: 'Choose a new password',
    expiry: 'The link works once and expires in 30 minutes.',
    ignore: "If you didn't ask for this, you can ignore this email. Your password stays the same.",
  },
  no: {
    subject: 'Tilbakestill passordet ditt',
    greeting: (u) => `Hei ${u},`,
    body: 'Noen har bedt om å tilbakestille passordet for Tournament Predictor-kontoen din. Bruk lenken under for å velge et nytt.',
    button: 'Velg nytt passord',
    expiry: 'Lenken virker én gang og utløper om 30 minutter.',
    ignore: 'Hvis det ikke var deg, kan du se bort fra denne e-posten. Passordet ditt forblir det samme.',
  },
  de: {
    subject: 'Passwort zurücksetzen',
    greeting: (u) => `Hallo ${u},`,
    body: 'Jemand hat angefordert, das Passwort deines Tournament-Predictor-Kontos zurückzusetzen. Über den Link unten kannst du ein neues wählen.',
    button: 'Neues Passwort wählen',
    expiry: 'Der Link funktioniert einmal und läuft in 30 Minuten ab.',
    ignore: 'Wenn du das nicht warst, kannst du diese E-Mail ignorieren. Dein Passwort bleibt unverändert.',
  },
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The reset email. Names the username too — someone who forgot the password may have forgotten that as well. */
export function buildResetEmail(username: string, link: string, language: EmailLanguage = 'en') {
  const c = COPY[language];
  const text = [c.greeting(username), '', c.body, '', link, '', c.expiry, c.ignore].join('\n');
  const u = escapeHtml(username);
  const l = escapeHtml(link);
  const html = `<p>${escapeHtml(c.greeting(username)).replace(u, `<strong>${u}</strong>`)}</p>
<p>${escapeHtml(c.body)}</p>
<p><a href="${l}" style="display:inline-block;padding:10px 16px;background:#111827;color:#ffffff;text-decoration:none;border-radius:6px">${escapeHtml(c.button)}</a></p>
<p style="font-size:13px;color:#6b7280">${escapeHtml(c.expiry)}<br>${escapeHtml(c.ignore)}</p>
<p style="font-size:12px;color:#9ca3af;word-break:break-all">${l}</p>`;
  return { subject: c.subject, text, html };
}
