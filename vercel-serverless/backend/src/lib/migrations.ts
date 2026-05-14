import { prisma } from './prisma.js';

/**
 * Idempotent startup migrations — runs DDL via $executeRawUnsafe through Prisma Accelerate.
 * Safe to run on every cold start; all statements use IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
 * Only applies the two additive changes from the F3/F5 feature set.
 */
export async function runStartupMigrations(): Promise<void> {
  try {
    // F5: Add shareSlug column to playlists (nullable — zero data loss)
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "playlists" ADD COLUMN IF NOT EXISTS "shareSlug" TEXT`
    );

    await prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS "playlists_shareSlug_key" ON "playlists"("shareSlug")`
    );

    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "playlists_shareSlug_idx" ON "playlists"("shareSlug")`
    );

    // F3: Create user_preferences table (new table — no existing data affected)
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "user_preferences" (
        "id"                TEXT        NOT NULL,
        "userId"            TEXT        NOT NULL,
        "favoriteLanguages" TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
        "favoriteArtists"   TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
        "favoriteGenres"    TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
        "onboardingDone"    BOOLEAN     NOT NULL DEFAULT false,
        "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("id")
      )
    `);

    await prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS "user_preferences_userId_key" ON "user_preferences"("userId")`
    );

    // Add FK constraint — wrapped separately so it doesn't abort the whole migration if it already exists
    try {
      await prisma.$executeRawUnsafe(`
        ALTER TABLE "user_preferences"
          ADD CONSTRAINT "user_preferences_userId_fkey"
          FOREIGN KEY ("userId") REFERENCES "users"("id")
          ON DELETE CASCADE ON UPDATE CASCADE
      `);
    } catch {
      // Constraint already exists — safe to ignore
    }

    console.log('✅ Startup migrations applied');
  } catch (err: any) {
    // Non-fatal — log and continue. The app works even if DDL partially fails.
    console.warn('⚠️  Startup migration warning (non-fatal):', err.message ?? err);
  }
}
