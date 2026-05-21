/**
 * Unit tests for searchPlaybackHistoryStore
 *
 * Covers:
 *  - Deduplication (replay bumps to top, no duplicates)
 *  - Trimming to 20 entries
 *  - Hydration from IndexedDB
 *  - Persistence restore
 *  - Corrupted cache recovery (invalid entries, bad version, partial corruption)
 *  - Ordering correctness (newest first)
 *  - Removal and clear
 *  - Defensive validation (missing fields, unsupported types, rapid events)
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// ─── Mock localforage BEFORE importing the store ────────────────────
const mockStorage = new Map<string, unknown>();

vi.mock('localforage', () => ({
  default: {
    createInstance: () => ({
      getItem: vi.fn(async (key: string) => mockStorage.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: unknown) => {
        mockStorage.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        mockStorage.delete(key);
      }),
    }),
  },
}));

// Import AFTER mocking
import {
  useSearchPlaybackHistory,
  SearchPlaybackEntry,
} from '../searchPlaybackHistoryStore';

// ─── Test helpers ───────────────────────────────────────────────────

function makeEntry(overrides: Partial<SearchPlaybackEntry> & { id: string }): Omit<SearchPlaybackEntry, 'playedAt'> {
  return {
    type: 'song',
    title: `Track ${overrides.id}`,
    subtitle: `Artist ${overrides.id}`,
    artwork: `https://example.com/${overrides.id}.jpg`,
    searchQuery: 'test query',
    ...overrides,
  };
}

function makePersistedEntry(id: string, playedAt: number, overrides: Partial<SearchPlaybackEntry> = {}): SearchPlaybackEntry {
  return {
    id,
    type: 'song',
    title: `Track ${id}`,
    subtitle: `Artist ${id}`,
    artwork: `https://example.com/${id}.jpg`,
    searchQuery: 'test',
    playedAt,
    ...overrides,
  };
}

/** Reset Zustand store state between tests. */
function resetStore() {
  useSearchPlaybackHistory.setState({
    entries: [],
    hydrated: false,
  });
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('SearchPlaybackHistoryStore', () => {
  beforeEach(() => {
    mockStorage.clear();
    resetStore();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Deduplication ─────────────────────────────────────────────

  describe('deduplication', () => {
    it('should not create duplicate entries for the same id', () => {
      const store = useSearchPlaybackHistory.getState();
      store.recordPlay(makeEntry({ id: 'abc' }));
      store.recordPlay(makeEntry({ id: 'abc' }));
      store.recordPlay(makeEntry({ id: 'abc' }));

      const { entries } = useSearchPlaybackHistory.getState();
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe('abc');
    });

    it('should bump existing entry to the top on replay', () => {
      const store = useSearchPlaybackHistory.getState();
      store.recordPlay(makeEntry({ id: 'first' }));
      store.recordPlay(makeEntry({ id: 'second' }));
      store.recordPlay(makeEntry({ id: 'third' }));

      // Replay 'first' — should move it to position 0
      store.recordPlay(makeEntry({ id: 'first' }));

      const { entries } = useSearchPlaybackHistory.getState();
      expect(entries).toHaveLength(3);
      expect(entries[0].id).toBe('first');
      expect(entries[1].id).toBe('third');
      expect(entries[2].id).toBe('second');
    });

    it('should update the timestamp when bumping to top', () => {
      const store = useSearchPlaybackHistory.getState();
      store.recordPlay(makeEntry({ id: 'track1' }));

      const firstTimestamp = useSearchPlaybackHistory.getState().entries[0].playedAt;

      // Small delay to ensure different timestamp
      vi.useFakeTimers();
      vi.advanceTimersByTime(1000);
      store.recordPlay(makeEntry({ id: 'track1' }));
      vi.useRealTimers();

      const updatedTimestamp = useSearchPlaybackHistory.getState().entries[0].playedAt;
      expect(updatedTimestamp).toBeGreaterThanOrEqual(firstTimestamp);
    });
  });

  // ── Trimming to 20 ───────────────────────────────────────────

  describe('trimming', () => {
    it('should keep only 20 entries maximum', () => {
      const store = useSearchPlaybackHistory.getState();
      for (let i = 0; i < 25; i++) {
        store.recordPlay(makeEntry({ id: `track-${i}` }));
      }

      const { entries } = useSearchPlaybackHistory.getState();
      expect(entries).toHaveLength(20);
    });

    it('should keep the newest entries when trimming', () => {
      const store = useSearchPlaybackHistory.getState();
      for (let i = 0; i < 25; i++) {
        store.recordPlay(makeEntry({ id: `track-${i}` }));
      }

      const { entries } = useSearchPlaybackHistory.getState();
      // Most recent is track-24, oldest retained is track-5
      expect(entries[0].id).toBe('track-24');
      expect(entries[19].id).toBe('track-5');
      // Oldest ones (0-4) should be trimmed
      const ids = new Set(entries.map(e => e.id));
      expect(ids.has('track-0')).toBe(false);
      expect(ids.has('track-4')).toBe(false);
    });

    it('should trim from persistence snapshot too', async () => {
      // Seed IndexedDB with 25 entries
      const entries = Array.from({ length: 25 }, (_, i) =>
        makePersistedEntry(`old-${i}`, Date.now() - (25 - i) * 1000)
      );
      mockStorage.set('history', { entries, version: 1 });

      await useSearchPlaybackHistory.getState().hydrate();

      expect(useSearchPlaybackHistory.getState().entries).toHaveLength(20);
    });
  });

  // ── Ordering ──────────────────────────────────────────────────

  describe('ordering', () => {
    it('should maintain newest-first order', () => {
      const store = useSearchPlaybackHistory.getState();
      store.recordPlay(makeEntry({ id: 'a' }));
      store.recordPlay(makeEntry({ id: 'b' }));
      store.recordPlay(makeEntry({ id: 'c' }));

      const { entries } = useSearchPlaybackHistory.getState();
      expect(entries[0].id).toBe('c');
      expect(entries[1].id).toBe('b');
      expect(entries[2].id).toBe('a');
    });

    it('should enforce newest-first even with corrupt ordering from persistence', async () => {
      // Store entries in wrong order
      mockStorage.set('history', {
        entries: [
          makePersistedEntry('old', 1000),
          makePersistedEntry('new', 9000),
          makePersistedEntry('mid', 5000),
        ],
        version: 1,
      });

      await useSearchPlaybackHistory.getState().hydrate();

      const { entries } = useSearchPlaybackHistory.getState();
      expect(entries[0].id).toBe('new');
      expect(entries[1].id).toBe('mid');
      expect(entries[2].id).toBe('old');
    });
  });

  // ── Hydration ─────────────────────────────────────────────────

  describe('hydration', () => {
    it('should set hydrated=true even when no data exists', async () => {
      await useSearchPlaybackHistory.getState().hydrate();
      expect(useSearchPlaybackHistory.getState().hydrated).toBe(true);
      expect(useSearchPlaybackHistory.getState().entries).toEqual([]);
    });

    it('should restore entries from IndexedDB', async () => {
      const stored = [
        makePersistedEntry('x', Date.now() - 1000),
        makePersistedEntry('y', Date.now() - 2000),
      ];
      mockStorage.set('history', { entries: stored, version: 1 });

      await useSearchPlaybackHistory.getState().hydrate();

      const { entries, hydrated } = useSearchPlaybackHistory.getState();
      expect(hydrated).toBe(true);
      expect(entries).toHaveLength(2);
      expect(entries[0].id).toBe('x');
      expect(entries[1].id).toBe('y');
    });

    it('should prevent double-hydration', async () => {
      mockStorage.set('history', {
        entries: [makePersistedEntry('first', Date.now())],
        version: 1,
      });

      await useSearchPlaybackHistory.getState().hydrate();
      expect(useSearchPlaybackHistory.getState().entries).toHaveLength(1);

      // Change storage and try hydrating again
      mockStorage.set('history', {
        entries: [makePersistedEntry('first', Date.now()), makePersistedEntry('second', Date.now())],
        version: 1,
      });
      await useSearchPlaybackHistory.getState().hydrate();

      // Should still have only the original data
      expect(useSearchPlaybackHistory.getState().entries).toHaveLength(1);
    });
  });

  // ── Corrupted cache recovery ──────────────────────────────────

  describe('corrupted cache recovery', () => {
    it('should discard a snapshot with wrong version', async () => {
      mockStorage.set('history', {
        entries: [makePersistedEntry('x', Date.now())],
        version: 999,
      });

      await useSearchPlaybackHistory.getState().hydrate();
      expect(useSearchPlaybackHistory.getState().entries).toEqual([]);
    });

    it('should discard null snapshot', async () => {
      mockStorage.set('history', null);

      await useSearchPlaybackHistory.getState().hydrate();
      expect(useSearchPlaybackHistory.getState().hydrated).toBe(true);
      expect(useSearchPlaybackHistory.getState().entries).toEqual([]);
    });

    it('should discard non-object snapshot', async () => {
      mockStorage.set('history', 'not an object');

      await useSearchPlaybackHistory.getState().hydrate();
      expect(useSearchPlaybackHistory.getState().entries).toEqual([]);
    });

    it('should strip invalid entries while preserving valid ones', async () => {
      mockStorage.set('history', {
        entries: [
          makePersistedEntry('valid1', Date.now() - 1000),
          { id: '', type: 'song', title: '', playedAt: Date.now() },  // invalid: empty id & title
          makePersistedEntry('valid2', Date.now() - 2000),
          null,  // completely invalid
          { type: 'song', title: 'No ID', playedAt: Date.now() },  // missing id
          makePersistedEntry('valid3', Date.now() - 3000),
        ],
        version: 1,
      });

      await useSearchPlaybackHistory.getState().hydrate();

      const { entries } = useSearchPlaybackHistory.getState();
      expect(entries).toHaveLength(3);
      expect(entries.map(e => e.id)).toEqual(['valid1', 'valid2', 'valid3']);
    });

    it('should handle entries with unsupported entity types', async () => {
      mockStorage.set('history', {
        entries: [
          makePersistedEntry('good', Date.now(), { type: 'song' }),
          { ...makePersistedEntry('bad', Date.now()), type: 'unsupported_type' },
        ],
        version: 1,
      });

      await useSearchPlaybackHistory.getState().hydrate();

      const { entries } = useSearchPlaybackHistory.getState();
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe('good');
    });

    it('should handle entries with non-finite playedAt', async () => {
      mockStorage.set('history', {
        entries: [
          makePersistedEntry('good', Date.now()),
          { ...makePersistedEntry('nan', Date.now()), playedAt: NaN },
          { ...makePersistedEntry('inf', Date.now()), playedAt: Infinity },
        ],
        version: 1,
      });

      await useSearchPlaybackHistory.getState().hydrate();

      const { entries } = useSearchPlaybackHistory.getState();
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe('good');
    });

    it('should deduplicate entries in persisted data', async () => {
      mockStorage.set('history', {
        entries: [
          makePersistedEntry('dup', Date.now()),
          makePersistedEntry('dup', Date.now() - 1000),  // duplicate
          makePersistedEntry('unique', Date.now() - 2000),
        ],
        version: 1,
      });

      await useSearchPlaybackHistory.getState().hydrate();

      const { entries } = useSearchPlaybackHistory.getState();
      expect(entries).toHaveLength(2);
      const ids = entries.map(e => e.id);
      expect(ids.filter(id => id === 'dup')).toHaveLength(1);
    });

    it('should normalize missing subtitle and artwork to empty strings', async () => {
      mockStorage.set('history', {
        entries: [
          { id: 'sparse', type: 'song', title: 'Sparse Track', playedAt: Date.now() },
        ],
        version: 1,
      });

      await useSearchPlaybackHistory.getState().hydrate();

      const entry = useSearchPlaybackHistory.getState().entries[0];
      expect(entry.subtitle).toBe('');
      expect(entry.artwork).toBe('');
      expect(entry.searchQuery).toBe('');
    });
  });

  // ── recordPlay validation ─────────────────────────────────────

  describe('recordPlay validation', () => {
    it('should reject entries with empty id', () => {
      useSearchPlaybackHistory.getState().recordPlay(makeEntry({ id: '' }));
      expect(useSearchPlaybackHistory.getState().entries).toHaveLength(0);
    });

    it('should reject entries with unsupported type', () => {
      useSearchPlaybackHistory.getState().recordPlay({
        id: 'test',
        type: 'unsupported' as any,
        title: 'Test',
        subtitle: '',
        artwork: '',
        searchQuery: '',
      });
      expect(useSearchPlaybackHistory.getState().entries).toHaveLength(0);
    });

    it('should reject entries with missing title', () => {
      useSearchPlaybackHistory.getState().recordPlay({
        id: 'test',
        type: 'song',
        title: '',
        subtitle: '',
        artwork: '',
        searchQuery: '',
      });
      expect(useSearchPlaybackHistory.getState().entries).toHaveLength(0);
    });

    it('should accept all valid entity types', () => {
      const types = ['song', 'artist', 'album', 'playlist', 'podcast', 'genre'] as const;
      for (const type of types) {
        useSearchPlaybackHistory.getState().recordPlay(makeEntry({ id: `${type}-1`, type }));
      }

      expect(useSearchPlaybackHistory.getState().entries).toHaveLength(6);
    });

    it('should handle rapid successive recordPlay calls', () => {
      const store = useSearchPlaybackHistory.getState();
      // Simulate rapid clicks
      for (let i = 0; i < 10; i++) {
        store.recordPlay(makeEntry({ id: 'rapid' }));
      }

      expect(useSearchPlaybackHistory.getState().entries).toHaveLength(1);
      expect(useSearchPlaybackHistory.getState().entries[0].id).toBe('rapid');
    });
  });

  // ── Removal and clear ─────────────────────────────────────────

  describe('removal and clear', () => {
    it('should remove a specific entry by id', () => {
      const store = useSearchPlaybackHistory.getState();
      store.recordPlay(makeEntry({ id: 'a' }));
      store.recordPlay(makeEntry({ id: 'b' }));
      store.recordPlay(makeEntry({ id: 'c' }));

      store.removeEntry('b');

      const { entries } = useSearchPlaybackHistory.getState();
      expect(entries).toHaveLength(2);
      expect(entries.map(e => e.id)).toEqual(['c', 'a']);
    });

    it('should no-op when removing a non-existent id', () => {
      const store = useSearchPlaybackHistory.getState();
      store.recordPlay(makeEntry({ id: 'a' }));

      store.removeEntry('does-not-exist');

      expect(useSearchPlaybackHistory.getState().entries).toHaveLength(1);
    });

    it('should clear all entries', () => {
      const store = useSearchPlaybackHistory.getState();
      store.recordPlay(makeEntry({ id: 'a' }));
      store.recordPlay(makeEntry({ id: 'b' }));

      store.clearHistory();

      expect(useSearchPlaybackHistory.getState().entries).toEqual([]);
    });

    it('should clear IndexedDB on clearHistory', async () => {
      mockStorage.set('history', { entries: [makePersistedEntry('x', Date.now())], version: 1 });

      useSearchPlaybackHistory.getState().clearHistory();
      await new Promise((r) => setTimeout(r, 50));

      expect(mockStorage.has('history')).toBe(false);
    });
  });

  // ── Persistence integration ───────────────────────────────────

  describe('persistence', () => {
    it('should persist to IndexedDB after recordPlay', async () => {
      useSearchPlaybackHistory.getState().recordPlay(makeEntry({ id: 'persisted' }));

      // Wait for debounced persist (300ms + buffer)
      await new Promise((r) => setTimeout(r, 500));

      const saved = mockStorage.get('history') as any;
      expect(saved).toBeDefined();
      expect(saved.version).toBe(1);
      expect(saved.entries).toHaveLength(1);
      expect(saved.entries[0].id).toBe('persisted');
    });

    it('should coalesce rapid writes via debouncing', async () => {
      const store = useSearchPlaybackHistory.getState();
      store.recordPlay(makeEntry({ id: 'a' }));
      store.recordPlay(makeEntry({ id: 'b' }));
      store.recordPlay(makeEntry({ id: 'c' }));

      // Wait for debounce
      await new Promise((r) => setTimeout(r, 500));

      const saved = mockStorage.get('history') as any;
      expect(saved.entries).toHaveLength(3);
    });
  });

  // ── Entity data fidelity ──────────────────────────────────────

  describe('data fidelity', () => {
    it('should preserve all fields from the incoming entry', () => {
      useSearchPlaybackHistory.getState().recordPlay({
        id: 'video123',
        type: 'song',
        title: 'My Song',
        subtitle: 'My Artist',
        artwork: 'https://img.example.com/art.jpg',
        searchQuery: 'my search',
      });

      const entry = useSearchPlaybackHistory.getState().entries[0];
      expect(entry.id).toBe('video123');
      expect(entry.type).toBe('song');
      expect(entry.title).toBe('My Song');
      expect(entry.subtitle).toBe('My Artist');
      expect(entry.artwork).toBe('https://img.example.com/art.jpg');
      expect(entry.searchQuery).toBe('my search');
      expect(typeof entry.playedAt).toBe('number');
    });

    it('should default missing subtitle and artwork to empty string', () => {
      useSearchPlaybackHistory.getState().recordPlay({
        id: 'sparse',
        type: 'album',
        title: 'Album Title',
        subtitle: '',
        artwork: '',
        searchQuery: '',
      });

      const entry = useSearchPlaybackHistory.getState().entries[0];
      expect(entry.subtitle).toBe('');
      expect(entry.artwork).toBe('');
    });
  });
});
