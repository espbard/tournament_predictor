import { afterEach, describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'crypto';
import { decryptEmail, emailEncryptionConfigured, emailLookupHash, encryptEmail, EmailNotConfiguredError } from './emailCrypto';

const KEY = randomBytes(32).toString('base64');

afterEach(() => vi.unstubAllEnvs());

describe('email encryption', () => {
  it('round-trips, and the stored value does not contain the address', () => {
    vi.stubEnv('EMAIL_ENCRYPTION_KEY', KEY);
    const stored = encryptEmail('ola@example.com');
    expect(stored).not.toContain('ola');
    expect(stored).not.toContain('example');
    expect(decryptEmail(stored)).toBe('ola@example.com');
  });

  it('never produces the same ciphertext twice', () => {
    vi.stubEnv('EMAIL_ENCRYPTION_KEY', KEY);
    expect(encryptEmail('ola@example.com')).not.toBe(encryptEmail('ola@example.com'));
  });

  it('cannot be read with another key', () => {
    vi.stubEnv('EMAIL_ENCRYPTION_KEY', KEY);
    const stored = encryptEmail('ola@example.com');
    vi.stubEnv('EMAIL_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(decryptEmail(stored)).toBeNull();
  });

  it('rejects tampered data', () => {
    vi.stubEnv('EMAIL_ENCRYPTION_KEY', KEY);
    const [v, iv, tag, ct] = encryptEmail('ola@example.com').split('.');
    const flipped = Buffer.from(ct, 'base64url');
    flipped[0] ^= 1;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(decryptEmail([v, iv, tag, flipped.toString('base64url')].join('.'))).toBeNull();
  });

  it('treats a missing value as no email', () => {
    expect(decryptEmail(null)).toBeNull();
  });
});

describe('email lookup hash', () => {
  it('is stable for the same key and address, and keyed', () => {
    vi.stubEnv('EMAIL_ENCRYPTION_KEY', KEY);
    const a = emailLookupHash('ola@example.com');
    expect(emailLookupHash('ola@example.com')).toBe(a);
    expect(emailLookupHash('kari@example.com')).not.toBe(a);
    vi.stubEnv('EMAIL_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
    expect(emailLookupHash('ola@example.com')).not.toBe(a);
  });
});

describe('configuration', () => {
  it('refuses to work in production without a key', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('EMAIL_ENCRYPTION_KEY', '');
    expect(emailEncryptionConfigured()).toBe(false);
    expect(() => encryptEmail('ola@example.com')).toThrow(EmailNotConfiguredError);
    expect(() => emailLookupHash('ola@example.com')).toThrow(EmailNotConfiguredError);
  });

  it('uses a development key outside production', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('EMAIL_ENCRYPTION_KEY', '');
    expect(decryptEmail(encryptEmail('ola@example.com'))).toBe('ola@example.com');
  });

  it('rejects a key of the wrong length', () => {
    vi.stubEnv('EMAIL_ENCRYPTION_KEY', randomBytes(16).toString('base64'));
    expect(() => emailEncryptionConfigured()).toThrow(/32 bytes/);
  });
});
