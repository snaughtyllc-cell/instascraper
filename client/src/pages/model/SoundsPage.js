import React, { useState, useEffect, useCallback } from 'react';
import { getMyTrendingAudio } from '../../api';
import IdeaReel from '../../components/IdeaReel';

const FILTERS = [
  { id: 'all', label: 'All sounds', dot: 'bg-model-coral' },
  { id: 'original', label: 'Original', dot: 'bg-model-butter' },
  { id: 'music', label: 'Music', dot: 'bg-model-sage' },
];

const CARD_ACCENTS = [
  { tile: 'bg-model-coral/25 text-model-ink', line: 'bg-model-coral' },
  { tile: 'bg-model-sage text-model-ink', line: 'bg-[#8FA586]' },
  { tile: 'bg-model-butter text-model-ink', line: 'bg-[#D2AE3F]' },
];

function formatCount(value) {
  const count = Number(value) || 0;
  if (count >= 1_000_000) return (count / 1_000_000).toFixed(1) + 'M';
  if (count >= 1_000) return (count / 1_000).toFixed(1) + 'K';
  return String(count);
}

export default function SoundsPage() {
  const [audio, setAudio] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await getMyTrendingAudio();
      setAudio(data.audio || []);
    } catch (err) {
      console.error('Failed to load trending audio:', err);
      setError(err.response?.data?.error || 'We could not load your trending sounds.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const visibleAudio = audio.filter((sound) => {
    if (filter === 'original') return Boolean(sound.is_original_audio);
    if (filter === 'music') return !sound.is_original_audio;
    return true;
  });

  const emptyTitle = filter === 'original'
    ? 'No original sounds yet.'
    : filter === 'music'
      ? 'No music is trending yet.'
      : 'No trending sounds yet.';

  return (
    <div className="min-h-[calc(100vh-9rem)] bg-model-canvas text-model-ink">
      <div className="mx-auto max-w-xl px-3 pb-6 pt-4 sm:px-4">
        <header className="mb-4">
          <div className="flex items-end justify-between gap-4 px-1">
            <div className="min-w-0">
              <h2 className="text-base font-black text-model-ink">Trending sounds</h2>
              <p className="mt-0.5 text-xs font-medium text-model-muted">Moving across creators in your niche</p>
            </div>
            {!loading && !error && (
              <span className="mb-0.5 shrink-0 rounded-full border border-model-line bg-model-surface px-2.5 py-1 text-[11px] font-bold text-model-muted shadow-sm">
                {visibleAudio.length} {visibleAudio.length === 1 ? 'sound' : 'sounds'}
              </span>
            )}
          </div>

          <div className="mt-3 grid grid-cols-3 gap-1 rounded-lg border border-model-line bg-model-line/40 p-1" role="group" aria-label="Filter trending sounds">
            {FILTERS.map((option) => {
              const active = filter === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setFilter(option.id)}
                  aria-pressed={active}
                  className={`flex min-h-[36px] items-center justify-center gap-1.5 rounded-md px-2 text-xs font-bold transition-colors focus:outline-none focus:ring-2 focus:ring-[#191917]/20 ${
                    active
                      ? 'bg-model-surface text-model-ink shadow-sm'
                      : 'text-model-muted hover:bg-model-surface/70 hover:text-model-ink'
                  }`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${option.dot}`} aria-hidden="true" />
                  {option.label}
                </button>
              );
            })}
          </div>
        </header>

        {loading ? (
          <div className="flex items-center justify-center py-20 text-sm font-semibold text-model-muted">
            <svg className="mr-2 h-5 w-5 animate-spin text-model-coral" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
            </svg>
            Loading sounds...
          </div>
        ) : error ? (
          <div className="mx-auto max-w-sm py-16 text-center">
            <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-lg bg-model-coral/20 text-[#A64F43]">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.5m0 3h.01M10.3 4.4L3.2 17a2 2 0 001.74 3h14.12a2 2 0 001.74-3L13.7 4.4a2 2 0 00-3.4 0z" />
              </svg>
            </div>
            <p className="mt-3 text-base font-bold text-model-ink">Audio did not load</p>
            <p className="mt-1 text-sm leading-relaxed text-model-muted">{error}</p>
            <button
              type="button"
              onClick={load}
              className="mt-4 inline-flex min-h-[40px] items-center justify-center gap-2 rounded-lg bg-model-ink px-4 text-sm font-bold text-white transition-colors hover:bg-black focus:outline-none focus:ring-2 focus:ring-model-ink/25 focus:ring-offset-2 focus:ring-offset-model-canvas"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v6h6M20 20v-6h-6M5.6 18.4A9 9 0 0018.4 5.6" />
              </svg>
              Try again
            </button>
          </div>
        ) : visibleAudio.length === 0 ? (
          <div className="py-20 text-center">
            <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-lg bg-model-butter text-[#665721]">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 19V6l12-2v13M9 19a3 3 0 11-6 0 3 3 0 016 0zM21 17a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </div>
            <p className="mt-3 text-base font-bold text-model-ink">{emptyTitle}</p>
            <p className="mx-auto mt-1.5 max-w-xs text-sm leading-relaxed text-model-muted">
              As reels in your niche come in, the sounds heating up will show up here.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {visibleAudio.map((sound, index) => {
              const accent = CARD_ACCENTS[index % CARD_ACCENTS.length];
              const examples = (sound.exampleReels || []).slice(0, 3);
              const soundKey = sound.audio_id || `${sound.audio_title || 'sound'}-${sound.audio_author || 'unknown'}-${index}`;

              return (
                <article
                  key={soundKey}
                  className="rounded-lg border border-model-line bg-model-surface p-3.5 shadow-[0_8px_24px_rgba(47,42,35,0.06)] sm:p-4"
                >
                  <div className="flex items-start gap-3">
                    <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg ${accent.tile}`}>
                      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2} aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 18V5l11-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zM20 16a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-bold text-model-muted">#{String(index + 1).padStart(2, '0')}</span>
                        <span className={`h-1 w-5 rounded-full ${accent.line}`} aria-hidden="true" />
                        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${
                          sound.is_original_audio
                            ? 'border-[#D8C66D] bg-model-butter/70 text-[#66531C]'
                            : 'border-[#AFCDBE] bg-model-sage/60 text-[#40513E]'
                        }`}>
                          {sound.is_original_audio ? 'Original audio' : 'Music'}
                        </span>
                      </div>
                      <h3 className="mt-1 truncate text-[15px] font-bold leading-tight text-model-ink">
                        {sound.audio_title || 'Original audio'}
                      </h3>
                      {sound.audio_author && (
                        <p className="mt-0.5 truncate text-xs font-medium text-model-muted">{sound.audio_author}</p>
                      )}
                    </div>

                    {sound.audio_id && (
                      <a
                        href={`https://www.instagram.com/reels/audio/${sound.audio_id}/`}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Open sound on Instagram"
                        aria-label="Open sound on Instagram"
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-model-line bg-white text-model-muted transition-colors hover:bg-model-butter/50 hover:text-model-ink focus:outline-none focus:ring-2 focus:ring-model-ink/20"
                      >
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M14 5h5v5m0-5l-8 8M19 13v5a1 1 0 01-1 1H6a1 1 0 01-1-1V6a1 1 0 011-1h5" />
                        </svg>
                      </a>
                    )}
                  </div>

                  <div className="mt-3 grid grid-cols-3 divide-x divide-model-line border-y border-model-line">
                    <div className="px-2 py-2.5 text-center">
                      <p className="text-base font-bold leading-none text-[#B65F53]">{formatCount(sound.creator_count)}</p>
                      <p className="mt-1 text-[10px] font-bold text-model-muted">Unique creators</p>
                    </div>
                    <div className="px-2 py-2.5 text-center">
                      <p className="text-base font-bold leading-none text-[#63765F]">{formatCount(sound.reel_count)}</p>
                      <p className="mt-1 text-[10px] font-bold text-model-muted">Reels</p>
                    </div>
                    <div className="px-2 py-2.5 text-center">
                      <p className="text-base font-bold leading-none text-[#8A6D19]">{formatCount(sound.total_views)}</p>
                      <p className="mt-1 text-[10px] font-bold text-model-muted">Total views</p>
                    </div>
                  </div>

                  {examples.length > 0 && (
                    <div className="mt-3.5">
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <p className="text-[10px] font-bold uppercase text-model-muted">Example reels</p>
                        <span className="text-[10px] font-semibold text-model-muted/70">Top {examples.length}</span>
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        {examples.map((reel, reelIndex) => (
                          <IdeaReel
                            key={`${soundKey}-${reel.id ?? reel.shortcode ?? reelIndex}`}
                            reel={reel}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
