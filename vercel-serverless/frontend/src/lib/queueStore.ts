import { create } from 'zustand';
import { Track } from './cache';

export type RepeatMode = 'off' | 'track' | 'queue';

export interface QueueState {
  currentTrack: Track | null;

  /** Context queue — tracks from album / playlist / auto-play */
  queue: Track[];

  /** User-added priority queue — plays before context queue */
  manualQueue: Track[];

  /** History stack — tracks already played (LIFO) */
  reverseQueue: Track[];

  shuffle: boolean;
  repeatMode: RepeatMode;

  /**
   * F2: Session ID for the current context queue batch.
   * Prevents duplicate appends of the same recommendation set.
   */
  queueSessionId: string | null;

  // Actions
  playTrack: (track: Track) => void;
  addToQueue: (track: Track) => void;
  setQueue: (tracks: Track[], startIndex?: number) => void;
  next: () => void;
  previous: () => void;
  rearrangeQueue: (fromIndex: number, toIndex: number) => void;
  toggleShuffle: () => void;
  setRepeatMode: (mode: RepeatMode) => void;
  clearQueue: () => void;

  // ─── F2: Atomic queue mutations ──────────────────────────────────────
  /** Append tracks to the end of the context queue, deduplicating. */
  appendQueue: (tracks: Track[]) => void;
  /** Replace the entire context queue, clearing manual queue. */
  replaceQueue: (tracks: Track[], sessionId?: string) => void;
  /**
   * F1+F2: Enqueue recommendation tracks with dedup + session guard.
   * If the same sessionId is already active, the call is a no-op.
   */
  enqueueRecommendations: (tracks: Track[], sessionId: string) => void;
  /** Reorder the combined upcoming view (manual + context). */
  reorderQueue: (fromIndex: number, toIndex: number) => void;
}

// -----------------------------------------------------------------
// Helper: Fisher-Yates shuffle (returns a new array)
// -----------------------------------------------------------------
function shuffleArray<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// -----------------------------------------------------------------
// Helper: remove the first occurrence of a track from an array
// -----------------------------------------------------------------
function removeTrackById(tracks: Track[], videoId: string): Track[] {
  const idx = tracks.findIndex(t => t.videoId === videoId);
  if (idx === -1) return tracks;
  return [...tracks.slice(0, idx), ...tracks.slice(idx + 1)];
}

/**
 * F2: Deduplicate a track array against a set of existing video IDs.
 * Returns only tracks whose videoId is NOT in `existingIds`,
 * and also deduplicates within the input array itself.
 */
function deduplicateTracks(incoming: Track[], existingIds: Set<string>): Track[] {
  const out: Track[] = [];
  const seen = new Set(existingIds);
  for (const t of incoming) {
    if (seen.has(t.videoId)) continue;
    seen.add(t.videoId);
    out.push(t);
  }
  return out;
}

/** Collect all videoIds currently in the queue state */
function allQueueIds(state: Pick<QueueState, 'currentTrack' | 'queue' | 'manualQueue'>): Set<string> {
  const ids = new Set<string>();
  if (state.currentTrack) ids.add(state.currentTrack.videoId);
  for (const t of state.queue) ids.add(t.videoId);
  for (const t of state.manualQueue) ids.add(t.videoId);
  return ids;
}

// -----------------------------------------------------------------
// Zustand store
// -----------------------------------------------------------------
export const useQueue = create<QueueState>((set, get) => ({
  currentTrack: null,
  queue: [],
  manualQueue: [],
  reverseQueue: [],
  shuffle: false,
  repeatMode: 'off',
  queueSessionId: null,

  // ---------------------------------------------------------------
  // playTrack — user explicitly selects a track
  // Pushes current track to history, then plays the selected track.
  // Removes the track from manualQueue / queue if it's already there.
  // ---------------------------------------------------------------
  playTrack: (track: Track) => {
    const { currentTrack, reverseQueue, manualQueue, queue } = get();

    const newReverseQueue = currentTrack
      ? [...reverseQueue, currentTrack]
      : reverseQueue;

    set({
      currentTrack: track,
      reverseQueue: newReverseQueue,
      manualQueue: removeTrackById(manualQueue, track.videoId),
      queue: removeTrackById(queue, track.videoId),
    });
  },

  // ---------------------------------------------------------------
  // addToQueue — user explicitly queues a track (priority queue)
  // Deduplicates if already present in manualQueue.
  // ---------------------------------------------------------------
  addToQueue: (track: Track) => {
    const { manualQueue } = get();
    const alreadyQueued = manualQueue.some(t => t.videoId === track.videoId);
    if (alreadyQueued) return;
    set({ manualQueue: [...manualQueue, track] });
  },

  // ---------------------------------------------------------------
  // setQueue — load an entirely new context queue (e.g. playlist /
  // album). Optionally start playback from startIndex.
  // ---------------------------------------------------------------
  setQueue: (tracks: Track[], startIndex = 0) => {
    const { currentTrack, reverseQueue, shuffle } = get();

    const startTrack = tracks[startIndex] ?? tracks[0] ?? null;
    const remaining = tracks.filter((_, i) => i !== (startIndex ?? 0));

    const contextQueue = shuffle ? shuffleArray(remaining) : remaining;

    const newReverseQueue = currentTrack
      ? [...reverseQueue, currentTrack]
      : reverseQueue;

    set({
      currentTrack: startTrack,
      queue: contextQueue,
      manualQueue: [],
      reverseQueue: startTrack ? newReverseQueue : reverseQueue,
      queueSessionId: null, // reset session on manual queue load
    });
  },

  // ---------------------------------------------------------------
  // next — advance playback
  // Priority: repeatMode=track > manualQueue > queue > repeatMode=queue
  // ---------------------------------------------------------------
  next: () => {
    const { currentTrack, manualQueue, queue, reverseQueue, repeatMode, shuffle } = get();

    // Repeat current track — no queue changes
    if (repeatMode === 'track' && currentTrack) {
      // Trigger re-play of same track by setting it again
      set({ currentTrack: { ...currentTrack } });
      return;
    }

    // Push current track to history
    const newReverseQueue = currentTrack
      ? [...reverseQueue, currentTrack]
      : reverseQueue;

    // 1️⃣ Manual queue has priority
    if (manualQueue.length > 0) {
      const [nextTrack, ...remainingManual] = manualQueue;
      set({
        currentTrack: nextTrack,
        manualQueue: remainingManual,
        reverseQueue: newReverseQueue,
      });
      return;
    }

    // 2️⃣ Context queue
    if (queue.length > 0) {
      let nextTrack: Track;
      let newQueue: Track[];

      if (shuffle) {
        // Pick a random track from the context queue
        const idx = Math.floor(Math.random() * queue.length);
        nextTrack = queue[idx];
        newQueue = [...queue.slice(0, idx), ...queue.slice(idx + 1)];
      } else {
        [nextTrack, ...newQueue] = queue;
      }

      set({
        currentTrack: nextTrack,
        queue: newQueue,
        reverseQueue: newReverseQueue,
      });
      return;
    }

    // 3️⃣ Context queue exhausted — repeat queue recycles history
    if (repeatMode === 'queue' && newReverseQueue.length > 0) {
      const recycled = shuffle
        ? shuffleArray(newReverseQueue)
        : [...newReverseQueue];

      const [nextTrack, ...newQueue] = recycled;
      set({
        currentTrack: nextTrack,
        queue: newQueue,
        reverseQueue: [],
      });
      return;
    }

    // 4️⃣ Nothing left — stop playback
    set({ currentTrack: null, reverseQueue: newReverseQueue });
  },

  // ---------------------------------------------------------------
  // previous — go back in history (Spotify behaviour)
  // Pushes currentTrack to the FRONT of the context queue so it's
  // still reachable with next(). Pops from history stack.
  // ---------------------------------------------------------------
  previous: () => {
    const { currentTrack, reverseQueue, queue } = get();

    if (reverseQueue.length === 0) {
      // No history — restart current track
      if (currentTrack) set({ currentTrack: { ...currentTrack } });
      return;
    }

    const newReverseQueue = [...reverseQueue];
    const previousTrack = newReverseQueue.pop()!;

    // Re-insert current track at front of context queue
    const newQueue = currentTrack ? [currentTrack, ...queue] : queue;

    set({
      currentTrack: previousTrack,
      reverseQueue: newReverseQueue,
      queue: newQueue,
    });
  },

  // ---------------------------------------------------------------
  // rearrangeQueue — drag-and-drop reordering of upcoming tracks
  // Operates on the combined upcoming view: [manualQueue, queue].
  // History and currentTrack are never affected.
  // ---------------------------------------------------------------
  rearrangeQueue: (fromIndex: number, toIndex: number) => {
    const { manualQueue, queue } = get();

    // Build combined upcoming list for rearranging
    const combined = [...manualQueue, ...queue];

    if (
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= combined.length ||
      toIndex >= combined.length ||
      fromIndex === toIndex
    ) {
      return;
    }

    const reordered = [...combined];
    const [moved] = reordered.splice(fromIndex, 1);
    reordered.splice(toIndex, 0, moved);

    // Re-split: the first `manualQueue.length` slots stay as manualQueue,
    // but since the user is explicitly rearranging we keep lengths stable.
    const newManual = reordered.slice(0, manualQueue.length);
    const newQueue = reordered.slice(manualQueue.length);

    set({ manualQueue: newManual, queue: newQueue });
  },

  // ---------------------------------------------------------------
  // toggleShuffle
  // When turning shuffle ON: shuffle the current context queue.
  // When turning shuffle OFF: leave queue order as-is (already shuffled
  // state is preserved — matches Spotify behaviour).
  // ---------------------------------------------------------------
  toggleShuffle: () => {
    const { shuffle, queue } = get();
    if (!shuffle) {
      set({ shuffle: true, queue: shuffleArray(queue) });
    } else {
      set({ shuffle: false });
    }
  },

  // ---------------------------------------------------------------
  // setRepeatMode
  // ---------------------------------------------------------------
  setRepeatMode: (mode: RepeatMode) => {
    set({ repeatMode: mode });
  },

  // ---------------------------------------------------------------
  // clearQueue — wipe all upcoming tracks, keep history
  // ---------------------------------------------------------------
  clearQueue: () => {
    set({ queue: [], manualQueue: [], queueSessionId: null });
  },

  // ─── F2: Atomic queue mutations ──────────────────────────────────

  appendQueue: (tracks: Track[]) => {
    const state = get();
    const existing = allQueueIds(state);
    const deduped = deduplicateTracks(tracks, existing);
    if (deduped.length === 0) return;
    set({ queue: [...state.queue, ...deduped] });
  },

  replaceQueue: (tracks: Track[], sessionId?: string) => {
    // Deduplicate within the incoming list itself
    const deduped = deduplicateTracks(tracks, new Set<string>());
    set({
      queue: deduped,
      manualQueue: [],
      queueSessionId: sessionId ?? null,
    });
  },

  enqueueRecommendations: (tracks: Track[], sessionId: string) => {
    const state = get();
    // Guard: if the same session already populated the queue, skip
    if (state.queueSessionId === sessionId) {
      console.log('[Queue] Duplicate recommendation session ignored:', sessionId);
      return;
    }
    const existing = allQueueIds(state);
    const deduped = deduplicateTracks(tracks, existing);
    if (deduped.length === 0) return;
    set({
      queue: [...state.queue, ...deduped],
      queueSessionId: sessionId,
    });
  },

  reorderQueue: (fromIndex: number, toIndex: number) => {
    // Alias for rearrangeQueue for cleaner API naming
    get().rearrangeQueue(fromIndex, toIndex);
  },
}));
