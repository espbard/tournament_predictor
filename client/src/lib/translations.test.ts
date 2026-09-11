import { describe, it, expect } from 'vitest';
import translations from './translations';

/**
 * Every string the page shows comes through here, so this is the one place to hold the
 * line on punctuation the copy does not use.
 */
function walk(node: unknown, path: string, visit: (value: string, at: string) => void): void {
  if (typeof node === 'string') return visit(node, path);
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      walk(value, path ? `${path}.${key}` : key, visit);
    }
  }
}

describe('translations', () => {
  it('uses no em dash anywhere in the copy', () => {
    const offenders: string[] = [];
    walk(translations, '', (value, at) => {
      if (value.includes('—')) offenders.push(`${at}: ${value}`);
    });
    expect(offenders).toEqual([]);
  });
});
