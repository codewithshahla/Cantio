import Innertube from 'youtubei.js';
import { getRelatedTracks, getYTMusicArtistTopTracks, normalizeTrack, searchMusic, type VideoResult } from './youtube.js';

export interface OnboardingPreferencesInput {
  favoriteLanguage?: string;
  favoriteLanguages?: string[];
  favoriteArtists?: string[];
  favoriteGenres?: string[];
}

// Reuse the singleton YTM client (WEB_REMIX = YouTube Music Innertube context)
let ytmClient: Innertube | null = null;
async function getYTMClient(): Promise<Innertube> {
  if (!ytmClient) {
    ytmClient = await Innertube.create({ client_type: 'WEB_REMIX' } as any);
  }
  return ytmClient;
}

function normalizeList(values?: string[]): string[] {
  if (!values) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const t = v.trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

function isUsableTrack(track: VideoResult | null): track is VideoResult {
  if (!track?.videoId || !track.title || !track.artist) return false;
  const artist = track.artist.trim().toLowerCase();
  if (!artist || artist === 'unknown' || artist === 'unknown artist') return false;
  if (track.duration > 0 && (track.duration < 60 || track.duration > 900)) return false;
  return true;
}

function dedupeTracks(tracks: VideoResult[], limit: number): VideoResult[] {
  const seenIds = new Set<string>();
  const seenTitles = new Set<string>();
  const out: VideoResult[] = [];

  for (const track of tracks) {
    if (!isUsableTrack(track)) continue;
    const titleKey = `${track.title.toLowerCase().replace(/\s+/g, ' ').trim()}::${track.artist.toLowerCase().trim()}`;
    if (seenIds.has(track.videoId) || seenTitles.has(titleKey)) continue;
    seenIds.add(track.videoId);
    seenTitles.add(titleKey);
    out.push(track);
    if (out.length >= limit) break;
  }

  return out;
}

function normalizeArtistName(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s*-\s*topic$/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesSelectedArtist(track: VideoResult, selectedArtists: string[]): boolean {
  const trackArtist = normalizeArtistName(track.artist);
  if (!trackArtist) return false;

  return selectedArtists.some((artist) => {
    const selected = normalizeArtistName(artist);
    return Boolean(
      selected &&
      (trackArtist === selected ||
        trackArtist.includes(selected) ||
        selected.includes(trackArtist))
    );
  });
}

/**
 * Search YouTube Music (Innertube WEB_REMIX / `yt.music.search`) for songs
 * matching a query. Returns VideoResult[] using the YTM song graph — proper
 * music tracks, not random YouTube uploads.
 */
async function searchYTMSongs(query: string, limit: number): Promise<VideoResult[]> {
  const yt = await getYTMClient();

  let raw: any;
  try {
    // YTM Innertube: type 'song' searches the YTM song catalogue
    raw = await (yt as any).music.search(query, { type: 'song' });
  } catch (err: any) {
    console.warn(`[onboarding] YTM song search failed for "${query}":`, err.message);
    return [];
  }

  // Flatten sections → items (YTM response nesting varies)
  const items: any[] =
    raw?.contents?.flatMap((s: any) => s?.contents || s?.items || []) ??
    raw?.items ??
    [];

  const results: VideoResult[] = [];
  const seenIds = new Set<string>();

  for (const item of items) {
    if (results.length >= limit) break;
    if (!item) continue;

    try {
      // YTM song items expose videoId / id directly
      const videoId: string = item.id || item.video_id || item.videoId || '';
      if (!videoId || seenIds.has(videoId)) continue;

      const durationRaw = item.duration;
      const duration =
        typeof durationRaw === 'number'
          ? { seconds: durationRaw }
          : durationRaw;

      const normalized = normalizeTrack({ ...item, id: videoId, duration });
      if (!isUsableTrack(normalized)) continue;

      seenIds.add(videoId);
      results.push(normalized);
    } catch {
      // skip malformed items
    }
  }

  return results;
}

/**
 * Build a set of seed tracks from onboarding preferences using the YouTube
 * Music Innertube API (WEB_REMIX client, `music.search` with type:'song').
 *
 * Query strategy:
 *   - For each artist  → "{artist} songs"        (top hits by that artist on YTM)
 *   - For each genre   → "{genre} hits playlist"  (YTM genre discovery)
 *   - For each language → "{language} songs"      (language-specific music)
 *
 * All searches go through `yt.music.search` — the proper YTM song catalogue,
 * not regular YouTube video search.
 */
export async function buildOnboardingSeedTracks(
  preferences: OnboardingPreferencesInput,
  limit: number = 50
): Promise<VideoResult[]> {
  const artists  = normalizeList(preferences.favoriteArtists);
  const genres   = normalizeList(preferences.favoriteGenres);
  const languages = normalizeList([
    ...(preferences.favoriteLanguages || []),
    ...(preferences.favoriteLanguage ? [preferences.favoriteLanguage] : []),
  ]);

  const onboardingPool: VideoResult[] = [];
  const relatedPool: VideoResult[] = [];
  const explorationPool: VideoResult[] = [];

  if (artists.length > 0) {
    const artistAliases = new Set<string>(artists);
    for (const artist of artists) {
      try {
        const matches = await searchMusic(artist, 'artists', 3);
        const artistMatch = matches.find(match =>
          match.type === 'artist' && normalizeArtistName(match.name).includes(normalizeArtistName(artist))
        ) || matches.find(match => match.type === 'artist');

        if (artistMatch?.type === 'artist') {
          artistAliases.add(artistMatch.name);
          const topTracks = await getYTMusicArtistTopTracks(artistMatch.browseId);
          artistAliases.add(topTracks.name);
          onboardingPool.push(...topTracks.tracks.filter(track => matchesSelectedArtist(track, Array.from(artistAliases))));
        }
      } catch (err: any) {
        console.warn(`[onboarding] Artist page lookup failed for "${artist}":`, err.message);
      }
    }

    const queryArtists = Array.from(artistAliases);
    const artistQueries = queryArtists.flatMap((artist) => [
      `${artist} songs`,
      `${artist} top songs`,
      `${artist} hits`,
      `${artist} latest songs`,
      `${artist} music`,
      `${artist} best songs`,
      `${artist} popular songs`,
      `${artist} official songs`,
      `${artist} album songs`,
      `${artist} singles`,
      ...languages.slice(0, 3).map(language => `${artist} ${language} songs`),
      ...genres.slice(0, 3).map(genre => `${artist} ${genre} songs`),
    ]);

    for (const query of artistQueries) {
      const tracks = await searchYTMSongs(query, 12);
      onboardingPool.push(...tracks.filter(track => matchesSelectedArtist(track, Array.from(artistAliases))));
      if (dedupeTracks(onboardingPool, limit).length >= limit) break;
    }

    const artistSeeds = dedupeTracks(onboardingPool, limit);

    for (const seed of artistSeeds.slice(0, Math.min(6, artists.length * 2))) {
      try {
        const related = await getRelatedTracks(seed.videoId, 12);
        relatedPool.push(...related.filter(track => matchesSelectedArtist(track, Array.from(artistAliases))));
      } catch (err: any) {
        console.warn(`[onboarding] Related lookup failed for "${seed.title}":`, err.message);
      }
    }

    return dedupeTracks([...artistSeeds, ...relatedPool], limit);
  }

  // No artists selected: use the rest of the user's answers as a safe fallback.
  const perQuery = Math.min(12, Math.ceil(limit / Math.max(1, genres.length + languages.length)));

  for (const genre of genres) {
    onboardingPool.push(...await searchYTMSongs(`${genre} music hits`, perQuery));
  }

  for (const language of languages) {
    onboardingPool.push(...await searchYTMSongs(`${language} songs`, perQuery));
  }

  const onboardingSeeds = dedupeTracks(onboardingPool, Math.max(6, limit));

  // 4. Related tracks/radios from the strongest onboarding seeds.
  for (const seed of onboardingSeeds.slice(0, 3)) {
    try {
      relatedPool.push(...await getRelatedTracks(seed.videoId, 8));
    } catch (err: any) {
      console.warn(`[onboarding] Related lookup failed for "${seed.title}":`, err.message);
    }
  }

  // 5. Exploration/discovery: adjacent fresh queries, or a generic fallback for skipped onboarding.
  const explorationQueries = [
    ...genres.map(g => `new ${g} music`),
    ...languages.map(l => `new ${l} songs`),
    'trending music',
    'new music discoveries',
  ];
  for (const query of explorationQueries.slice(0, 4)) {
    explorationPool.push(...await searchYTMSongs(query, 6));
  }

  const onboardingSlots = Math.ceil(limit * 0.6);
  const relatedSlots = Math.ceil(limit * 0.2);
  const explorationSlots = limit - onboardingSlots - relatedSlots;

  return dedupeTracks([
    ...dedupeTracks(onboardingSeeds, onboardingSlots),
    ...dedupeTracks(relatedPool, relatedSlots),
    ...dedupeTracks(explorationPool, explorationSlots),
    ...onboardingSeeds,
    ...relatedPool,
    ...explorationPool,
  ], limit);
}
