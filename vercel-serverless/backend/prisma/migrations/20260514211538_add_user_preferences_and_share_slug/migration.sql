-- F3: User onboarding preferences (NEW TABLE — fully additive, safe)
-- F5: Shareable playlist slug (NEW NULLABLE COLUMN — safe)

-- CreateTable: user_preferences
CREATE TABLE "user_preferences" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "favoriteLanguages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "favoriteArtists" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "favoriteGenres" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "onboardingDone" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: unique userId on user_preferences
CREATE UNIQUE INDEX "user_preferences_userId_key" ON "user_preferences"("userId");

-- AddColumn: shareSlug to playlists (nullable, no data loss)
ALTER TABLE "playlists" ADD COLUMN IF NOT EXISTS "shareSlug" TEXT;

-- CreateIndex: unique shareSlug on playlists
CREATE UNIQUE INDEX IF NOT EXISTS "playlists_shareSlug_key" ON "playlists"("shareSlug");

-- CreateIndex: index on shareSlug for fast public lookups
CREATE INDEX IF NOT EXISTS "playlists_shareSlug_idx" ON "playlists"("shareSlug");

-- AddForeignKey: user_preferences -> users
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
