import { describe, expect, it } from 'vitest';
import { AdminUpdateUserSchema } from '@tournament-predictor/shared';

// The body of PATCH /api/auth/users/:id — an admin editing somebody else's account.
describe('AdminUpdateUserSchema', () => {
  it('stores an email trimmed and lowercased, like the user-facing forms', () => {
    expect(AdminUpdateUserSchema.parse({ email: '  Ola@Example.COM ' }).email).toBe('ola@example.com');
  });

  it('reads a blank email as clearing it', () => {
    expect(AdminUpdateUserSchema.parse({ email: '   ' }).email).toBeNull();
    expect(AdminUpdateUserSchema.parse({ email: null }).email).toBeNull();
  });

  it('leaves the email alone when it is not sent', () => {
    expect(AdminUpdateUserSchema.parse({ isTestAccount: true })).not.toHaveProperty('email');
  });

  it('rejects an address that is not one', () => {
    expect(() => AdminUpdateUserSchema.parse({ email: 'not-an-email' })).toThrow();
  });

  it('takes the reset request and its language alongside the address', () => {
    expect(
      AdminUpdateUserSchema.parse({ email: 'a@b.no', sendResetLink: true, language: 'no' }),
    ).toEqual({ email: 'a@b.no', sendResetLink: true, language: 'no' });
    expect(() => AdminUpdateUserSchema.parse({ language: 'fr' })).toThrow();
  });
});
