-- Safe additive migration: creates user_onboarding_preferences table
-- No existing tables, columns, or data are modified.

-- CreateTable
CREATE TABLE "user_onboarding_preferences" (
    "id"               TEXT        NOT NULL,
    "userId"           TEXT        NOT NULL,
    "favoriteLanguage" TEXT,
    "favoriteArtists"  TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
    "favoriteGenres"   TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
    "seedTracks"       JSONB,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_onboarding_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (unique userId — one preferences row per user)
CREATE UNIQUE INDEX "user_onboarding_preferences_userId_key"
    ON "user_onboarding_preferences"("userId");

-- CreateIndex (lookup by userId)
CREATE INDEX "user_onboarding_preferences_userId_idx"
    ON "user_onboarding_preferences"("userId");

-- AddForeignKey (cascade delete when user is deleted)
ALTER TABLE "user_onboarding_preferences"
    ADD CONSTRAINT "user_onboarding_preferences_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
