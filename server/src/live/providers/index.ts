import type { LiveProviderId } from '@tournament-predictor/shared';
import { BigBallsProvider } from './bigBalls';
import { FootballDataProvider } from './footballData';
import type { LiveProvider } from './types';

// ── Provider registry ─────────────────────────────────────────────────────────
//
// Adding a provider is one adapter file plus one entry here. Adapters are created lazily
// and cached, so importing this module does not require an API key to be configured —
// which matters because server/src/index.ts imports the live routes at boot whether or
// not any live tournament exists.

export * from './types';
export { BigBallsProvider } from './bigBalls';
export { FootballDataProvider } from './footballData';
export { RateLimiter } from './rateLimiter';

const factories: Record<LiveProviderId, () => LiveProvider> = {
  football_data: () => new FootballDataProvider(),
  // Fixtures only — see the header of bigBalls.ts for what its schema cannot express.
  big_balls: () => new BigBallsProvider(),
};

const cache = new Map<LiveProviderId, LiveProvider>();

export function getProvider(id: LiveProviderId): LiveProvider {
  const cached = cache.get(id);
  if (cached) return cached;

  const factory = factories[id];
  if (!factory) throw new Error(`Unknown live provider: ${id}`);

  const provider = factory();
  cache.set(id, provider);
  return provider;
}

/** Test seam: drop cached adapters so a fresh one picks up changed configuration. */
export function resetProviderCache(): void {
  cache.clear();
}
