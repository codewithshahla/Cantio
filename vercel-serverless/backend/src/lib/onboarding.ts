import Innertube from 'youtubei.js';
import type { VideoResult } from './youtube.js';

export interface OnboardingPreferencesInput {
  favoriteLanguage?: string;
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

      // Duration: YTM gives seconds or a { seconds } object
      const durationRaw = item.duration;
      const duration: number =
        typeof durationRaw === 'number'
          ? durationRaw
          : typeof durationRaw?.seconds === 'number'
          ? durationRaw.seconds
          : 0;

      // Skip very short or very long tracks (not songs)
      if (duration > 0 && (duration < 60 || duration > 600)) continue;

      const title: string =
        item.title?.text || item.title || item.name || 'Unknown';

      // Artist: prefer runs/text from author field
      const artist: string =
        item.artists?.[0]?.name ||
        item.author?.name ||
        item.subtitle?.text ||
        'Unknown';

      // Thumbnail: prefer higher-res
      const thumbnailList: any =
        item.thumbnail?.contents ||
        item.thumbnails ||
        item.thumbnail ||
        [];
      const thumbnail: string = Array.isArray(thumbnailList)
        ? (thumbnailList[thumbnailList.length - 1]?.url ?? '')
        : (thumbnailList?.url ?? '');

      seenIds.add(videoId);
      results.push({ videoId, title, artist, duration, thumbnail });
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
  limit: number = 20
): Promise<VideoResult[]> {
  const artists  = normalizeList(preferences.favoriteArtists);
  const genres   = normalizeList(preferences.favoriteGenres);
  const language = preferences.favoriteLanguage?.trim();

  const results: VideoResult[] = [];
  const seenIds  = new Set<string>();

  const addResults = (tracks: VideoResult[]) => {
    for (const t of tracks) {
      if (!t?.videoId || seenIds.has(t.videoId)) continue;
      seenIds.add(t.videoId);
      results.push(t);
      if (results.length >= limit) return;
    }
  };

  // How many tracks to request per query — slightly more than needed so
  // dedup still yields enough results.
  const perQuery = Math.min(10, Math.ceil(limit / Math.max(1, artists.length + genres.length + (language ? 1 : 0))));

  // 1. Artists — highest signal: user explicitly named these
  for (const artist of artists) {
    if (results.length >= limit) break;
    const tracks = await searchYTMSongs(`${artist} songs`, perQuery);
    addResults(tracks);
  }

  // 2. Genres — mid signal: genre-based discovery
  for (const genre of genres) {
    if (results.length >= limit) break;
    const tracks = await searchYTMSongs(`${genre} music hits`, perQuery);
    addResults(tracks);
  }

  // 3. Language — fill remaining slots with language-specific music
  if (language && results.length < limit) {
    const tracks = await searchYTMSongs(`${language} songs`, perQuery);
    addResults(tracks);
  }

  return results.slice(0, limit);
}
