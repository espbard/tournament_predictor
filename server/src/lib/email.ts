// Transactional email through Brevo's HTTP API (https://developers.brevo.com).
//
// HTTP rather than SMTP because Railway blocks outbound SMTP on its Hobby plan. The free
// Brevo plan allows 300 emails a day, far more than this app will ever send.
//
// Without BREVO_API_KEY (local development) nothing is sent: the email is printed to the
// server console instead, so the reset flow can still be walked through end to end.

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export async function sendEmail(message: EmailMessage): Promise<void> {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.log(`[email] BREVO_API_KEY not set — not sending. To: ${message.to}\nSubject: ${message.subject}\n\n${message.text}`);
    return;
  }

  const senderEmail = process.env.EMAIL_FROM;
  if (!senderEmail) throw new Error('EMAIL_FROM is not set');

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
    const body = await res.text().catch(() => '');
    throw new Error(`Brevo responded ${res.status}: ${body.slice(0, 500)}`);
  }
}
