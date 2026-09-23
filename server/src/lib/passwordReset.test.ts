import { describe, it, expect, vi } from 'vitest';

// The module talks to the database for token storage; these tests only cover the pure parts.
vi.mock('../db/client', () => ({ db: {} }));

import { appBaseUrl, buildResetEmail, generateResetToken, hashResetToken, resetPasswordPath } from './passwordReset';
import { ForgotPasswordSchema, RegisterSchema, UpdateEmailSchema } from '@tournament-predictor/shared';

describe('reset tokens', () => {
  it('are long, URL-safe and different every time', () => {
    const a = generateResetToken();
    const b = generateResetToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('are stored as a hash, never as themselves', () => {
    const token = generateResetToken();
    const hash = hashResetToken(token);
    expect(hash).toBe(hashResetToken(token));
    expect(hash).not.toContain(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('open the client reset page', () => {
    expect(resetPasswordPath('abc')).toBe('/reset-password/abc');
  });
});

describe('appBaseUrl', () => {
  it('comes from APP_URL without a trailing slash', () => {
    vi.stubEnv('APP_URL', 'https://example.com/');
    expect(appBaseUrl()).toBe('https://example.com');
    vi.unstubAllEnvs();
  });
});

describe('buildResetEmail', () => {
  it('contains the link and the username in every language', () => {
    for (const lang of ['en', 'no', 'de'] as const) {
      const mail = buildResetEmail('ola_n', 'https://example.com/reset-password/xyz', lang);
      expect(mail.text).toContain('https://example.com/reset-password/xyz');
      expect(mail.text).toContain('ola_n');
      expect(mail.html).toContain('href="https://example.com/reset-password/xyz"');
      expect(mail.html).toContain('<strong>ola_n</strong>');
    }
  });

  it('escapes HTML', () => {
    const mail = buildResetEmail('<b>x</b>', 'https://e.com/?a=1&b=2');
    expect(mail.html).not.toContain('<b>x</b>');
    expect(mail.html).toContain('a=1&amp;b=2');
  });
});

describe('email validation', () => {
  it('normalizes case and whitespace', () => {
    const parsed = RegisterSchema.parse({ username: 'ola', password: 'secret1', email: '  Ola@Example.COM ' });
    expect(parsed.email).toBe('ola@example.com');
  });

  it('treats a blank email as none', () => {
    expect(RegisterSchema.parse({ username: 'ola', password: 'secret1', email: '' }).email).toBeNull();
    expect(RegisterSchema.parse({ username: 'ola', password: 'secret1' }).email).toBeUndefined();
    expect(UpdateEmailSchema.parse({ email: '  ', currentPassword: 'x' }).email).toBeNull();
  });

  it('rejects something that is not an email', () => {
    expect(() => RegisterSchema.parse({ username: 'ola', password: 'secret1', email: 'not-an-email' })).toThrow();
    expect(() => ForgotPasswordSchema.parse({ email: '' })).toThrow();
  });
});
