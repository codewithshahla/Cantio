import { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';

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
  forYou:         Track[];   // Blended: onboarding seeds + usage-driven discoveries
}

export default async function recommendations(fastify: FastifyInstance) {
  /**
   * GET /recommendations
   *
   * Signal priority (blended, not gated):
   *   1. PlayHistory  → recentlyPlayed, topArtists
   *   2. Recommendation table (scored) → mostPlayed
   *   3. UserOnboardingPreferences.seedTracks → forYou (always present initially,
   *      gradually replaced by usage-driven tracks as history deepens)
   *
   * The onboarding seed tracks are ALWAYS included in forYou until the user
   * has enough real history (≥30 played tracks) to crowd them out naturally.
   * This means new users see relevant content immediately, and returning users
   * see increasingly personalised content over time.
   */
  fastify.get('/', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    const userId = (request.user as any).id;

    // ─── 1. Recently played (last 10 unique tracks from PlayHistory) ──────────
    const recentPlays = await prisma.playHistory.findMany({
      where: { userId },
      orderBy: { playedAt: 'desc' },
      take: 60,
      select: { trackId: true, title: true, artist: true, thumbnail: true, duration: true }
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

    // ─── 2. Most played — use the Recommendation scored aggregate ─────────────
    // The Recommendation table is updated on every play (history.ts POST /history)
    // with score += 0.5 and playCount++, giving us a decay-free preference model.
    const scoredTracks = await prisma.recommendation.findMany({
      where:   { userId },
      orderBy: [{ score: 'desc' }, { playCount: 'desc' }],
      take:    20,
      select:  { trackId: true, title: true, artist: true, thumbnail: true, duration: true, playCount: true }
    });

    const mostPlayed: Track[] = scoredTracks.map((t: any) => ({
      videoId:   t.trackId,
      title:     t.title,
      artist:    t.artist,
      thumbnail: t.thumbnail || '',
      duration:  t.duration  || 0,
    }));

    // ─── 3. Top artists (from PlayHistory, grouped by artist) ─────────────────
    const topArtistsRaw = await prisma.playHistory.groupBy({
      by:      ['artist'],
      where:   { userId },
      _count:  { artist: true },
      orderBy: { _count: { artist: 'desc' } },
      take:    5,
    });

    const topArtistNames = topArtistsRaw.map((a: any) => a.artist);
    const artistTracks = topArtistNames.length > 0
      ? await prisma.playHistory.findMany({
          where:   { userId, artist: { in: topArtistNames } },
          orderBy: { playedAt: 'desc' },
          select:  { trackId: true, title: true, artist: true, thumbnail: true, duration: true }
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

    // ─── 4. For You — ALWAYS blend onboarding seeds with usage ───────────────
    // Strategy:
    //   • Always fetch onboarding seed tracks (initial cold-start signal).
    //   • If user has enough history (≥30 plays), weight usage-driven tracks
    //     higher and seeds lower, eventually phasing seeds out after ≥100 plays.
    //   • If minimal history, seeds are shown prominently.
    //
    // This ensures new users see relevant content immediately and returning users
    // see increasingly personalised "For You" without ever showing a blank state.

    const totalPlayCount = await prisma.playHistory.count({ where: { userId } });

    // Fetch onboarding seed tracks
    const onboarding = await prisma.userOnboardingPreferences.findUnique({
      where:  { userId },
      select: { seedTracks: true }
    });

    const seedTracksRaw = Array.isArray(onboarding?.seedTracks) ? onboarding!.seedTracks : [];
    const seedTracks: Track[] = (seedTracksRaw as any[])
      .map(t => ({
        videoId:   t.videoId   || '',
        title:     t.title     || '',
        artist:    t.artist    || '',
        thumbnail: t.thumbnail || '',
        duration:  t.duration  || 0,
      }))
      .filter(t => t.videoId && t.title && t.artist);

    // Build usage-driven "For You" candidates:
    // top-scored tracks from Recommendation table that haven't been played recently
    const recentIds = new Set(recentlyPlayed.map(t => t.videoId));
    const usageDriven: Track[] = scoredTracks
      .filter((t: any) => !recentIds.has(t.trackId))
      .map((t: any) => ({
        videoId:   t.trackId,
        title:     t.title,
        artist:    t.artist,
        thumbnail: t.thumbnail || '',
        duration:  t.duration  || 0,
      }));

    // Blend ratio: as usage grows, seeds phase out
    //   0–30 plays:   100% seeds, 0% usage-driven
    //   30–100 plays: seeds fade, usage-driven grows
    //   100+ plays:   ~0% seeds, 100% usage-driven (seeds only if usage < 10 tracks)
    const SEED_PHASE_OUT_START = 30;
    const SEED_PHASE_OUT_END   = 100;
    const FORYOU_LIMIT         = 20;

    let forYou: Track[];
    const allForYouIds = new Set<string>();

    if (totalPlayCount >= SEED_PHASE_OUT_END && usageDriven.length >= 10) {
      // Veteran user — usage-driven only
      forYou = usageDriven.slice(0, FORYOU_LIMIT);
    } else if (totalPlayCount >= SEED_PHASE_OUT_START && usageDriven.length > 0) {
      // Growing user — interleave seeds and usage-driven
      const usageWeight = Math.min(1, (totalPlayCount - SEED_PHASE_OUT_START) / (SEED_PHASE_OUT_END - SEED_PHASE_OUT_START));
      const usageSlots  = Math.round(FORYOU_LIMIT * usageWeight);
      const seedSlots   = FORYOU_LIMIT - usageSlots;

      forYou = [];
      for (const t of usageDriven.slice(0, usageSlots)) {
        if (!allForYouIds.has(t.videoId)) { allForYouIds.add(t.videoId); forYou.push(t); }
      }
      for (const t of seedTracks.slice(0, seedSlots)) {
        if (!allForYouIds.has(t.videoId)) { allForYouIds.add(t.videoId); forYou.push(t); }
      }
    } else {
      // New user — seeds dominate, sprinkle usage-driven if available
      forYou = [];
      for (const t of seedTracks) {
        if (!allForYouIds.has(t.videoId)) { allForYouIds.add(t.videoId); forYou.push(t); }
        if (forYou.length >= FORYOU_LIMIT) break;
      }
      for (const t of usageDriven) {
        if (!allForYouIds.has(t.videoId)) { allForYouIds.add(t.videoId); forYou.push(t); }
        if (forYou.length >= FORYOU_LIMIT) break;
      }
    }

    return {
      recommendations: {
        recentlyPlayed,
        mostPlayed,
        topArtists,
        forYou,
      } satisfies Recommendations
    };
  });
}
