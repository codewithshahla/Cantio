import { create } from 'zustand';

export type SleepTimerMode = 'off' | 'duration' | 'end_of_song';

export interface SleepTimerState {
  /** Whether the timer is actively counting down */
  isActive: boolean;
  /** Current mode */
  mode: SleepTimerMode;
  /** When the timer will fire (epoch ms), null when inactive */
  endsAt: number | null;
  /** Seconds remaining — updated every second for UI */
  remaining: number;

  // Actions
  /** Start a duration-based timer (seconds) */
  startTimer: (seconds: number) => void;
  /** Set "end of current song" mode — player calls `trigger()` on track end */
  setEndOfSong: () => void;
  /** Cancel the timer */
  cancel: () => void;
  /** Called by the player when a track ends (handles end-of-song mode) */
  onTrackEnd: () => boolean;
  /** Called by the tick interval to decrement remaining */
  tick: () => void;
}

let tickInterval: ReturnType<typeof setInterval> | null = null;

function startTicking() {
  stopTicking();
  tickInterval = setInterval(() => {
    useSleepTimer.getState().tick();
  }, 1_000);
}

function stopTicking() {
  if (tickInterval !== null) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
}

export const useSleepTimer = create<SleepTimerState>((set, get) => ({
  isActive: false,
  mode: 'off',
  endsAt: null,
  remaining: 0,

  startTimer: (seconds: number) => {
    const endsAt = Date.now() + seconds * 1000;
    set({
      isActive: true,
      mode: 'duration',
      endsAt,
      remaining: seconds,
    });
    startTicking();
  },

  setEndOfSong: () => {
    set({
      isActive: true,
      mode: 'end_of_song',
      endsAt: null,
      remaining: 0,
    });
    // No ticking needed — player will call onTrackEnd()
    stopTicking();
  },

  cancel: () => {
    stopTicking();
    set({
      isActive: false,
      mode: 'off',
      endsAt: null,
      remaining: 0,
    });
  },

  onTrackEnd: (): boolean => {
    const { isActive, mode } = get();
    if (!isActive) return false;

    if (mode === 'end_of_song') {
      // Timer fires! Pause playback.
      get().cancel();
      return true; // signal caller to pause
    }

    return false;
  },

  tick: () => {
    const { isActive, mode, endsAt } = get();
    if (!isActive || mode !== 'duration' || !endsAt) return;

    const remaining = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
    set({ remaining });

    if (remaining <= 0) {
      // Timer expired — pause playback
      get().cancel();

      // Dynamically import to avoid circular dependency
      import('../services/player').then(({ usePlayer }) => {
        const { state, ytPlayer } = usePlayer.getState();
        if (state === 'playing' && ytPlayer) {
          ytPlayer.pauseVideo();
          usePlayer.setState({ state: 'paused' });
          console.log('💤 Sleep timer: paused playback');
        }
      });
    }
  },
}));
