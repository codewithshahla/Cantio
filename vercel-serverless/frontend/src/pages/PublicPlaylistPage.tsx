import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Music, Play, ChevronLeft, Loader2, Share2 } from 'lucide-react';
import { usePlaylist, Playlist, PlaylistTrack } from '../lib/playlistStore';
import { usePlayer } from '../services/player';

export function PublicPlaylistPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { getPublicPlaylist } = usePlaylist();
  const { play, replaceQueue, currentTrack, state } = usePlayer();
  const [playlist, setPlaylist] = useState<Playlist | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (id) {
      loadPlaylist();
    }
  }, [id]);

  const loadPlaylist = async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const data = await getPublicPlaylist(id);
      setPlaylist(data);
    } catch (e: any) {
      setError(e.message || 'Failed to load playlist');
    } finally {
      setLoading(false);
    }
  };

  const handleShare = async () => {
    if (!playlist) return;
    const url = `${window.location.origin}/public/playlist/${playlist.id}`;
    try {
      if (navigator.share) {
        await navigator.share({
          title: playlist.name,
          text: `Listen to "${playlist.name}" on Cantio`,
          url
        });
      } else {
        await navigator.clipboard.writeText(url);
        alert('Link copied to clipboard!');
      }
    } catch (err) {
      if (err instanceof Error && err.name !== 'AbortError') {
        console.error('Share failed:', err);
      }
    }
  };

  const handlePlayAll = async () => {
    if (!playlist?.tracks || playlist.tracks.length === 0) return;
    const [first, ...rest] = playlist.tracks;
    await play({
      videoId: first.trackId,
      title: first.title,
      artist: first.artist,
      thumbnail: first.thumbnail || '',
      duration: first.duration || 0
    });
    await replaceQueue(
      rest.map(track => ({
        videoId: track.trackId,
        title: track.title,
        artist: track.artist,
        thumbnail: track.thumbnail || '',
        duration: track.duration || 0
      })),
      `public:${playlist.id}`
    );
  };

  const handlePlayTrack = async (track: PlaylistTrack, index: number) => {
    if (!playlist?.tracks) return;
    await play({
      videoId: track.trackId,
      title: track.title,
      artist: track.artist,
      thumbnail: track.thumbnail || '',
      duration: track.duration || 0
    });
    const remainder = playlist.tracks.slice(index + 1).map(t => ({
      videoId: t.trackId,
      title: t.title,
      artist: t.artist,
      thumbnail: t.thumbnail || '',
      duration: t.duration || 0
    }));
    await replaceQueue(remainder, `public:${playlist.id}:${track.trackId}`);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <Loader2 size={40} className="animate-spin text-gray-400" />
      </div>
    );
  }

  if (error || !playlist) {
    return (
      <div className="text-center py-20">
        <Music size={64} className="mx-auto mb-4 text-gray-700" />
        <h3 className="text-2xl font-bold text-gray-400">Playlist not available</h3>
        {error && <p className="text-gray-500 mt-2">{error}</p>}
      </div>
    );
  }

  const tracks = playlist.tracks || [];

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <button
        onClick={() => navigate('/search')}
        className="flex items-center gap-2 text-gray-400 hover:text-white transition-colors"
      >
        <ChevronLeft size={20} />
        <span>Back</span>
      </button>

      <div className="flex items-start gap-6">
        <div className="w-48 h-48 bg-gradient-to-br from-purple-500 to-pink-500 rounded-2xl flex items-center justify-center flex-shrink-0">
          <Music size={80} className="text-white/80" />
        </div>
        <div className="flex-1 pt-4">
          <p className="text-sm font-semibold uppercase tracking-wider text-gray-400 mb-2">
            Public Playlist
          </p>
          <h1 className="text-4xl md:text-5xl font-black mb-4">{playlist.name}</h1>
          {playlist.description && (
            <p className="text-gray-400 mb-4">{playlist.description}</p>
          )}
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <span className="font-semibold">{playlist.user?.name || playlist.user?.username || 'Creator'}</span>
            <span>•</span>
            <span>{tracks.length} {tracks.length === 1 ? 'song' : 'songs'}</span>
          </div>
          <div className="flex items-center gap-3 mt-4">
            {tracks.length > 0 && (
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handlePlayAll}
                className="w-14 h-14 bg-green-500 rounded-full flex items-center justify-center hover:bg-green-400 transition-colors shadow-xl"
              >
                <Play size={24} fill="black" className="text-black ml-1" />
              </motion.button>
            )}
            <button
              onClick={handleShare}
              className="flex items-center gap-2 px-4 py-2 bg-white/10 hover:bg-white/20 rounded-full text-sm font-semibold transition-colors"
            >
              <Share2 size={16} />
              Share
            </button>
          </div>
        </div>
      </div>

      {tracks.length > 0 ? (
        <div className="space-y-1">
          {tracks.map((track, index) => {
            const isPlaying = currentTrack?.videoId === track.trackId && state === 'playing';
            return (
              <motion.div
                key={track.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: index * 0.03 }}
                onClick={() => handlePlayTrack(track, index)}
                className="flex items-center gap-4 px-4 py-3 rounded-lg hover:bg-white/10 active:bg-white/15 cursor-pointer group"
              >
                <div className="w-6 text-center text-gray-400 text-sm">
                  {isPlaying ? (
                    <div className="flex gap-0.5 items-center justify-center">
                      <div className="w-0.5 h-3 bg-green-500 animate-pulse" />
                      <div className="w-0.5 h-3 bg-green-500 animate-pulse delay-75" />
                      <div className="w-0.5 h-3 bg-green-500 animate-pulse delay-150" />
                    </div>
                  ) : (
                    <span>{index + 1}</span>
                  )}
                </div>
                <img
                  src={track.thumbnail || ''}
                  alt={track.title}
                  className="w-12 h-12 rounded-lg object-cover flex-shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-medium truncate ${isPlaying ? 'text-green-500' : 'text-white'}`}>
                    {track.title}
                  </p>
                  <p className="text-xs text-gray-400 truncate mt-0.5">
                    {track.artist}
                  </p>
                </div>
              </motion.div>
            );
          })}
        </div>
      ) : (
        <div className="text-center py-20">
          <Music size={64} className="mx-auto mb-4 text-gray-700" />
          <h3 className="text-2xl font-bold text-gray-400">No tracks yet</h3>
        </div>
      )}
    </div>
  );
}
