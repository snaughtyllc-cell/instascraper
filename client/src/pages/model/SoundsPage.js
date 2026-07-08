import React, { useState, useEffect, useCallback } from 'react';
import { getMyTrendingAudio } from '../../api';
import IdeaReel from '../../components/IdeaReel';

function formatCount(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

export default function SoundsPage() {
  const [audio, setAudio] = useState([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await getMyTrendingAudio();
      setAudio(data.audio || []);
    } catch (err) {
      console.error('Failed to load trending audio:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="px-3 py-3 space-y-3">
      {loading ? (
        <div className="flex items-center justify-center py-20 text-gray-500">
          <svg className="w-6 h-6 animate-spin mr-2" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
          Loading…
        </div>
      ) : audio.length === 0 ? (
        <div className="text-center py-20">
          <p className="text-gray-400 text-base">No trending sounds yet.</p>
          <p className="text-gray-600 text-sm mt-1.5">As reels in your niche come in, the sounds heating up will show up here.</p>
        </div>
      ) : (
        audio.map((a, i) => {
          const igAudio = `https://www.instagram.com/reels/audio/${a.audio_id}/`;
          return (
            <article key={a.audio_id} className="bg-gray-900 rounded-2xl border border-gray-800/70 p-4">
              <div className="flex items-start gap-3">
                <span className="shrink-0 w-7 h-7 rounded-lg bg-gold/15 border border-gold/30 flex items-center justify-center text-gold text-sm font-bold">
                  {i + 1}
                </span>
                <div className="flex-1 min-w-0">
                  <h3 className="text-white font-semibold leading-tight truncate">
                    {a.audio_title || 'Original audio'}
                  </h3>
                  {a.audio_author && <p className="text-gray-400 text-sm truncate">{a.audio_author}</p>}
                </div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-semibold border ${
                  a.is_original_audio
                    ? 'bg-gold/15 text-gold border-gold/30'
                    : 'bg-gray-800 text-gray-400 border-gray-700'
                }`}>
                  {a.is_original_audio ? 'Original' : 'Licensed'}
                </span>
              </div>

              <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-semibold text-gray-400">
                <span className="text-emerald-400">{formatCount(a.reel_count)} reels</span>
                <span className="w-[3px] h-[3px] rounded-full bg-gray-600" />
                <span>{formatCount(a.creator_count)} creators</span>
                <span className="w-[3px] h-[3px] rounded-full bg-gray-600" />
                <span>{formatCount(a.total_views)} views</span>
              </div>

              {a.exampleReels?.length > 0 && (
                <div className="mt-3 grid grid-cols-3 gap-2.5">
                  {a.exampleReels.map((reel) => (
                    <IdeaReel key={reel.id ?? reel.shortcode} reel={reel} />
                  ))}
                </div>
              )}

              <a
                href={igAudio}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 w-full flex items-center justify-center gap-1.5 rounded-lg border border-gray-700 bg-gray-800 px-2 py-2 text-xs font-semibold text-gray-300 hover:text-white hover:border-gray-600"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 19V6l12-2v13M9 19a3 3 0 11-6 0 3 3 0 016 0zM21 17a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                Use this sound on Instagram
              </a>
            </article>
          );
        })
      )}
    </div>
  );
}
