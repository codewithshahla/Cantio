import { create } from 'zustand';
import { Track } from './cache';

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────

export type SearchFilter = 'songs' | 'playlists' | 'albums' | 'artists';

export interface MusicPlaylistResult {
  type: 'playlist';
  playlistId: string;
  title: string;
  author: string;
  thumbnail: string;
  trackCount?: number;
}

export interface MusicAlbumResult {
  type: 'album';
  browseId: string;
  title: string;
  artist: string;
  thumbnail: string;
  year?: string;
}

export interface MusicArtistResult {
  type: 'artist';
  browseId: string;
  name: string;
  thumbnail: string;
  subscribers?: string;
}

export type MusicResult = MusicPlaylistResult | MusicAlbumResult | MusicArtistResult;

/** Internal metadata for same-query deduplication. */
interface SearchCacheMeta {
  queryHash: string;
  timestamp: number;
  requestId: number;
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

/** Simple FNV-1a-style hash for strings — fast, deterministic. */
function hashString(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function makeQueryHash(query: string, filter: SearchFilter): string {
  return hashString(`${query.trim().toLowerCase()}::${filter}`);
}

// ─────────────────────────────────────────────────────────────────────
// Store
//
// In-memory only (Zustand). Survives React route navigation but
// resets on full page refresh — this is the desired behaviour so
// users always start with a clean search page after reload.
// ─────────────────────────────────────────────────────────────────────

export interface SearchSessionState {
  // ── UI state ──────────────────────────────────────────────────────
  query: string;
  filter: SearchFilter;
  songResults: Track[];
  musicResults: MusicResult[];
  loading: boolean;
  loadingMore: boolean;
  currentLimit: number;

  // ── Internal ──────────────────────────────────────────────────────
  _meta: SearchCacheMeta | null;
  _requestCounter: number;
  _abortController: AbortController | null;

  // ── Actions ───────────────────────────────────────────────────────

  /** Set query text (does NOT trigger search). */
  setQuery: (query: string) => void;

  /** Switch filter tab, clearing results for the previous filter. */
  setFilter: (filter: SearchFilter) => void;

  /** Execute a new search. Aborts any in-flight request. */
  newSearch: (
    fetchSongs: (query: string, limit: number) => Promise<Track[]>,
    fetchMusic: (query: string, filter: string, limit: number) => Promise<MusicResult[]>,
    fetchPublicPlaylists?: (query: string) => Promise<void>,
  ) => Promise<void>;

  /** Load more results (songs only). */
  loadMore: (
    fetchSongs: (query: string, limit: number) => Promise<Track[]>,
  ) => Promise<void>;

  /** Clear the search — wipes query, results, and resets to defaults. */
  clear: () => void;
}

export const useSearchSession = create<SearchSessionState>((set, get) => ({
  // ── Initial state ─────────────────────────────────────────────────
  query: '',
  filter: 'songs',
  songResults: [],
  musicResults: [],
  loading: false,
  loadingMore: false,
  currentLimit: 10,
  _meta: null,
  _requestCounter: 0,
  _abortController: null,

  // ── Query / Filter setters ────────────────────────────────────────
  setQuery: (query: string) => {
    set({ query });
  },

  setFilter: (filter: SearchFilter) => {
    const prev = get().filter;
    if (prev === filter) return;

    set({
      filter,
      songResults: [],
      musicResults: [],
      currentLimit: 10,
      _meta: null,
    });
  },

  // ── New Search ────────────────────────────────────────────────────
  newSearch: async (fetchSongs, fetchMusic, fetchPublicPlaylists) => {
    const { query, filter, _meta } = get();
    const trimmed = query.trim();
    if (!trimmed) return;

    // Check if we already have fresh results for this exact query+filter
    const newHash = makeQueryHash(trimmed, filter);
    if (_meta && _meta.queryHash === newHash) {
      console.log('[SearchSession] newSearch skipped — cached data is still valid');
      return;
    }

    // Abort any in-flight request
    get()._abortController?.abort();
    const abortController = new AbortController();
    const requestId = get()._requestCounter + 1;

    set({
      loading: true,
      _abortController: abortController,
      _requestCounter: requestId,
      currentLimit: 10,
    });

    try {
      if (filter === 'songs') {
        const results = await fetchSongs(trimmed, 10);
        // Race condition guard: only apply if this is still the latest request
        if (get()._requestCounter !== requestId) return;
        set({
          songResults: results,
          musicResults: [],
          loading: false,
        });
      } else {
        const results = await fetchMusic(trimmed, filter, 20);
        if (get()._requestCounter !== requestId) return;
        set({
          musicResults: results as MusicResult[],
          songResults: [],
          loading: false,
        });
      }

      // Fire public playlist search in background (non-blocking)
      fetchPublicPlaylists?.(trimmed)?.catch(() => {});

      // Update cache metadata
      const meta: SearchCacheMeta = {
        queryHash: newHash,
        timestamp: Date.now(),
        requestId,
      };
      set({ _meta: meta });
    } catch (error) {
      // Only set error state if this request wasn't aborted
      if (get()._requestCounter === requestId) {
        console.error('[SearchSession] Search failed:', error);
        set({
          songResults: [],
          musicResults: [],
          loading: false,
        });
      }
    }
  },

  // ── Load More ─────────────────────────────────────────────────────
  loadMore: async (fetchSongs) => {
    const { query, filter, currentLimit, _requestCounter } = get();
    if (!query.trim() || filter !== 'songs') return;
    if (currentLimit >= 50) return;

    const requestId = _requestCounter + 1;
    set({ loadingMore: true, _requestCounter: requestId });

    try {
      const newLimit = Math.min(currentLimit + 10, 50);
      const results = await fetchSongs(query.trim(), newLimit);

      // Race condition guard
      if (get()._requestCounter !== requestId) return;

      set({
        songResults: results,
        currentLimit: newLimit,
        loadingMore: false,
      });

      // Update meta
      const meta = get()._meta;
      if (meta) {
        set({ _meta: { ...meta, timestamp: Date.now() } });
      }
    } catch (error) {
      if (get()._requestCounter === requestId) {
        console.error('[SearchSession] Load more failed:', error);
        set({ loadingMore: false });
      }
    }
  },

  // ── Clear ─────────────────────────────────────────────────────────
  clear: () => {
    get()._abortController?.abort();
    set({
      query: '',
      filter: 'songs',
      songResults: [],
      musicResults: [],
      loading: false,
      loadingMore: false,
      currentLimit: 10,
      _meta: null,
      _requestCounter: 0,
      _abortController: null,
    });
  },
}));
