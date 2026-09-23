import { afterEach, describe, it, expect, vi } from 'vitest';
import { sendEmail } from './email';
import { EmailNotConfiguredError } from './emailCrypto';

const message = {
  to: 'ola@example.com',
  subject: 'Reset',
  text: 'https://example.com/reset-password/secret-token',
  html: '<a href="https://example.com/reset-password/secret-token">x</a>',
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('sendEmail without Brevo configured', () => {
  it('in production: throws and prints nothing', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('BREVO_API_KEY', '');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(sendEmail(message)).rejects.toThrow(EmailNotConfiguredError);
    await expect(sendEmail(message)).rejects.not.toThrow(/ola@example|secret-token/);
    expect(log).not.toHaveBeenCalled();
  });

  it('in development: prints instead of sending', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('BREVO_API_KEY', '');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await sendEmail(message);
    expect(log.mock.calls[0][0]).toContain('secret-token');
  });
});

describe('sendEmail when Brevo rejects', () => {
  it('keeps the address out of the error', async () => {
    vi.stubEnv('BREVO_API_KEY', 'key');
    vi.stubEnv('EMAIL_FROM', 'from@example.com');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 'invalid_parameter', message: 'email ola@example.com is not valid' }), { status: 400 }),
    );
    await expect(sendEmail(message)).rejects.toThrow('Brevo responded 400 (invalid_parameter)');
  });
});
