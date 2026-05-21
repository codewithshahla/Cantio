import { create } from 'zustand';
import localforage from 'localforage';

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────

/** Every searchable entity type the system may encounter. */
export type SearchEntityType =
  | 'song'
  | 'artist'
  | 'album'
  | 'playlist'
  | 'podcast'
  | 'genre';

/** A single entry in the search-origin play history. */
export interface SearchPlaybackEntry {
  /** Unique ID for the entity (videoId for songs, browseId for artists/albums, playlistId for playlists, etc.) */
  id: string;
  type: SearchEntityType;
  title: string;
  subtitle: string;
  artwork: string;
  /** The search query that was active when the user interacted with this item. */
  searchQuery: string;
  /** Unix timestamp (ms) of the most recent interaction. */
  playedAt: number;
}

/** Shape persisted to IndexedDB. */
interface SearchPlaybackSnapshot {
  entries: SearchPlaybackEntry[];
  version: number;
}

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

const SNAPSHOT_VERSION = 1;
const MAX_ENTRIES = 20;

/** Valid entity types for validation. */
const VALID_ENTITY_TYPES: ReadonlySet<string> = new Set<SearchEntityType>([
  'song', 'artist', 'album', 'playlist', 'podcast', 'genre',
]);

// ─────────────────────────────────────────────────────────────────────
// IndexedDB adapter
// ─────────────────────────────────────────────────────────────────────

const historyStore = localforage.createInstance({
  name: 'cantio',
  storeName: 'search_playback_history',
});

async function persistSnapshot(snapshot: SearchPlaybackSnapshot): Promise<void> {
  try {
    await historyStore.setItem('history', snapshot);
  } catch (err) {
    console.error('[SearchPlaybackHistory] Persist error:', err);
  }
}

async function loadSnapshot(): Promise<SearchPlaybackSnapshot | null> {
  try {
    const data = await historyStore.getItem<SearchPlaybackSnapshot>('history');
    if (!data || !isValidSnapshot(data)) {
      if (data) {
        console.warn('[SearchPlaybackHistory] Corrupted snapshot detected, discarding');
        await historyStore.removeItem('history');
      }
      return null;
    }
    return data;
  } catch (err) {
    console.error('[SearchPlaybackHistory] Load error:', err);
    return null;
  }
}

async function clearPersistedHistory(): Promise<void> {
  try {
    await historyStore.removeItem('history');
  } catch (err) {
    console.error('[SearchPlaybackHistory] Clear error:', err);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────

function isValidSnapshot(snapshot: unknown): snapshot is SearchPlaybackSnapshot {
  if (!snapshot || typeof snapshot !== 'object') return false;
  const s = snapshot as Record<string, unknown>;
  if (s.version !== SNAPSHOT_VERSION) return false;
  if (!Array.isArray(s.entries)) return false;
  // Validate each entry minimally — strip invalid entries rather than
  // rejecting the entire snapshot, so partial corruption is recoverable.
  return true;
}

function isValidEntry(entry: unknown): entry is SearchPlaybackEntry {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;
  if (typeof e.id !== 'string' || !e.id) return false;
  if (typeof e.type !== 'string' || !VALID_ENTITY_TYPES.has(e.type)) return false;
  if (typeof e.title !== 'string' || !e.title) return false;
  if (typeof e.playedAt !== 'number' || !Number.isFinite(e.playedAt)) return false;
  // subtitle and artwork may be missing on old entries — normalize instead of reject
  return true;
}

/**
 * Sanitize entries loaded from persistence:
 *  - strip invalid/malformed entries
 *  - ensure string fields have sensible defaults
 *  - deduplicate by id (keep newest)
 *  - trim to MAX_ENTRIES
 */
function sanitizeEntries(raw: unknown[]): SearchPlaybackEntry[] {
  const seen = new Set<string>();
  const clean: SearchPlaybackEntry[] = [];

  for (const item of raw) {
    if (!isValidEntry(item)) continue;

    // Deduplicate — keep only the first (newest) occurrence
    if (seen.has(item.id)) continue;
    seen.add(item.id);

    clean.push({
      id: item.id,
      type: item.type,
      title: item.title,
      subtitle: typeof item.subtitle === 'string' ? item.subtitle : '',
      artwork: typeof item.artwork === 'string' ? item.artwork : '',
      searchQuery: typeof item.searchQuery === 'string' ? item.searchQuery : '',
      playedAt: item.playedAt,
    });
  }

  // Already sorted newest-first from the store, but enforce just in case
  clean.sort((a, b) => b.playedAt - a.playedAt);

  return clean.slice(0, MAX_ENTRIES);
}

// ─────────────────────────────────────────────────────────────────────
// Debounced persistence
// ─────────────────────────────────────────────────────────────────────

let _persistTimer: ReturnType<typeof setTimeout> | null = null;

function _schedulePersist(): void {
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    const { entries } = useSearchPlaybackHistory.getState();
    persistSnapshot({ entries, version: SNAPSHOT_VERSION });
  }, 300);
}

// ─────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────

export interface SearchPlaybackHistoryState {
  entries: SearchPlaybackEntry[];
  hydrated: boolean;

  /** Load history from IndexedDB. Idempotent — only runs once. */
  hydrate: () => Promise<void>;

  /**
   * Record a search-origin play event.
   * If an entry with the same `id` already exists, it is bumped to the top
   * with an updated timestamp. Otherwise a new entry is prepended and the
   * list is trimmed to MAX_ENTRIES.
   */
  recordPlay: (entry: Omit<SearchPlaybackEntry, 'playedAt'>) => void;

  /** Remove a single entry by id. */
  removeEntry: (id: string) => void;

  /** Wipe all history. */
  clearHistory: () => void;
}

export const useSearchPlaybackHistory = create<SearchPlaybackHistoryState>((set, get) => ({
  entries: [],
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return;

    const snapshot = await loadSnapshot();
    if (!snapshot) {
      set({ hydrated: true });
      return;
    }

    const entries = sanitizeEntries(snapshot.entries);
    set({ entries, hydrated: true });
    console.log(`[SearchPlaybackHistory] Hydrated ${entries.length} entries`);
  },

  recordPlay: (incoming) => {
    // Validate the incoming entry defensively
    if (!incoming.id || typeof incoming.id !== 'string') {
      console.warn('[SearchPlaybackHistory] recordPlay: missing id, ignoring');
      return;
    }
    if (!incoming.type || !VALID_ENTITY_TYPES.has(incoming.type)) {
      console.warn('[SearchPlaybackHistory] recordPlay: unsupported type', incoming.type);
      return;
    }
    if (!incoming.title || typeof incoming.title !== 'string') {
      console.warn('[SearchPlaybackHistory] recordPlay: missing title, ignoring');
      return;
    }

    const now = Date.now();
    const { entries } = get();

    // Remove existing entry with same id (dedup — will re-add at top)
    const filtered = entries.filter((e) => e.id !== incoming.id);

    const newEntry: SearchPlaybackEntry = {
      id: incoming.id,
      type: incoming.type,
      title: incoming.title,
      subtitle: incoming.subtitle || '',
      artwork: incoming.artwork || '',
      searchQuery: incoming.searchQuery || '',
      playedAt: now,
    };

    // Prepend (newest first) and trim
    const updated = [newEntry, ...filtered].slice(0, MAX_ENTRIES);

    set({ entries: updated });
    _schedulePersist();
  },

  removeEntry: (id: string) => {
    const { entries } = get();
    const updated = entries.filter((e) => e.id !== id);
    if (updated.length === entries.length) return; // nothing removed
    set({ entries: updated });
    _schedulePersist();
  },

  clearHistory: () => {
    set({ entries: [] });
    clearPersistedHistory();
  },
}));
