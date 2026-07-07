import React, { useState, useEffect, useCallback } from 'react';
import { getMyIdeas } from '../../api';

function formatDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function IdeasPage() {
  const [ideas, setIdeas] = useState([]);
  const [loading, setLoading] = useState(false);

  const loadIdeas = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await getMyIdeas();
      setIdeas(data.ideas || []);
    } catch (err) {
      console.error('Failed to load ideas:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadIdeas();
  }, [loadIdeas]);

  return (
    <div className="px-3 py-4 space-y-3">
      {loading ? (
        <div className="flex items-center justify-center py-20 text-gray-500">
          <svg className="w-6 h-6 animate-spin mr-2" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
          Loading…
        </div>
      ) : ideas.length === 0 ? (
        <div className="text-center py-20">
          <p className="text-gray-500 text-lg">No ideas yet.</p>
          <p className="text-gray-600 text-sm mt-1">Content ideas built from trending reels in your niche will show up here.</p>
        </div>
      ) : (
        ideas.map((idea) => (
          <div key={idea.id} className="bg-gray-900 rounded-xl border border-gray-800 p-4 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <h3 className="text-base font-semibold text-white leading-snug">{idea.concept}</h3>
              {idea.format && (
                <span className="shrink-0 px-2 py-0.5 rounded-full text-xs font-medium bg-gold/20 text-gold border border-gold/40">
                  {idea.format}
                </span>
              )}
            </div>

            {idea.hook_line && (
              <p className="text-sm text-gray-300 italic">&ldquo;{idea.hook_line}&rdquo;</p>
            )}

            {idea.why_working && (
              <p className="text-xs text-gray-400 leading-relaxed">{idea.why_working}</p>
            )}

            {idea.stale_warning && (
              <p className="text-xs text-yellow-500">{idea.stale_warning}</p>
            )}

            <div className="flex items-center justify-between pt-1">
              {idea.source_niche && (
                <span className="text-xs text-gray-600">{idea.source_niche}</span>
              )}
              <span className="text-xs text-gray-600">{formatDate(idea.created_at)}</span>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
