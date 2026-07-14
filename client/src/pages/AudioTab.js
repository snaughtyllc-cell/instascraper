import React, { useState, useEffect, useCallback } from 'react';
import { getTrendingAudio } from '../api';
import API_URL from '../api-base';

function formatCount(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

export default function AudioTab() {
  const [audio, setAudio] = useState([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await getTrendingAudio();
      setAudio(data.audio || []);
    } catch (err) {
      console.error('Failed to load trending audio:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <div className="mb-5">
        <h2 className="text-xl font-semibold text-white">Trending Audio</h2>
        <p className="text-sm text-gray-500 mt-1">
          Sounds heating up across the roster — ranked by distinct creators, recency, and reach.
        </p>
      </div>

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
          <p className="text-gray-400">No trending audio yet.</p>
          <p className="text-gray-600 text-sm mt-1.5">Audio is captured on each reel scrape — run a scrape, then check back.</p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {audio.map((a, i) => (
            <div key={a.audio_id} className="bg-gray-900 rounded-xl border border-gray-800 p-4 flex items-start gap-4">
              <span className="shrink-0 w-8 h-8 rounded-lg bg-gold/15 border border-gold/30 flex items-center justify-center text-gold font-bold">
                {i + 1}
              </span>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="text-white font-medium truncate">{a.audio_title || 'Original audio'}</h3>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-semibold border ${
                    a.is_original_audio ? 'bg-gold/15 text-gold border-gold/30' : 'bg-gray-800 text-gray-400 border-gray-700'
                  }`}>
                    {a.is_original_audio ? 'Original' : 'Licensed'}
                  </span>
                  <span className="shrink-0 text-[11px] text-gray-600">score {a.trend_score}</span>
                </div>
                {a.audio_author && <p className="text-sm text-gray-400 truncate">{a.audio_author}</p>}

                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-medium text-gray-400">
                  <span className="text-emerald-400">{formatCount(a.reel_count)} reels</span>
                  <span>·</span>
                  <span>{formatCount(a.creator_count)} creators</span>
                  <span>·</span>
                  <span>{formatCount(a.total_views)} views</span>
                  <a
                    href={`https://www.instagram.com/reels/audio/${a.audio_id}/`}
                    target="_blank" rel="noopener noreferrer"
                    className="text-gold hover:text-gold-light"
                  >
                    Open on Instagram ↗
                  </a>
                </div>
              </div>

              {a.exampleReels?.length > 0 && (
                <div className="shrink-0 flex gap-1.5">
                  {a.exampleReels.map((reel) => (
                    <a
                      key={reel.id ?? reel.shortcode}
                      href={reel.post_url || `https://www.instagram.com/reel/${reel.shortcode}/`}
                      target="_blank" rel="noopener noreferrer"
                      title={`@${reel.account_handle} · ${formatCount(reel.view_count)} views`}
                      className="block w-12 h-16 rounded-md overflow-hidden bg-gray-800 border border-gray-700 hover:border-gray-600"
                    >
                      <img
                        src={reel.id != null ? `${API_URL}/thumb/${reel.id}` : ''}
                        alt=""
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    </a>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
