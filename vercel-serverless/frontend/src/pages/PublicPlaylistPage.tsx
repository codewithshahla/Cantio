import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Play, Music, User, Clock, Share2, ListMusic, Loader2 } from 'lucide-react';
import { usePlayer } from '../services/player';
import { Track } from '../lib/cache';

const API_URL = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';

interface PublicPlaylistData {
  id: string;
  name: string;
  description: string | null;
  thumbnail: string | null;
  shareSlug: string;
  createdAt: string;
  user: {
    username: string;
    name: string | null;
    avatar: string | null;
  };
  tracks: Array<{
    id: string;
    trackId: string;
    title: string;
    artist: string;
    thumbnail: string | null;
    duration: number | null;
    position: number;
  }>;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function PublicPlaylistPage() {
  const { slug } = useParams<{ slug: string }>();
  const { play, addToQueue, currentTrack, state } = usePlayer();
  const [playlist, setPlaylist] = useState<PublicPlaylistData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;
    setLoading(true);
    setError(null);

    fetch(`${API_URL}/playlists/public/${slug}`)
      .then(async res => {
        if (!res.ok) throw new Error('Playlist not found');
        const data = await res.json();
        setPlaylist(data.playlist);
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [slug]);

  const handlePlayAll = () => {
    if (!playlist || playlist.tracks.length === 0) return;
    const tracks: Track[] = playlist.tracks.map(t => ({
      videoId: t.trackId,
      title: t.title,
      artist: t.artist,
      thumbnail: t.thumbnail || '',
      duration: t.duration || 0,
    }));
    play(tracks[0]);
    tracks.slice(1).forEach(t => addToQueue(t));
  };

  const handlePlayTrack = (track: PublicPlaylistData['tracks'][0]) => {
    play({
      videoId: track.trackId,
      title: track.title,
      artist: track.artist,
      thumbnail: track.thumbnail || '',
      duration: track.duration || 0,
    });
  };

  const handleShare = async () => {
    const url = window.location.href;
    try {
      if (navigator.share) {
        await navigator.share({
          title: playlist?.name || 'Playlist',
          text: `Check out this playlist on Cantio`,
          url,
        });
      } else {
        await navigator.clipboard.writeText(url);
        alert('Link copied!');
      }
    } catch {}
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 size={32} className="text-purple-400 animate-spin" />
      </div>
    );
  }

  if (error || !playlist) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center px-4">
        <ListMusic size={64} className="text-gray-700 mb-4" />
        <h2 className="text-2xl font-bold text-gray-400 mb-2">Playlist not found</h2>
        <p className="text-gray-500 mb-6">This playlist may be private or doesn't exist.</p>
        <Link
          to="/"
          className="px-5 py-2.5 bg-purple-600 hover:bg-purple-500 text-white text-sm font-medium rounded-full transition-colors"
        >
          Go Home
        </Link>
      </div>
    );
  }

  const coverImage = playlist.thumbnail || playlist.tracks[0]?.thumbnail || '';
  const totalDuration = playlist.tracks.reduce((s, t) => s + (t.duration || 0), 0);

  return (
    <div className="max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-end gap-4 sm:gap-6 mb-8">
        {coverImage && (
          <motion.img
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            src={coverImage}
            alt={playlist.name}
            className="w-40 h-40 sm:w-48 sm:h-48 rounded-xl object-cover shadow-2xl"
          />
        )}
        <div className="flex-1 min-w-0">
          <p className="text-xs uppercase tracking-wider text-purple-400 font-medium mb-1">
            Public Playlist
          </p>
          <h1 className="text-3xl sm:text-4xl font-black text-white mb-2 truncate">
            {playlist.name}
          </h1>
          {playlist.description && (
            <p className="text-sm text-gray-400 mb-3 line-clamp-2">{playlist.description}</p>
          )}
          <div className="flex items-center gap-3 text-sm text-gray-400">
            <div className="flex items-center gap-1.5">
              <User size={14} />
              <span>{playlist.user.name || playlist.user.username}</span>
            </div>
            <span>•</span>
            <span>{playlist.tracks.length} songs</span>
            {totalDuration > 0 && (
              <>
                <span>•</span>
                <span>{Math.floor(totalDuration / 60)} min</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3 mb-6">
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          onClick={handlePlayAll}
          className="flex items-center gap-2 px-6 py-3 bg-purple-600 hover:bg-purple-500 text-white font-semibold rounded-full transition-colors"
        >
          <Play size={20} fill="white" />
          Play All
        </motion.button>
        <button
          onClick={handleShare}
          className="p-3 bg-white/5 hover:bg-white/10 rounded-full transition-colors text-gray-400 hover:text-white"
        >
          <Share2 size={20} />
        </button>
      </div>

      {/* Track list */}
      <div className="space-y-1">
        {playlist.tracks.map((track, index) => {
          const isPlaying = currentTrack?.videoId === track.trackId && state === 'playing';

          return (
            <motion.div
              key={track.id}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: index * 0.02 }}
              onClick={() => handlePlayTrack(track)}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/10 cursor-pointer group"
            >
              <span className="w-6 text-right text-sm text-gray-500 flex-shrink-0">
                {isPlaying ? (
                  <div className="flex gap-0.5 items-center justify-end">
                    <div className="w-0.5 h-3 bg-green-500 animate-pulse" />
                    <div className="w-0.5 h-3 bg-green-500 animate-pulse delay-75" />
                    <div className="w-0.5 h-3 bg-green-500 animate-pulse delay-150" />
                  </div>
                ) : (
                  index + 1
                )}
              </span>
              <img
                src={track.thumbnail || ''}
                alt={track.title}
                className="w-10 h-10 rounded object-cover flex-shrink-0"
              />
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-medium truncate ${isPlaying ? 'text-green-500' : 'text-white'}`}>
                  {track.title}
                </p>
                <p className="text-xs text-gray-400 truncate">{track.artist}</p>
              </div>
              {track.duration && track.duration > 0 && (
                <span className="text-xs text-gray-500 flex-shrink-0">
                  {formatDuration(track.duration)}
                </span>
              )}
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
