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
}
