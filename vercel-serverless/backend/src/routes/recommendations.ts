import { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { buildOnboardingSeedTracks } from '../lib/onboarding.js';

interface Track {
  videoId: string;
  title: string;
  artist: string;
  thumbnail: string;
  duration: number;
}

interface TopArtist {
  name: string;
  playCount: number;
  tracks: Track[];
}

interface Recommendations {
  recentlyPlayed: Track[];
  mostPlayed:     Track[];
  topArtists:     TopArtist[];
  forYou:         Track[];
}

function isUsableTrack(track: Track): boolean {
  const artist = track.artist?.trim().toLowerCase();
  return Boolean(
    track.videoId &&
    track.title &&
    artist &&
    artist !== 'unknown' &&
    artist !== 'unknown artist'
  );
}

function normalizeArtistName(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s*-\s*topic$/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesArtistPreference(track: Track, favoriteArtists: string[]): boolean {
  if (favoriteArtists.length === 0) return true;

  const trackArtist = normalizeArtistName(track.artist);
  if (!trackArtist) return false;

  return favoriteArtists.some((artist) => {
    const selected = normalizeArtistName(artist);
    return Boolean(
      selected &&
      (trackArtist === selected ||
        trackArtist.includes(selected) ||
        selected.includes(trackArtist))
    );
  });
}

async function ensureOnboardingSeeds(userId: string): Promise<Track[]> {
  const prefs = await prisma.userPreferences.findUnique({ where: { userId } });
  const favoriteArtists = prefs?.favoriteArtists || [];

  const existing = await prisma.userOnboardingPreferences.findUnique({
    where: { userId },
    select: { seedTracks: true },
  });

  const existingSeeds: Track[] = ((Array.isArray(existing?.seedTracks)
    ? existing!.seedTracks : []) as any[])
    .map(t => ({
      videoId:   t.videoId   || '',
      title:     t.title     || '',
      artist:    t.artist    || '',
      thumbnail: t.thumbnail || '',
      duration:  t.duration  || 0,
    }))
    .filter(isUsableTrack)
    .filter(track => matchesArtistPreference(track, favoriteArtists));

  if (existingSeeds.length >= 50) return existingSeeds;

  const generated = await buildOnboardingSeedTracks({
    favoriteLanguages: prefs?.favoriteLanguages || [],
    favoriteArtists,
    favoriteGenres: prefs?.favoriteGenres || [],
  }, 50);

  const seedTracks = generated
    .map(t => ({
      videoId: t.videoId,
      title: t.title,
      artist: t.artist,
      thumbnail: t.thumbnail || '',
      duration: t.duration || 0,
    }))
    .filter(isUsableTrack)
    .filter(track => matchesArtistPreference(track, favoriteArtists));

  await prisma.userOnboardingPreferences.upsert({
    where: { userId },
    create: {
      userId,
      favoriteLanguage: prefs?.favoriteLanguages?.[0] ?? null,
      favoriteArtists: prefs?.favoriteArtists || [],
      favoriteGenres: prefs?.favoriteGenres || [],
      seedTracks,
    },
    update: {
      favoriteLanguage: prefs?.favoriteLanguages?.[0] ?? null,
      favoriteArtists: prefs?.favoriteArtists || [],
      favoriteGenres: prefs?.favoriteGenres || [],
      seedTracks,
    },
  });

  if (seedTracks.length > 0) {
    await prisma.$transaction(seedTracks.map(track =>
      prisma.recommendation.upsert({
        where: { userId_trackId: { userId, trackId: track.videoId } },
        update: {
          title: track.title,
          artist: track.artist,
          thumbnail: track.thumbnail,
          duration: track.duration,
          updatedAt: new Date(),
        },
        create: {
          userId,
          trackId: track.videoId,
          title: track.title,
          artist: track.artist,
          thumbnail: track.thumbnail,
          duration: track.duration,
          source: 'onboarding',
          score: 0.35,
          playCount: 0,
        },
      })
    ));
  }

  return seedTracks;
}

// ─── Scoring ────────────────────────────────────────────────────────────────

/**
 * Compute a time-decayed, like-boosted effective score from raw stored signals.
 * Never stored — computed at query time so stale rows auto-correct every refresh.
 *
 *   effectiveScore = cappedRawScore × recencyFactor × likeMultiplier
 *
 *   recencyFactor:  exp(-daysSincePlay / 45)  → full weight today, ~½ after 30d
 *   likeMultiplier: 1.5 if explicitly liked
 *   cappedRawScore: capped at 20 to prevent unbounded accumulation
 */
function effectiveScore(rec: {
  score:        number;
  isLiked:      boolean;
  lastPlayedAt: Date | null;
}): number {
  const daysSince = rec.lastPlayedAt
    ? (Date.now() - rec.lastPlayedAt.getTime()) / 86_400_000
    : 365;

  const recencyFactor   = Math.exp(-daysSince / 45);          // half-life ~31d
  const likeMultiplier  = rec.isLiked ? 1.5 : 1.0;
  const cappedScore     = Math.min(rec.score, 20);

  return cappedScore * recencyFactor * likeMultiplier;
}

// ─── Diversity helpers ───────────────────────────────────────────────────────

/** Add tracks to target without exceeding perArtistCap or total limit. */
function fill(
  target:        Track[],
  seen:          Set<string>,
  artistCount:   Map<string, number>,
  candidates:    Track[],
  slots:         number,
  perArtistCap:  number,
): void {
  for (const t of candidates) {
    if (target.length >= seen.size + slots) break; // slots filled
    if (seen.has(t.videoId)) continue;
    const ac = artistCount.get(t.artist) ?? 0;
    if (ac >= perArtistCap) continue;
    seen.add(t.videoId);
    artistCount.set(t.artist, ac + 1);
    target.push(t);
  }
}

export default async function recommendations(fastify: FastifyInstance) {
  /**
   * GET /recommendations
   *
   * Diversity-first recommendation engine.
   *
   * Signal sources (all from existing DB columns — no new tables):
   *   • Recommendation.score         → raw accumulated play weight
   *   • Recommendation.lastPlayedAt  → recency decay
   *   • Recommendation.isLiked       → explicit preference boost
   *   • Recommendation.playCount     → for artist tier classification
   *   • PlayHistory                  → recentlyPlayed + topArtists
   *   • UserOnboardingPreferences    → cold-start seeds (always mixed in)
   *
   * forYou diversity budget (20 tracks, max 3 per artist):
   *   40% (8)  → primary artists  (≥4 plays — user's established taste)
   *   30% (6)  → secondary artists (1–3 plays — emerging preferences)
   *   20% (4)  → onboarding seeds (fresh / serendipitous content)
   *   10% (2)  → exploration      (cold tracks: >14d since last play)
   *
   * Anti-feedback-loop guarantees:
   *   • Max 3 tracks per artist in forYou
   *   • Secondary artists always get slots even if primary dominates
   *   • Seeds always present until overridden by diversity budget
   *   • Exploration ensures low-played tracks resurface
   */
  fastify.get('/', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    const userId = (request.user as any).id;

    // ─── 1. Fetch all recommendation signals in ONE query ────────────────────
    // Exclude Unknown/Unknown Artist — these are pre-normalization malformed rows
    // that should not contribute to affinity scoring or diversity pools.
    const allRecs = await prisma.recommendation.findMany({
      where:  {
        userId,
        NOT: { artist: { in: ['Unknown', 'Unknown Artist', ''] } }
      },
      select: {
        trackId:      true,
        title:        true,
        artist:       true,
        thumbnail:    true,
        duration:     true,
        score:        true,
        playCount:    true,
        lastPlayedAt: true,
        isLiked:      true,
        source:       true,
      },
    });

    // Compute effective score for each track (recency + like weighted)
    type RecRow = (typeof allRecs)[number] & { effScore: number };
    const scored: RecRow[] = allRecs
      .map((r: (typeof allRecs)[number]): RecRow => ({ ...r, effScore: effectiveScore(r) }))
      .sort((a: RecRow, b: RecRow) => b.effScore - a.effScore);

    const toTrack = (r: typeof scored[number]): Track => ({
      videoId:   r.trackId,
      title:     r.title,
      artist:    r.artist,
      thumbnail: r.thumbnail || '',
      duration:  r.duration  || 0,
    });

    // ─── 2. Recently played (from PlayHistory — chronological, not scored) ───
    const recentPlays = await prisma.playHistory.findMany({
      where:   {
        userId,
        NOT: { artist: { in: ['Unknown', 'Unknown Artist', ''] } }
      },
      orderBy: { playedAt: 'desc' },
      take:    60,
      select:  { trackId: true, title: true, artist: true, thumbnail: true, duration: true },
    });

    const recentlyPlayed: Track[] = Array.from(
      new Map(recentPlays.map((p: any) => [p.trackId, {
        videoId:   p.trackId,
        title:     p.title,
        artist:    p.artist,
        thumbnail: p.thumbnail || '',
        duration:  p.duration  || 0,
      }])).values()
    ).slice(0, 10) as Track[];

    // ─── 3. Most played — effective score, NOT raw playCount ─────────────────
    // Capped at 10, using our decay-adjusted effectiveScore so:
    //   • Autoplay loops don't dominate (recency decay normalises them)
    //   • Liked tracks surface higher (likeMultiplier)
    const mostPlayed: Track[] = scored.slice(0, 10).map(toTrack);

    // ─── 4. Top artists (from PlayHistory, grouped by raw count) ─────────────
    // Exclude "Unknown" / "Unknown Artist" from groupBy — these are malformed
    // tracks from before normalization was applied and must not pollute affinity.
    const topArtistsRaw = await prisma.playHistory.groupBy({
      by:      ['artist'],
      where:   {
        userId,
        NOT: {
          artist: { in: ['Unknown', 'Unknown Artist', ''] }
        }
      },
      _count:  { artist: true },
      orderBy: { _count: { artist: 'desc' } },
      take:    5,
    });

    const topArtistNames = topArtistsRaw.map((a: any) => a.artist);
    const artistTracks = topArtistNames.length > 0
      ? await prisma.playHistory.findMany({
          where:   { userId, artist: { in: topArtistNames } },
          orderBy: { playedAt: 'desc' },
          select:  { trackId: true, title: true, artist: true, thumbnail: true, duration: true },
        })
      : [];

    const tracksByArtist = new Map<string, Track[]>();
    for (const t of artistTracks) {
      if (!tracksByArtist.has(t.artist)) tracksByArtist.set(t.artist, []);
      const list = tracksByArtist.get(t.artist)!;
      if (list.length < 8 && !list.some(x => x.videoId === t.trackId)) {
        list.push({ videoId: t.trackId, title: t.title, artist: t.artist, thumbnail: t.thumbnail || '', duration: t.duration || 0 });
      }
    }

    const topArtists: TopArtist[] = topArtistsRaw.map((a: any) => ({
      name:      a.artist,
      playCount: a._count.artist,
      tracks:    tracksByArtist.get(a.artist) || [],
    }));

    // ─── 5. Diversity-protected forYou ───────────────────────────────────────
    const now = Date.now();
    const userPrefs = await prisma.userPreferences.findUnique({
      where: { userId },
      select: { favoriteArtists: true },
    });
    const favoriteArtists = userPrefs?.favoriteArtists || [];

    // Tier artists by play depth:
    //   primary   → ≥4 plays (established taste)
    //   secondary → 1–3 plays (emerging, avoid lock-in)
    const artistPlayCount = new Map<string, number>();
    for (const r of allRecs) {
      artistPlayCount.set(r.artist, (artistPlayCount.get(r.artist) ?? 0) + r.playCount);
    }

    const primaryArtists   = new Set<string>();
    const secondaryArtists = new Set<string>();
    for (const [artist, count] of artistPlayCount) {
      if (count >= 4) primaryArtists.add(artist);
      else            secondaryArtists.add(artist);
    }

    // Seed tracks (onboarding cold-start)
    const seedTracks = await ensureOnboardingSeeds(userId);
    const seedTrackIds = new Set(seedTracks.map(track => track.videoId));

    // Classify scored tracks into pools
    const primaryPool:   Track[] = [];
    const secondaryPool: Track[] = [];
    const explorePool:   Track[] = []; // Not played in 14+ days → fresh resurfacing

    const recentlyPlayedIds = new Set(recentlyPlayed.map(t => t.videoId));

    for (const r of scored) {
      if (recentlyPlayedIds.has(r.trackId)) continue; // skip just-played tracks
      if (
        favoriteArtists.length > 0 &&
        r.source === 'onboarding' &&
        !seedTrackIds.has(r.trackId)
      ) {
        continue;
      }

      const daysSince = r.lastPlayedAt
        ? (now - r.lastPlayedAt.getTime()) / 86_400_000
        : 365;

      const track = toTrack(r);
      if (daysSince >= 14) {
        explorePool.push(track);       // Stale → exploration candidate
      } else if (primaryArtists.has(r.artist)) {
        primaryPool.push(track);
      } else if (secondaryArtists.has(r.artist)) {
        secondaryPool.push(track);
      }
    }

    // Diversity budget: 50 tracks, strict max per artist to avoid a single
    // selected artist taking over when the user provided multiple artists.
    const LIMIT         = 50;
    const MAX_PER_ARTIST = Math.max(10, Math.ceil(LIMIT / Math.max(1, topArtists.length || seedTracks.length ? new Set(seedTracks.map(t => t.artist)).size : 1)));
    const totalPlayCount = allRecs.reduce((sum: number, rec: (typeof allRecs)[number]) => sum + rec.playCount, 0);
    const SLOTS = totalPlayCount < 5
      ? {
          primary:   0,   // cold start: selected-artist onboarding seeds dominate
          secondary: 0,
          seeds:     50,
          explore:   0,
        } as const
      : totalPlayCount < 20
      ? {
          primary:   10,  // warm-up: begin shifting from onboarding to behavior
          secondary: 10,
          seeds:     25,
          explore:   5,
        } as const
      : {
          primary:   20,  // active users: 40% recent affinity artists
          secondary: 15,  // 30% related/emerging artists and tracks
          seeds:     10,  // 20% onboarding preferences
          explore:   5,   // 10% exploration/discovery
        } as const;

    const forYou:      Track[] = [];
    const forYouSeen = new Set<string>();
    const artistTally = new Map<string, number>();

    // Helper: push into forYou respecting seen + per-artist cap
    const pushSlots = (pool: Track[], slots: number) => {
      let added = 0;
      for (const t of pool) {
        if (added >= slots || forYou.length >= LIMIT) break;
        if (forYouSeen.has(t.videoId)) continue;
        const ac = artistTally.get(t.artist) ?? 0;
        if (ac >= MAX_PER_ARTIST) continue;
        forYouSeen.add(t.videoId);
        artistTally.set(t.artist, ac + 1);
        forYou.push(t);
        added++;
      }
    };

    pushSlots(primaryPool,   SLOTS.primary);
    pushSlots(secondaryPool, SLOTS.secondary);
    pushSlots(seedTracks,    SLOTS.seeds);
    pushSlots(explorePool,   SLOTS.explore);

    // Backfill any remaining slots with best available (in priority order)
    // so forYou never has gaps when one pool is empty (new users, etc.)
    if (forYou.length < LIMIT) {
      pushSlots(seedTracks,    LIMIT);  // seeds are freshest for new users
      if (totalPlayCount >= 5 || favoriteArtists.length === 0) {
        pushSlots(primaryPool,   LIMIT);
        pushSlots(secondaryPool, LIMIT);
        pushSlots(explorePool,   LIMIT);
      }
    }

    return {
      recommendations: {
        recentlyPlayed,
        mostPlayed,
        topArtists,
        forYou,
      } satisfies Recommendations,
    };
  });
}
