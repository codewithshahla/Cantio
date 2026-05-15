import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Music, Globe, Mic2, Disc3, ChevronRight, Sparkles, X } from 'lucide-react';
import { useAuth, api } from '../lib/authStore';

const LANGUAGES = [
  'English', 'Hindi', 'Tamil', 'Telugu', 'Malayalam', 'Kannada',
  'Bengali', 'Marathi', 'Punjabi', 'Spanish', 'Korean', 'Japanese',
  'French', 'Arabic', 'Portuguese', 'German', 'Russian', 'Chinese',
];

const GENRES = [
  'Pop', 'Rock', 'Hip Hop', 'R&B', 'EDM', 'Jazz', 'Classical',
  'Indie', 'Metal', 'Country', 'Reggae', 'Latin', 'K-Pop', 'Lo-Fi',
  'Bollywood', 'Carnatic', 'Devotional', 'Folk', 'Sufi', 'Trap',
];

interface OnboardingStep {
  title: string;
  description: string;
  icon: React.ReactNode;
}

const STEPS: OnboardingStep[] = [
  {
    title: 'Favorite Languages',
    description: 'What languages do you enjoy music in?',
    icon: <Globe size={24} />,
  },
  {
    title: 'Favorite Artists',
    description: 'Name some artists you love (type and press Enter)',
    icon: <Mic2 size={24} />,
  },
  {
    title: 'Favorite Genres',
    description: 'Pick the genres that match your vibe',
    icon: <Disc3 size={24} />,
  },
];

export default function OnboardingPage() {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  const [step, setStep] = useState(0);
  const [languages, setLanguages] = useState<string[]>([]);
  const [artists, setArtists] = useState<string[]>([]);
  const [artistInput, setArtistInput] = useState('');
  const [genres, setGenres] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(true); // guard: skip if already onboarded

  useEffect(() => {
    if (!isAuthenticated) { navigate('/login'); return; }

    // Check if this user actually needs onboarding — redirect to / if already done
    api.fetch('/preferences/needs-onboarding')
      .then(r => r.json())
      .then(data => {
        if (!data.needsOnboarding) {
          navigate('/');
        } else {
          setChecking(false);
        }
      })
      .catch(() => {
        // If check fails, show onboarding anyway (safe fallback)
        setChecking(false);
      });
  }, [isAuthenticated, navigate]);

  const toggleItem = (
    list: string[],
    setter: (v: string[]) => void,
    item: string
  ) => {
    if (list.includes(item)) {
      setter(list.filter(i => i !== item));
    } else {
      setter([...list, item]);
    }
  };

  const addArtist = () => {
    const trimmed = artistInput.trim();
    if (trimmed && !artists.includes(trimmed)) {
      setArtists([...artists, trimmed]);
    }
    setArtistInput('');
  };

  const removeArtist = (name: string) => {
    setArtists(artists.filter(a => a !== name));
  };

  const handleFinish = async () => {
    setSaving(true);
    try {
      // Save to user_preferences (marks onboardingDone and stores choices)
      await api.fetch('/preferences', {
        method: 'POST',
        body: JSON.stringify({
          favoriteLanguages: languages,
          favoriteArtists: artists,
          favoriteGenres: genres,
          onboardingDone: true,
        }),
      });

      // Fire-and-forget: seed recommendations from preferences in the background.
      // Non-blocking — if this fails, user still gets to the home page.
      api.fetch('/preferences/seed', { method: 'POST' }).catch(() => {});

      navigate('/');
    } catch (err) {
      console.error('Failed to save preferences:', err);
      // Still navigate — preferences are non-critical
      navigate('/');
    } finally {
      setSaving(false);
    }
  };

  const handleSkip = async () => {
    try {
      await api.fetch('/preferences', {
        method: 'POST',
        body: JSON.stringify({ onboardingDone: true }),
      });
    } catch {
      // silent
    }
    navigate('/');
  };

  // Show spinner while checking onboarding status
  if (checking) {
    return (
      <div className="flex items-center justify-center min-h-[calc(100vh-12rem)]">
        <div className="w-8 h-8 rounded-full border-2 border-purple-500 border-t-transparent animate-spin" />
      </div>
    );
  }

  const isLastStep = step === STEPS.length - 1;

  return (
    <div className="flex items-center justify-center min-h-[calc(100vh-12rem)]">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-lg"
      >
        <div className="glass p-6 sm:p-8 rounded-2xl">
          {/* Header */}
          <div className="text-center mb-6">
            <div className="flex items-center justify-center gap-2 mb-3">
              <Sparkles size={20} className="text-purple-400" />
              <span className="text-xs font-medium text-purple-400 uppercase tracking-wider">
                Personalize Your Experience
              </span>
            </div>
            <h1 className="text-2xl font-bold mb-1">Welcome to Cantio!</h1>
            <p className="text-gray-400 text-sm">
              Tell us about your music taste for better recommendations
            </p>
          </div>

          {/* Step progress */}
          <div className="flex gap-1.5 mb-6">
            {STEPS.map((_, i) => (
              <div
                key={i}
                className={`h-1 flex-1 rounded-full transition-colors ${
                  i <= step ? 'bg-purple-500' : 'bg-white/10'
                }`}
              />
            ))}
          </div>

          {/* Step content */}
          <AnimatePresence mode="wait">
            <motion.div
              key={step}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.2 }}
            >
              <div className="flex items-center gap-3 mb-4">
                <div className="p-2 rounded-lg bg-purple-500/20 text-purple-400">
                  {STEPS[step].icon}
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-white">{STEPS[step].title}</h2>
                  <p className="text-xs text-gray-400">{STEPS[step].description}</p>
                </div>
              </div>

              {/* Step 0: Languages */}
              {step === 0 && (
                <div className="flex flex-wrap gap-2 max-h-[240px] overflow-y-auto py-1">
                  {LANGUAGES.map(lang => (
                    <button
                      key={lang}
                      onClick={() => toggleItem(languages, setLanguages, lang)}
                      className={`px-3 py-1.5 rounded-full text-sm font-medium transition-all ${
                        languages.includes(lang)
                          ? 'bg-purple-600 text-white'
                          : 'bg-white/5 text-gray-300 hover:bg-white/10'
                      }`}
                    >
                      {lang}
                    </button>
                  ))}
                </div>
              )}

              {/* Step 1: Artists */}
              {step === 1 && (
                <div>
                  <div className="flex gap-2 mb-3">
                    <input
                      type="text"
                      value={artistInput}
                      onChange={e => setArtistInput(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addArtist())}
                      placeholder="e.g., Taylor Swift"
                      className="flex-1 px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 focus:border-purple-500 focus:ring-1 focus:ring-purple-500/30 outline-none text-sm text-white placeholder-gray-500"
                    />
                    <button
                      onClick={addArtist}
                      disabled={!artistInput.trim()}
                      className="px-4 py-2.5 bg-purple-600 hover:bg-purple-500 disabled:opacity-30 text-white text-sm font-medium rounded-lg transition-colors"
                    >
                      Add
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-2 max-h-[200px] overflow-y-auto">
                    {artists.map(name => (
                      <span
                        key={name}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-purple-600/20 text-purple-300 rounded-full text-sm"
                      >
                        {name}
                        <button onClick={() => removeArtist(name)} className="hover:text-white transition-colors">
                          <X size={14} />
                        </button>
                      </span>
                    ))}
                    {artists.length === 0 && (
                      <p className="text-gray-500 text-sm">No artists added yet — type above and press Enter</p>
                    )}
                  </div>
                </div>
              )}

              {/* Step 2: Genres */}
              {step === 2 && (
                <div className="flex flex-wrap gap-2 max-h-[240px] overflow-y-auto py-1">
                  {GENRES.map(genre => (
                    <button
                      key={genre}
                      onClick={() => toggleItem(genres, setGenres, genre)}
                      className={`px-3 py-1.5 rounded-full text-sm font-medium transition-all ${
                        genres.includes(genre)
                          ? 'bg-purple-600 text-white'
                          : 'bg-white/5 text-gray-300 hover:bg-white/10'
                      }`}
                    >
                      {genre}
                    </button>
                  ))}
                </div>
              )}
            </motion.div>
          </AnimatePresence>

          {/* Navigation */}
          <div className="flex items-center justify-between mt-6 pt-4 border-t border-white/5">
            <button
              onClick={handleSkip}
              className="text-sm text-gray-400 hover:text-white transition-colors"
            >
              Skip for now
            </button>
            <div className="flex gap-2">
              {step > 0 && (
                <button
                  onClick={() => setStep(step - 1)}
                  className="px-4 py-2 text-sm bg-white/5 hover:bg-white/10 rounded-lg text-gray-300 transition-colors"
                >
                  Back
                </button>
              )}
              {isLastStep ? (
                <button
                  onClick={handleFinish}
                  disabled={saving}
                  className="flex items-center gap-2 px-5 py-2 text-sm font-medium bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white rounded-lg transition-colors"
                >
                  {saving ? 'Saving...' : 'Finish'}
                  <Sparkles size={16} />
                </button>
              ) : (
                <button
                  onClick={() => setStep(step + 1)}
                  className="flex items-center gap-1 px-5 py-2 text-sm font-medium bg-purple-600 hover:bg-purple-500 text-white rounded-lg transition-colors"
                >
                  Next
                  <ChevronRight size={16} />
                </button>
              )}
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
