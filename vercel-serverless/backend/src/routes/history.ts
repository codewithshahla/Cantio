import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { recordPlaySchema } from '../lib/validation.js';

const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export default async function historyRoutes(fastify: FastifyInstance) {
  // Get play history
  fastify.get('/', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    try {
      const userId = (request.user as any).id;
      const query = historyQuerySchema.safeParse(request.query);
      if (!query.success) {
        reply.code(400);
        return { error: 'Invalid query parameters', details: query.error.errors };
      }
      const { limit, offset } = query.data;

      const history = await prisma.playHistory.findMany({
        where: { userId },
        orderBy: { playedAt: 'desc' },
        take: limit,
        skip: offset,
        cacheStrategy: { ttl: 30, swr: 15 }
      });

      return { history };
    } catch (error) {
      fastify.log.error(error);
      reply.code(500);
      return { error: 'Failed to fetch play history' };
    }
  });

  // Record a play
  fastify.post('/', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    try {
      const body = recordPlaySchema.parse(request.body);
      const userId = (request.user as any).id;

      // Update or create recommendation entry (this is the main aggregate)
      //
      // Score policy:
      //   • First play: score = 1.0 (base signal)
      //   • Replayed <6h:  +0.2 (diminishing returns — autoplay / background loops)
      //   • Replayed 6–24h: +0.4 (moderate intent)
      //   • Replayed >24h: +0.5 (full intent — deliberate revisit)
      //   • Hard cap at 20 so no track accumulates unbounded weight
      //
      // The effective score used for recommendations is further decayed by
      // recencyFactor and boosted by isLiked at query time (recommendations.ts).
      // That means stale rows auto-correct on every recommendation refresh.
      //
      // NORMALIZATION GUARD: skip recommendation upsert for tracks with
      // unknown/fallback artist so malformed metadata never corrupts affinity
      // scoring, topArtists, or the forYou diversity pools.
      const isUnknownArtist = !body.artist
        || body.artist.trim().toLowerCase() === 'unknown'
        || body.artist.trim().toLowerCase() === 'unknown artist';

      if (!isUnknownArtist) {
        const existing = await prisma.recommendation.findUnique({
          where: { userId_trackId: { userId, trackId: body.trackId } },
          select: { lastPlayedAt: true, score: true },
        });

        const hoursSinceLast = existing?.lastPlayedAt
          ? (Date.now() - existing.lastPlayedAt.getTime()) / 3_600_000
          : Infinity;

        const scoreIncrement =
          hoursSinceLast < 6  ? 0.2 :   // same-session replay
          hoursSinceLast < 24 ? 0.4 :   // same-day revisit
                                0.5;     // deliberate return

        const newScore = Math.min((existing?.score ?? 0) + scoreIncrement, 20);

        await prisma.recommendation.upsert({
          where: {
            userId_trackId: { userId, trackId: body.trackId }
          },
          update: {
            score:        newScore,
            playCount:    { increment: 1 },
            lastPlayedAt: new Date(),
            source:       'play',
            updatedAt:    new Date(),
          },
          create: {
            userId,
            trackId:      body.trackId,
            title:        body.title,
            artist:       body.artist,
            thumbnail:    body.thumbnail,
            duration:     body.duration,
            source:       'play',
            score:        1.0,
            playCount:    1,
            lastPlayedAt: new Date(),
          },
        });
      } else {
        fastify.log.warn({ trackId: body.trackId, title: body.title },
          '[history] Skipping recommendation upsert: unknown artist');
      }

      // Create play history entry (keep limited history)
      const play = await prisma.playHistory.create({
        data: {
          userId,
          trackId: body.trackId,
          title: body.title,
          artist: body.artist,
          thumbnail: body.thumbnail,
          duration: body.duration,
        }
      });

      // Clean up old play history - keep only last 100 per user
      const historyCount = await prisma.playHistory.count({
        where: { userId }
      });

      if (historyCount > 100) {
        // Delete oldest entries beyond 100
        const oldestToKeep = await prisma.playHistory.findMany({
          where: { userId },
          orderBy: { playedAt: 'desc' },
          take: 100,
          select: { id: true }
        });

        const idsToKeep = oldestToKeep.map((h: any) => h.id);

        await prisma.playHistory.deleteMany({
          where: {
            userId,
            id: { notIn: idsToKeep }
          }
        });
      }

      return { play };
    } catch (error: any) {
      if (error.name === 'ZodError') {
        reply.code(400);
        return { error: 'Validation failed', details: error.errors };
      }
      fastify.log.error(error);
      reply.code(500);
      return { error: 'Failed to record play' };
    }
  });

  // Clear history
  fastify.delete('/', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    try {
      const userId = (request.user as any).id;

      await prisma.playHistory.deleteMany({
        where: { userId }
      });

      return { success: true };
    } catch (error) {
      fastify.log.error(error);
      reply.code(500);
      return { error: 'Failed to clear history' };
    }
  });
}
