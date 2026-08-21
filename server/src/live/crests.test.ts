import { describe, expect, it } from 'vitest';
import { contentTypeFor, extensionFromUrl, needsMirroring } from './crests';

// The decisions that determine what gets downloaded and how it is stored. The download
// and upload themselves need network and R2, so they are exercised by a real sync rather
// than here.

describe('extensionFromUrl', () => {
  it('reads the extension from a provider crest URL', () => {
    expect(extensionFromUrl('https://crests.football-data.org/57.png')).toBe('.png');
    expect(extensionFromUrl('https://crests.football-data.org/770.svg')).toBe('.svg');
  });

  it('ignores a query string', () => {
    expect(extensionFromUrl('https://crests.football-data.org/57.png?v=2')).toBe('.png');
  });

  it('lowercases', () => {
    expect(extensionFromUrl('https://example.com/a.PNG')).toBe('.png');
  });

  it('falls back to .png for an unknown or missing extension', () => {
    expect(extensionFromUrl('https://example.com/crest')).toBe('.png');
    expect(extensionFromUrl('https://example.com/crest.bin')).toBe('.png');
  });

  it('falls back rather than throwing on a malformed URL', () => {
    expect(extensionFromUrl('not a url')).toBe('.png');
  });
});

describe('contentTypeFor', () => {
  it('prefers the server-declared image type', () => {
    expect(contentTypeFor('.png', 'image/webp')).toBe('image/webp');
  });

  // Some CDNs serve SVG as image/svg+xml; charset suffix included is still fine.
  it('keeps a charset suffix on a declared image type', () => {
    expect(contentTypeFor('.svg', 'image/svg+xml; charset=utf-8')).toBe('image/svg+xml; charset=utf-8');
  });

  it('ignores a non-image declared type and uses the extension', () => {
    expect(contentTypeFor('.svg', 'application/octet-stream')).toBe('image/svg+xml');
    expect(contentTypeFor('.png', 'text/html')).toBe('image/png');
  });

  it('falls back to png when nothing is known', () => {
    expect(contentTypeFor('.bin', null)).toBe('image/png');
  });
});

describe('needsMirroring', () => {
  it('accepts an absolute provider URL', () => {
    expect(needsMirroring('https://crests.football-data.org/57.png')).toBe(true);
    expect(needsMirroring('http://crests.football-data.org/57.png')).toBe(true);
  });

  // The idempotency guard: an already-mirrored crest must never be downloaded again.
  it('rejects a URL already pointing at our own proxy', () => {
    expect(needsMirroring('/api/images/live-teams/abc.png')).toBe(false);
  });

  it('rejects an empty or missing value', () => {
    expect(needsMirroring(null)).toBe(false);
    expect(needsMirroring(undefined)).toBe(false);
    expect(needsMirroring('')).toBe(false);
  });

  it('rejects anything that is not an absolute http(s) URL', () => {
    expect(needsMirroring('/static/crest.png')).toBe(false);
    expect(needsMirroring('data:image/png;base64,AAAA')).toBe(false);
  });
});
