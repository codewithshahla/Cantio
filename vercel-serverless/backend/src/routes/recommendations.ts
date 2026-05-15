import { FastifyInstance } from 'fastify';
import { z } from 'zod';
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
  mostPlayed: Track[];
  topArtists: TopArtist[];
}

export default async function recommendations(fastify: FastifyInstance) {
  // Get personalized recommendations for logged-in users
  fastify.get('/', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    const userId = (request.user as any).id;

    // Get recently played (last 10 unique tracks)
    const recentPlays = await prisma.playHistory.findMany({
      where: { userId },
      orderBy: { playedAt: 'desc' },
      take: 50, // Get more to filter duplicates
      select: {
        trackId: true,
        title: true,
        artist: true,
        thumbnail: true,
      }
    });

    // Deduplicate by trackId
    const recentlyPlayedRaw = Array.from(
      new Map(recentPlays.map((p: any) => [p.trackId, {
        videoId: p.trackId,
        title: p.title,
        artist: p.artist,
        thumbnail: p.thumbnail || '',
        duration: 0 // Duration not stored in history
      }])).values()
    ).slice(0, 10);
    
    const recentlyPlayed: Track[] = recentlyPlayedRaw as Track[];

    // Get most played tracks (aggregate by trackId)
    const playCountsRaw = await prisma.playHistory.groupBy({
      by: ['trackId', 'title', 'artist', 'thumbnail'],
      where: { userId },
      _count: { trackId: true },
      orderBy: { _count: { trackId: 'desc' } },
      take: 10
    });

    const mostPlayed: Track[] = playCountsRaw.map((p: any) => ({
      videoId: p.trackId,
      title: p.title,
      artist: p.artist,
      thumbnail: p.thumbnail || '',
      duration: 0
    }));

    // Get top artists (aggregate by artist, get play count)
    const topArtistsRaw = await prisma.playHistory.groupBy({
      by: ['artist'],
      where: { userId },
      _count: { artist: true },
      orderBy: { _count: { artist: 'desc' } },
      take: 5
    });

    // Batch fetch all tracks for top artists in ONE query (avoid N+1)
    const topArtistNames = topArtistsRaw.map((a: any) => a.artist);
    const allArtistTracks = topArtistNames.length > 0 
      ? await prisma.playHistory.findMany({
          where: {
            userId,
            artist: { in: topArtistNames }
          },
          orderBy: { playedAt: 'desc' },
          select: {
            trackId: true,
            title: true,
            artist: true,
            thumbnail: true,
          }
        })
      : [];

    // Group tracks by artist
    const tracksByArtist = new Map<string, Track[]>();
    for (const t of allArtistTracks) {
      const track: Track = {
        videoId: t.trackId,
        title: t.title,
        artist: t.artist,
        thumbnail: t.thumbnail || '',
        duration: 0
      };
      
      if (!tracksByArtist.has(t.artist)) {
        tracksByArtist.set(t.artist, []);
      }
      
      // Deduplicate by trackId within artist
      const artistTracks = tracksByArtist.get(t.artist)!;
      if (!artistTracks.some(at => at.videoId === track.videoId)) {
        if (artistTracks.length < 8) {
          artistTracks.push(track);
        }
      }
    }

    // Build top artists array
    const topArtists: TopArtist[] = topArtistsRaw.map((artistGroup: any) => ({
      name: artistGroup.artist,
      playCount: artistGroup._count.artist,
      tracks: tracksByArtist.get(artistGroup.artist) || []
    }));

    const hasHistory = recentlyPlayed.length > 0 || mostPlayed.length > 0 || topArtists.length > 0;

    if (!hasHistory) {
      const preferences = await prisma.userOnboardingPreferences.findUnique({
        where: { userId }
      });

      const seedTracksRaw = Array.isArray(preferences?.seedTracks)
        ? preferences?.seedTracks
        : [];

      const seedTracks: Track[] = seedTracksRaw
        .map((track: any) => ({
          videoId: track.videoId,
          title: track.title,
          artist: track.artist,
          thumbnail: track.thumbnail || '',
          duration: track.duration || 0
        }))
        .filter((track: Track) => Boolean(track.videoId && track.title && track.artist));

      const artistsMap = new Map<string, Track[]>();
      for (const track of seedTracks) {
        if (!artistsMap.has(track.artist)) {
          artistsMap.set(track.artist, []);
        }
        const list = artistsMap.get(track.artist)!;
        if (!list.some(t => t.videoId === track.videoId)) {
          list.push(track);
        }
      }

      const seededTopArtists: TopArtist[] = Array.from(artistsMap.entries()).map(([name, tracks]) => ({
        name,
        playCount: tracks.length,
        tracks: tracks.slice(0, 8)
      }));

      return {
        recommendations: {
          recentlyPlayed: [],
          mostPlayed: seedTracks.slice(0, 10),
          topArtists: seededTopArtists.slice(0, 5)
        }
      };
    }

    return { recommendations: { recentlyPlayed, mostPlayed, topArtists } };
  });
}
