// Transactional email through Brevo's HTTP API (https://developers.brevo.com).
//
// HTTP rather than SMTP because Railway blocks outbound SMTP on its Hobby plan. The free
// Brevo plan allows 300 emails a day, far more than this app will ever send.
//
// In development without BREVO_API_KEY nothing is sent: the email is printed to the server
// console instead, so the reset flow can still be walked through end to end. In production
// that fallback is off — a reset email holds a working link, and must never end up in logs.

import { EmailNotConfiguredError } from './emailCrypto';

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Names the email settings production is missing. Empty when everything is set. */
export function missingEmailSettings(): string[] {
  return ['BREVO_API_KEY', 'EMAIL_FROM', 'EMAIL_ENCRYPTION_KEY'].filter((name) => !process.env[name]);
}

export async function sendEmail(message: EmailMessage): Promise<void> {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new EmailNotConfiguredError('BREVO_API_KEY is not set — email not sent');
    }
    console.log(`[email] Development: BREVO_API_KEY not set, printing instead of sending.\nTo: ${message.to}\nSubject: ${message.subject}\n\n${message.text}`);
    return;
  }

  const senderEmail = process.env.EMAIL_FROM;
  if (!senderEmail) throw new EmailNotConfiguredError('EMAIL_FROM is not set — email not sent');

  const res = await fetch(BREVO_URL, {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { email: senderEmail, name: process.env.EMAIL_FROM_NAME || 'Tournament Predictor' },
      to: [{ email: message.to }],
      subject: message.subject,
      textContent: message.text,
      htmlContent: message.html,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    // Only Brevo's error code goes in the message: its free-text message can quote the
    // recipient address back, and this error is logged.
    const body = (await res.json().catch(() => null)) as { code?: unknown } | null;
    const code = typeof body?.code === 'string' ? body.code : 'unknown';
    throw new Error(`Brevo responded ${res.status} (${code})`);
  }
}
