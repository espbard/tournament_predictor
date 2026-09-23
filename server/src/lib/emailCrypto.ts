import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'crypto';

// Email addresses are stored encrypted (AES-256-GCM), never as readable text.
//
// Two values are kept per user:
//   email_encrypted  the address itself, encrypted with a fresh random IV each time, so the
//                    same address never looks the same twice. Only the app can read it back.
//   email_hash       an HMAC of the address, used to find the user on "forgot password" and
//                    to keep addresses unique. Keyed, so it cannot be reversed by hashing a
//                    list of known addresses without the key.
//
// Both keys are derived from one secret, EMAIL_ENCRYPTION_KEY (32 random bytes, base64):
//   openssl rand -base64 32
// Losing or changing that secret makes every stored address unreadable — users would have to
// enter theirs again. Nothing else breaks.

const VERSION = 'v1';

// Development only. Production refuses to handle email addresses without a real key.
const DEV_KEY = Buffer.alloc(32, 'tournament-predictor-dev-email-key');

interface Keys {
  encryption: Buffer;
  lookup: Buffer;
}

let cached: { cacheKey: string; keys: Keys | null } | null = null;

function loadKeys(): Keys | null {
  const secret = process.env.EMAIL_ENCRYPTION_KEY;
  const cacheKey = `${process.env.NODE_ENV}:${secret ?? ''}`;
  if (cached && cached.cacheKey === cacheKey) return cached.keys;

  let master: Buffer | null = null;
  if (secret) {
    const decoded = Buffer.from(secret, 'base64');
    if (decoded.length !== 32) {
      throw new Error('EMAIL_ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)');
    }
    master = decoded;
  } else if (process.env.NODE_ENV !== 'production') {
    master = DEV_KEY;
  }

  const keys = master
    ? {
        encryption: Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'email-encryption', 32)),
        lookup: Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'email-lookup', 32)),
      }
    : null;
  cached = { cacheKey, keys };
  return keys;
}

export class EmailNotConfiguredError extends Error {
  constructor(message = 'Email is not configured on this server') {
    super(message);
    this.name = 'EmailNotConfiguredError';
  }
}

function requireKeys(): Keys {
  const keys = loadKeys();
  if (!keys) throw new EmailNotConfiguredError();
  return keys;
}

/** True when addresses can be stored and read. Always true outside production. */
export function emailEncryptionConfigured(): boolean {
  return loadKeys() !== null;
}

/** Encrypts a normalized (trimmed, lowercased) address. Output: v1.<iv>.<tag>.<ciphertext>, base64url. */
export function encryptEmail(email: string): string {
  const { encryption } = requireKeys();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryption, iv);
  const ciphertext = Buffer.concat([cipher.update(email, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

/**
 * Reads an address back. Returns null for a value that cannot be decrypted (wrong key,
 * tampered data) rather than throwing, so one bad row cannot break the profile page.
 */
export function decryptEmail(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const keys = loadKeys();
  if (!keys) return null;
  try {
    const [version, iv, tag, ciphertext] = stored.split('.');
    if (version !== VERSION || !iv || !tag || !ciphertext) return null;
    const decipher = createDecipheriv('aes-256-gcm', keys.encryption, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    console.error('A stored email address could not be decrypted — was EMAIL_ENCRYPTION_KEY changed?');
    return null;
  }
}

/** The lookup value for a normalized address. Deterministic, keyed, not reversible. */
export function emailLookupHash(email: string): string {
  const { lookup } = requireKeys();
  return createHmac('sha256', lookup).update(email).digest('hex');
}
