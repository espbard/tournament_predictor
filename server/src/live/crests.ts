import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { liveTeams } from '../db/liveSchema';
import { isR2Configured, uploadBufferToR2 } from '../lib/r2';
import type { ProviderTeam } from './providers/types';

// ── Crest mirroring ───────────────────────────────────────────────────────────
//
// The provider serves team crests from crests.football-data.org, but this app's image
// proxy reads only from R2 (server/src/routes/images.ts) — a deliberate choice so that
// corporate firewalls blocking Cloudflare do not blank out every image. So each crest is
// downloaded once, stored in R2, and the team row rewritten to the /api/images/ URL.
//
// Everything here is best-effort. A crest that fails to mirror leaves the team pointing
// at the provider URL, which still renders for most users; it must never fail a sync.
//
// See docs/LIVE_TOURNAMENTS_PLAN.md §11.

/** Already-mirrored crests start with this, which is how re-mirroring is avoided. */
const PROXY_PREFIX = '/api/images/';

const MAX_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
/** Downloads in flight at once. Small: this runs alongside the provider's rate limit. */
const CONCURRENCY = 4;
/** Ceiling per sync, so a tournament with a broken crest host cannot stall every tick. */
const MAX_PER_SYNC = 60;

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export interface MirrorResult {
  mirrored: number;
  failed: number;
  skipped: number;
}

/** Extension from a URL path, ignoring any query string. Defaults to .png. */
export function extensionFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const dot = pathname.lastIndexOf('.');
    if (dot === -1) return '.png';
    const ext = pathname.slice(dot).toLowerCase();
    return CONTENT_TYPE_BY_EXT[ext] ? ext : '.png';
  } catch {
    return '.png';
  }
}

export function contentTypeFor(extension: string, headerValue: string | null): string {
  // Trust the server's own content type when it looks like an image; some CDNs serve
  // SVG with a charset suffix, which is fine to keep.
  if (headerValue && headerValue.startsWith('image/')) return headerValue;
  return CONTENT_TYPE_BY_EXT[extension] ?? 'image/png';
}

/** True for a URL we should mirror: an absolute http(s) URL we have not already stored. */
export function needsMirroring(crestUrl: string | null | undefined): boolean {
  if (!crestUrl) return false;
  if (crestUrl.startsWith(PROXY_PREFIX)) return false;
  return crestUrl.startsWith('http://') || crestUrl.startsWith('https://');
}

async function fetchCrest(url: string): Promise<{ buffer: Buffer; contentType: string; extension: string } | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    throw new Error(`crest too large (${declared} bytes)`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength === 0) throw new Error('empty response');
  // Re-check after download: content-length is optional and can lie.
  if (buffer.byteLength > MAX_BYTES) throw new Error(`crest too large (${buffer.byteLength} bytes)`);

  const extension = extensionFromUrl(url);
  return { buffer, contentType: contentTypeFor(extension, res.headers.get('content-type')), extension };
}

/**
 * Mirror any crest still pointing at the provider into R2.
 *
 * Called at the end of a structure sync. Teams already mirrored are skipped, so the
 * second and later syncs of a tournament do no network work at all.
 *
 * Note this never re-downloads a crest the provider has *changed*, because a mirrored
 * URL is indistinguishable from a current one. Crests change rarely; forcing a refresh
 * means clearing live_teams.crest_url and re-syncing.
 */
export async function mirrorTeamCrests(
  tournamentId: string,
  providerTeams: ProviderTeam[],
  teamIdByProviderId: Map<string, string>,
): Promise<MirrorResult> {
  const result: MirrorResult = { mirrored: 0, failed: 0, skipped: 0 };

  // Without R2 configured there is nowhere to put them; leaving the provider URL in
  // place is the correct degradation for a local dev environment.
  if (!isR2Configured()) {
    result.skipped = providerTeams.length;
    return result;
  }

  const stored = await db
    .select({ id: liveTeams.id, crestUrl: liveTeams.crestUrl })
    .from(liveTeams)
    .where(eq(liveTeams.liveTournamentId, tournamentId));
  const storedById = new Map(stored.map(t => [t.id, t.crestUrl]));

  const pending: Array<{ teamId: string; url: string }> = [];
  for (const team of providerTeams) {
    const teamId = teamIdByProviderId.get(team.providerTeamId);
    if (!teamId) continue;

    // The provider URL is what we download; the stored value tells us if we already did.
    if (!needsMirroring(team.crestUrl) || !needsMirroring(storedById.get(teamId))) {
      result.skipped++;
      continue;
    }
    pending.push({ teamId, url: team.crestUrl! });
  }

  const work = pending.slice(0, MAX_PER_SYNC);
  result.skipped += pending.length - work.length;

  // A small fixed-size worker pool rather than Promise.all over everything, so a 36-team
  // tournament does not open 36 sockets at once.
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor++;
      if (index >= work.length) return;
      const { teamId, url } = work[index];

      try {
        const fetched = await fetchCrest(url);
        if (!fetched) {
          result.failed++;
          continue;
        }
        const proxyUrl = await uploadBufferToR2(fetched.buffer, {
          folder: 'live-teams',
          contentType: fetched.contentType,
          extension: fetched.extension,
        });
        await db.update(liveTeams).set({ crestUrl: proxyUrl }).where(eq(liveTeams.id, teamId));
        result.mirrored++;
      } catch (err) {
        result.failed++;
        console.warn(
          `[live-sync] crest mirror failed for ${url}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, work.length) }, worker));
  return result;
}
