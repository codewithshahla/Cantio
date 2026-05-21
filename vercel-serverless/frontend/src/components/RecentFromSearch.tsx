import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Clock, X, ChevronRight, ChevronUp, ListMusic, Disc3, Mic2, PlayCircle } from 'lucide-react';
import {
  useSearchPlaybackHistory,
  SearchPlaybackEntry,
  SearchEntityType,
} from '../lib/searchPlaybackHistoryStore';
import { usePlayer } from '../services/player';

/** Icon for each entity type. */
function EntityIcon({ type, size = 14 }: { type: SearchEntityType; size?: number }) {
  switch (type) {
    case 'song':     return <ListMusic size={size} />;
    case 'album':    return <Disc3 size={size} />;
    case 'artist':   return <Mic2 size={size} />;
    case 'playlist': return <PlayCircle size={size} />;
    default:         return <ListMusic size={size} />;
  }
}

/** Format "2 minutes ago", "1 hour ago", etc. */
function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60)   return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)   return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24)     return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7)       return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Card component — renders a single history entry */
function HistoryCard({
  entry,
  index,
  onPlay,
  onRemove,
}: {
  entry: SearchPlaybackEntry;
  index: number;
  onPlay: (entry: SearchPlaybackEntry) => void;
  onRemove: (e: React.MouseEvent, id: string) => void;
}) {
  return (
    <motion.div
      key={entry.id}
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      transition={{ delay: index * 0.025 }}
      onClick={() => onPlay(entry)}
      className="flex-shrink-0 w-[120px] sm:w-[140px] bg-white/5 hover:bg-white/10 active:bg-white/15 rounded-xl p-2 sm:p-2.5 cursor-pointer transition-colors group relative touch-manipulation"
    >
      {/* Remove button — always visible on mobile, hover-reveal on desktop */}
      <button
        onClick={(e) => onRemove(e, entry.id)}
        className="absolute top-1 right-1 sm:top-1.5 sm:right-1.5 p-1.5 sm:p-1 rounded-full bg-black/60 text-gray-400 hover:text-white hover:bg-black/80 sm:opacity-0 sm:group-hover:opacity-100 transition-all z-10"
        aria-label={`Remove ${entry.title}`}
      >
        <X size={12} />
      </button>

      {/* Artwork */}
      <div className="relative mb-1.5 sm:mb-2">
        {entry.artwork ? (
          <img
            src={entry.artwork}
            alt={entry.title}
            loading="lazy"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
              const fallback = (e.target as HTMLImageElement).nextElementSibling;
              if (fallback) (fallback as HTMLElement).style.display = 'flex';
            }}
            className="w-full aspect-square object-cover rounded-lg"
          />
        ) : null}
        <div
          className={`w-full aspect-square rounded-lg bg-white/10 items-center justify-center text-gray-500 ${entry.artwork ? 'hidden' : 'flex'}`}
        >
          <EntityIcon type={entry.type} size={22} />
        </div>
      </div>

      {/* Text */}
      <p className="text-[11px] sm:text-xs font-semibold text-white truncate leading-tight">{entry.title}</p>
      {entry.subtitle && (
        <p className="text-[10px] sm:text-[11px] text-gray-400 truncate mt-0.5 leading-tight">{entry.subtitle}</p>
      )}

      {/* Meta: type badge + time */}
      <div className="flex items-center gap-1 mt-1 sm:mt-1.5 flex-wrap">
        <span className="inline-flex items-center gap-0.5 text-[9px] sm:text-[10px] text-gray-500 bg-white/5 rounded px-1 sm:px-1.5 py-0.5 capitalize leading-none">
          <EntityIcon type={entry.type} size={9} />
          {entry.type}
        </span>
        <span className="text-[9px] sm:text-[10px] text-gray-600 leading-none">{timeAgo(entry.playedAt)}</span>
      </div>
    </motion.div>
  );
}

interface RecentFromSearchProps {
  /** Maximum number of items to show before "View All". Defaults to 6. */
  maxVisible?: number;
}

export function RecentFromSearch({ maxVisible = 6 }: RecentFromSearchProps) {
  const navigate = useNavigate();
  const { entries, removeEntry, clearHistory, hydrated } = useSearchPlaybackHistory();
  const { playWithRecommendations } = usePlayer();

  const [expanded, setExpanded] = useState(false);

  if (!hydrated || entries.length === 0) return null;

  const visibleEntries = expanded ? entries : entries.slice(0, maxVisible);
  const hasMore = !expanded && entries.length > maxVisible;

  // ── Click handlers ──────────────────────────────────────────────

  const handleEntryClick = async (entry: SearchPlaybackEntry) => {
    switch (entry.type) {
      case 'song':
        await playWithRecommendations({
          videoId: entry.id,
          title: entry.title,
          artist: entry.subtitle,
          duration: 0,
          thumbnail: entry.artwork,
        });
        break;
      case 'playlist':
        navigate(`/ytmusic/playlist/${entry.id}`);
        break;
      case 'album':
        navigate(`/ytmusic/album/${entry.id}`);
        break;
      case 'artist':
        navigate(`/ytmusic/artist/${entry.id}`);
        break;
      default:
        console.log(`[RecentFromSearch] No handler for type: ${entry.type}`);
    }
  };

  const handleRemove = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    removeEntry(id);
  };

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-2 sm:mb-3">
        <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
          <Clock size={14} className="text-gray-400 flex-shrink-0 sm:w-4 sm:h-4" />
          <h3 className="text-xs sm:text-sm font-semibold text-gray-300 uppercase tracking-wide truncate">
            Recent From Search
          </h3>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {hasMore && (
            <button
              onClick={() => setExpanded(true)}
              className="text-[11px] sm:text-xs text-gray-400 hover:text-white active:text-white transition-colors font-medium flex items-center gap-0.5 touch-manipulation"
            >
              All ({entries.length})
              <ChevronRight size={12} />
            </button>
          )}
          {expanded && entries.length > maxVisible && (
            <button
              onClick={() => setExpanded(false)}
              className="text-[11px] sm:text-xs text-gray-400 hover:text-white active:text-white transition-colors font-medium flex items-center gap-0.5 touch-manipulation"
            >
              Less
              <ChevronUp size={12} />
            </button>
          )}
          {entries.length > 0 && (
            <button
              onClick={() => clearHistory()}
              className="text-[11px] sm:text-xs text-gray-400 hover:text-red-400 active:text-red-400 transition-colors px-2 sm:px-3 py-1 rounded-full bg-white/5 hover:bg-red-500/10 active:bg-red-500/10 font-medium touch-manipulation"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Scrollable card strip (collapsed) / Grid (expanded on md+) */}
      {!expanded ? (
        // Horizontal scrolling strip — works great on all sizes
        <div className="flex gap-2 sm:gap-2.5 overflow-x-auto pb-2 scrollbar-hide -mx-1 px-1 snap-x snap-mandatory">
          <AnimatePresence mode="popLayout">
            {visibleEntries.map((entry, index) => (
              <div key={entry.id} className="snap-start">
                <HistoryCard
                  entry={entry}
                  index={index}
                  onPlay={handleEntryClick}
                  onRemove={handleRemove}
                />
              </div>
            ))}
          </AnimatePresence>
        </div>
      ) : (
        // Expanded view: responsive grid
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8 gap-2 sm:gap-2.5">
          <AnimatePresence mode="popLayout">
            {visibleEntries.map((entry, index) => (
              <HistoryCard
                key={entry.id}
                entry={entry}
                index={index}
                onPlay={handleEntryClick}
                onRemove={handleRemove}
              />
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
