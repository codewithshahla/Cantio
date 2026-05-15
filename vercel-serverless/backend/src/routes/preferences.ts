import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';

const preferencesSchema = z.object({
  favoriteLanguages: z.array(z.string().max(50)).max(10).optional(),
  favoriteArtists: z.array(z.string().max(100)).max(20).optional(),
  favoriteGenres: z.array(z.string().max(50)).max(10).optional(),
  onboardingDone: z.boolean().optional(),
});

export default async function preferencesRoutes(fastify: FastifyInstance) {
  // Get user preferences
  fastify.get('/', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    try {
      const userId = (request.user as any).id;

      const prefs = await prisma.userPreferences.findUnique({
        where: { userId },
      });

      return {
        preferences: prefs || {
          favoriteLanguages: [],
          favoriteArtists: [],
          favoriteGenres: [],
          onboardingDone: false,
        }
      };
    } catch (error) {
      fastify.log.error(error);
      reply.code(500);
      return { error: 'Failed to fetch preferences' };
    }
  });

  // Create or update preferences (upsert)
  fastify.post('/', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    try {
      const parsed = preferencesSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Validation failed', details: parsed.error.errors };
      }

      const userId = (request.user as any).id;
      const body = parsed.data;

      const prefs = await prisma.userPreferences.upsert({
        where: { userId },
        create: {
          userId,
          favoriteLanguages: body.favoriteLanguages ?? [],
          favoriteArtists: body.favoriteArtists ?? [],
          favoriteGenres: body.favoriteGenres ?? [],
          onboardingDone: body.onboardingDone ?? false,
        },
        update: {
          ...(body.favoriteLanguages !== undefined && { favoriteLanguages: body.favoriteLanguages }),
          ...(body.favoriteArtists !== undefined && { favoriteArtists: body.favoriteArtists }),
          ...(body.favoriteGenres !== undefined && { favoriteGenres: body.favoriteGenres }),
          ...(body.onboardingDone !== undefined && { onboardingDone: body.onboardingDone }),
        },
      });

      return { preferences: prefs };
    } catch (error: any) {
      fastify.log.error(error);
      reply.code(500);
      return { error: 'Failed to save preferences' };
    }
  });

  // Check if user needs onboarding
  fastify.get('/needs-onboarding', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    try {
      const userId = (request.user as any).id;

      const prefs = await prisma.userPreferences.findUnique({
        where: { userId },
        select: { onboardingDone: true },
      });

      return {
        needsOnboarding: !prefs || !prefs.onboardingDone,
      };
    } catch (error) {
      fastify.log.error(error);
      reply.code(500);
      return { error: 'Failed to check onboarding status' };
    }
  });

  // Seed recommendations from saved preferences (called after onboarding completes)
  fastify.post('/seed', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    try {
      const userId = (request.user as any).id;

      const prefs = await prisma.userPreferences.findUnique({
        where: { userId },
      });

      if (!prefs) {
        return { seeded: false, reason: 'No preferences found' };
      }

      // Build seed tracks from user choices using YouTube Music searches
      const { buildOnboardingSeedTracks } = await import('../lib/onboarding.js');
      const seedTracks = await buildOnboardingSeedTracks({
        favoriteLanguage: prefs.favoriteLanguages[0], // primary language
        favoriteArtists: prefs.favoriteArtists,
        favoriteGenres: prefs.favoriteGenres,
      }, 20);

      if (seedTracks.length === 0) {
        return { seeded: false, reason: 'No seed tracks found' };
      }

      // Upsert into user_onboarding_preferences so recommendations can use them
      await prisma.userOnboardingPreferences.upsert({
        where: { userId },
        create: {
          userId,
          favoriteLanguage: prefs.favoriteLanguages[0] ?? null,
          favoriteArtists: prefs.favoriteArtists,
          favoriteGenres: prefs.favoriteGenres,
          seedTracks: seedTracks.map(t => ({
            videoId: t.videoId,
            title: t.title,
            artist: t.artist,
            thumbnail: t.thumbnail,
            duration: t.duration,
          })),
        },
        update: {
          favoriteLanguage: prefs.favoriteLanguages[0] ?? null,
          favoriteArtists: prefs.favoriteArtists,
          favoriteGenres: prefs.favoriteGenres,
          seedTracks: seedTracks.map(t => ({
            videoId: t.videoId,
            title: t.title,
            artist: t.artist,
            thumbnail: t.thumbnail,
            duration: t.duration,
          })),
        },
      });

      fastify.log.info(`Seeded ${seedTracks.length} tracks for user ${userId}`);
      return { seeded: true, count: seedTracks.length };
    } catch (error) {
      fastify.log.error(error);
      // Non-fatal — return 200 so the client doesn't retry aggressively
      return { seeded: false, reason: 'Seed generation failed' };
    }
  });
}
