import { search, VideoResult } from './youtube.js';

export interface OnboardingPreferencesInput {
  favoriteLanguage?: string;
  favoriteArtists?: string[];
  favoriteGenres?: string[];
}

function normalizeList(values?: string[]): string[] {
  if (!values) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(trimmed);
  }
  return normalized;
}

export async function buildOnboardingSeedTracks(
  preferences: OnboardingPreferencesInput,
  limit: number = 20
): Promise<VideoResult[]> {
  const artists = normalizeList(preferences.favoriteArtists);
  const genres = normalizeList(preferences.favoriteGenres);
  const language = preferences.favoriteLanguage?.trim();

  const results: VideoResult[] = [];
  const seenIds = new Set<string>();

  const addResults = (tracks: VideoResult[]) => {
    for (const track of tracks) {
      if (!track?.videoId || seenIds.has(track.videoId)) continue;
      seenIds.add(track.videoId);
      results.push(track);
      if (results.length >= limit) break;
    }
  };

  const perQueryLimit = Math.min(8, limit);

  for (const artist of artists) {
    if (results.length >= limit) break;
    const tracks = await search(`${artist} songs`, perQueryLimit);
    addResults(tracks);
  }

  for (const genre of genres) {
    if (results.length >= limit) break;
    const tracks = await search(`${genre} music`, perQueryLimit);
    addResults(tracks);
  }

  if (language && results.length < limit) {
    const tracks = await search(`${language} songs`, perQueryLimit);
    addResults(tracks);
  }

  return results.slice(0, limit);
}
