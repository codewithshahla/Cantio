import { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { z } from 'zod';
import { normalizeTrack, type VideoResult } from '../lib/youtube.js';

const syncTrackSchema = z.object({
  videoId: z.string(),
  title: z.string(),
  artist: z.string(),
  thumbnail: z.string(),
  duration: z.number(),
});

const syncDataSchema = z.object({
  likes: z.array(syncTrackSchema),
  history: z.array(syncTrackSchema),
});

function normalizeSyncTrack(track: z.infer<typeof syncTrackSchema>): VideoResult | null {
  const normalized = normalizeTrack({
    id: track.videoId,
    title: track.title,
    author: { name: track.artist },
    thumbnail: track.thumbnail ? { url: track.thumbnail } : undefined,
    duration: track.duration ? { seconds: track.duration } : undefined,
  });

  const artist = normalized?.artist.trim().toLowerCase();
  if (!normalized || !artist || artist === 'unknown' || artist === 'unknown artist') {
    return null;
  }

  return normalized;
}

export default async function syncRoutes(fastify: FastifyInstance) {
  // Sync local IndexedDB data to cloud database
  fastify.post('/', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    try {
      const body = syncDataSchema.parse(request.body);
      const userId = (request.user as any).id;

      let likesSynced = 0;
      let historySynced = 0;
      let duplicatesSkipped = 0;

      // Sync liked tracks
      for (const track of body.likes) {
        try {
          const normalized = normalizeSyncTrack(track);
          if (!normalized) {
            duplicatesSkipped++;
            continue;
          }

          // Check if already exists
          const existing = await prisma.likedTrack.findUnique({
            where: {
              userId_trackId: {
                userId,
                trackId: normalized.videoId
              }
            }
          });

          if (existing) {
            duplicatesSkipped++;
            continue;
          }

          // Create liked track
          await prisma.likedTrack.create({
            data: {
              userId,
              trackId: normalized.videoId,
              title: normalized.title,
              artist: normalized.artist,
              thumbnail: normalized.thumbnail,
              duration: normalized.duration,
            }
          });

          // Update recommendation
          await prisma.recommendation.upsert({
            where: {
              userId_trackId: {
                userId,
                trackId: normalized.videoId
              }
            },
            update: {
              score: { increment: 2.0 },
              isLiked: true,
              likedAt: new Date(),
              source: 'like',
              updatedAt: new Date()
            },
            create: {
              userId,
              trackId: normalized.videoId,
              title: normalized.title,
              artist: normalized.artist,
              thumbnail: normalized.thumbnail,
              duration: normalized.duration,
              source: 'like',
              score: 3.0,
              isLiked: true,
              likedAt: new Date(),
              playCount: 0
            }
          });

          likesSynced++;
        } catch (error) {
          fastify.log.error({ err: error }, 'Failed to sync like');
        }
      }

      // Sync play history (only recent ones to avoid DB bloat)
      const recentHistory = body.history.slice(-100); // Only last 100
      for (const track of recentHistory) {
        try {
          const normalized = normalizeSyncTrack(track);
          if (!normalized) {
            duplicatesSkipped++;
            continue;
          }

          // Always create play history (duplicates are ok for history)
          await prisma.playHistory.create({
            data: {
              userId,
              trackId: normalized.videoId,
              title: normalized.title,
              artist: normalized.artist,
              thumbnail: normalized.thumbnail,
              duration: normalized.duration,
            }
          });

          // Update recommendation
          await prisma.recommendation.upsert({
            where: {
              userId_trackId: {
                userId,
                trackId: normalized.videoId
              }
            },
            update: {
              score: { increment: 0.5 },
              playCount: { increment: 1 },
              lastPlayedAt: new Date(),
              source: 'play',
              updatedAt: new Date()
            },
            create: {
              userId,
              trackId: normalized.videoId,
              title: normalized.title,
              artist: normalized.artist,
              thumbnail: normalized.thumbnail,
              duration: normalized.duration,
              source: 'play',
              score: 1.0,
              playCount: 1,
              lastPlayedAt: new Date()
            }
          });

          historySynced++;
        } catch (error) {
          fastify.log.error({ err: error }, 'Failed to sync history');
        }
      }

      return {
        success: true,
        stats: {
          likesSynced,
          historySynced,
          duplicatesSkipped
        }
      };
    } catch (error: any) {
      if (error.name === 'ZodError') {
        reply.code(400);
        return { error: 'Validation failed', details: error.errors };
      }
      fastify.log.error(error);
      reply.code(500);
      return { error: 'Sync failed' };
    }
  });
}
