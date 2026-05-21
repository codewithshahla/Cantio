/**
 * Unit tests for SearchSessionStore (in-memory Zustand, no IndexedDB)
 *
 * Covers:
 *  - newSearch fetch + caching
 *  - Race condition guards (request IDs)
 *  - clear() resets all state
 *  - Filter switching
 *  - Load more pagination
 *  - Same-query deduplication
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Track } from '../cache';

// Import the store (no localforage mocking needed — store is in-memory)
import { useSearchSession } from '../searchSessionStore';

// ─── Test helpers ───────────────────────────────────────────────────

function makeMockTrack(id: string): Track {
  return {
    videoId: id,
    title: `Track ${id}`,
    artist: `Artist ${id}`,
    duration: 180,
    thumbnail: `https://example.com/${id}.jpg`,
  };
}

/** Reset the Zustand store to initial state between tests. */
function resetStore() {
  useSearchSession.setState({
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
}

const mockFetchSongs = vi.fn<(q: string, l: number) => Promise<Track[]>>();
const mockFetchMusic = vi.fn<(q: string, f: string, l: number) => Promise<any[]>>();

// ─── Tests ──────────────────────────────────────────────────────────

describe('SearchSessionStore', () => {
  beforeEach(() => {
    resetStore();
    mockFetchSongs.mockReset();
    mockFetchMusic.mockReset();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── clear() ───────────────────────────────────────────────────

  describe('clear()', () => {
    it('should reset all state to defaults', () => {
      // Populate the store
      useSearchSession.setState({
        query: 'linkin park',
        filter: 'albums',
        songResults: [makeMockTrack('1')],
        currentLimit: 30,
      });

      useSearchSession.getState().clear();

      const state = useSearchSession.getState();
      expect(state.query).toBe('');
      expect(state.filter).toBe('songs');
      expect(state.songResults).toEqual([]);
      expect(state.musicResults).toEqual([]);
      expect(state.currentLimit).toBe(10);
      expect(state._meta).toBeNull();
    });
  });

  // ── newSearch() ───────────────────────────────────────────────

  describe('newSearch()', () => {
    it('should execute a search and store results', async () => {
      const tracks = [makeMockTrack('a'), makeMockTrack('b'), makeMockTrack('c')];
      mockFetchSongs.mockResolvedValue(tracks);

      useSearchSession.setState({ query: 'daft punk', filter: 'songs' });
      await useSearchSession.getState().newSearch(mockFetchSongs, mockFetchMusic);

      const state = useSearchSession.getState();
      expect(state.songResults).toEqual(tracks);
      expect(state.loading).toBe(false);
      expect(state._meta).not.toBeNull();
      expect(mockFetchSongs).toHaveBeenCalledWith('daft punk', 10);
    });

    it('should search music when filter is not songs', async () => {
      const albums = [{ type: 'album', browseId: '1', title: 'Album', artist: 'Test', thumbnail: '' }];
      mockFetchMusic.mockResolvedValue(albums);

      useSearchSession.setState({ query: 'radiohead', filter: 'albums' });
      await useSearchSession.getState().newSearch(mockFetchSongs, mockFetchMusic);

      const state = useSearchSession.getState();
      expect(state.musicResults).toEqual(albums);
      expect(state.songResults).toEqual([]);
      expect(mockFetchMusic).toHaveBeenCalledWith('radiohead', 'albums', 20);
    });

    it('should skip search if query is empty', async () => {
      useSearchSession.setState({ query: '   ', filter: 'songs' });
      await useSearchSession.getState().newSearch(mockFetchSongs, mockFetchMusic);
      expect(mockFetchSongs).not.toHaveBeenCalled();
    });

    it('should skip search when cached data exists for same query', async () => {
      const tracks = [makeMockTrack('1')];
      mockFetchSongs.mockResolvedValue(tracks);

      useSearchSession.setState({ query: 'test', filter: 'songs' });
      await useSearchSession.getState().newSearch(mockFetchSongs, mockFetchMusic);
      expect(mockFetchSongs).toHaveBeenCalledTimes(1);

      // Second search with same query — should be skipped
      await useSearchSession.getState().newSearch(mockFetchSongs, mockFetchMusic);
      expect(mockFetchSongs).toHaveBeenCalledTimes(1);
    });

    it('should re-fetch when newSearch is called with a different query', async () => {
      mockFetchSongs.mockResolvedValue([makeMockTrack('1')]);
      useSearchSession.setState({ query: 'query1', filter: 'songs' });
      await useSearchSession.getState().newSearch(mockFetchSongs, mockFetchMusic);

      mockFetchSongs.mockResolvedValue([makeMockTrack('2')]);
      useSearchSession.setState({ query: 'query2' });
      await useSearchSession.getState().newSearch(mockFetchSongs, mockFetchMusic);

      expect(mockFetchSongs).toHaveBeenCalledTimes(2);
      expect(useSearchSession.getState().songResults[0].videoId).toBe('2');
    });

    it('should handle fetch errors gracefully', async () => {
      mockFetchSongs.mockRejectedValue(new Error('Network error'));
      useSearchSession.setState({ query: 'failing query', filter: 'songs' });
      await useSearchSession.getState().newSearch(mockFetchSongs, mockFetchMusic);

      const state = useSearchSession.getState();
      expect(state.loading).toBe(false);
      expect(state.songResults).toEqual([]);
    });
  });

  // ── Race condition protection ─────────────────────────────────

  describe('race condition protection', () => {
    it('should ignore results from older requests', async () => {
      let resolveFirst: (v: Track[]) => void;
      const firstPromise = new Promise<Track[]>((r) => (resolveFirst = r));
      const secondTracks = [makeMockTrack('second')];

      mockFetchSongs
        .mockReturnValueOnce(firstPromise)
        .mockResolvedValueOnce(secondTracks);

      useSearchSession.setState({ query: 'slow', filter: 'songs' });
      const first = useSearchSession.getState().newSearch(mockFetchSongs, mockFetchMusic);

      useSearchSession.setState({ query: 'fast' });
      const second = useSearchSession.getState().newSearch(mockFetchSongs, mockFetchMusic);

      await second;
      resolveFirst!([makeMockTrack('first')]);
      await first;

      expect(useSearchSession.getState().songResults[0].videoId).toBe('second');
    });
  });

  // ── loadMore() ────────────────────────────────────────────────

  describe('loadMore()', () => {
    it('should fetch more results and increase limit', async () => {
      const moreTracks = Array.from({ length: 20 }, (_, i) => makeMockTrack(`m${i}`));
      mockFetchSongs.mockResolvedValue(moreTracks);

      useSearchSession.setState({
        query: 'load more test',
        filter: 'songs',
        currentLimit: 10,
        _meta: { queryHash: 'test', timestamp: Date.now(), requestId: 1 },
      });

      await useSearchSession.getState().loadMore(mockFetchSongs);

      const state = useSearchSession.getState();
      expect(state.currentLimit).toBe(20);
      expect(state.songResults).toEqual(moreTracks);
      expect(state.loadingMore).toBe(false);
    });

    it('should not load more when limit is already at 50', async () => {
      useSearchSession.setState({ query: 'test', filter: 'songs', currentLimit: 50 });
      await useSearchSession.getState().loadMore(mockFetchSongs);
      expect(mockFetchSongs).not.toHaveBeenCalled();
    });

    it('should not load more when filter is not songs', async () => {
      useSearchSession.setState({ query: 'test', filter: 'albums', currentLimit: 10 });
      await useSearchSession.getState().loadMore(mockFetchSongs);
      expect(mockFetchSongs).not.toHaveBeenCalled();
    });
  });

  // ── setFilter() ───────────────────────────────────────────────

  describe('setFilter()', () => {
    it('should clear results when switching filters', () => {
      useSearchSession.setState({
        filter: 'songs',
        songResults: [makeMockTrack('1')],
      });

      useSearchSession.getState().setFilter('albums');

      const state = useSearchSession.getState();
      expect(state.filter).toBe('albums');
      expect(state.songResults).toEqual([]);
      expect(state.musicResults).toEqual([]);
    });

    it('should no-op when selecting the same filter', () => {
      useSearchSession.setState({
        filter: 'songs',
        songResults: [makeMockTrack('1')],
      });

      useSearchSession.getState().setFilter('songs');
      expect(useSearchSession.getState().songResults).toHaveLength(1);
    });
  });
});
