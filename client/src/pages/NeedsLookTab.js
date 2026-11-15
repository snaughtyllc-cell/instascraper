import React, { useCallback, useEffect, useRef, useState } from 'react';
import { archivePost, createSuggestedType, getContentTypes, getNeedsLook, setPostContentType } from '../api';
import API_URL from '../api-base';
import { LookTagChips } from '../components/LookTags';

const PAGE_SIZE = 24;

export default function NeedsLookTab({ onTotalChange }) {
  const [posts, setPosts] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [types, setTypes] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState({});
  const [error, setError] = useState('');
  const request = useRef(0);

  const load = useCallback(async () => {
    const current = ++request.current;
    setLoading(true);
    try {
      const [pile, contentTypes] = await Promise.all([
        getNeedsLook({ page, limit: PAGE_SIZE }),
        getContentTypes(),
      ]);
      if (current !== request.current) return;
      setError('');
      const count = Number(pile.data.total || 0);
      setPosts(pile.data.posts || []);
      setSuggestions(pile.data.suggestions || []);
      setTotal(count);
      setTypes(contentTypes.data);
      onTotalChange?.(count);
      const lastPage = Math.max(1, Math.ceil(count / PAGE_SIZE));
      if (page > lastPage) setPage(lastPage);
    } catch (err) {
      if (current === request.current) setError(err.response?.data?.error || err.message);
    } finally {
      if (current === request.current) setLoading(false);
    }
  }, [page, onTotalChange]);

  useEffect(() => {
    load();
    return () => { request.current += 1; };
  }, [load]);

  const act = async (key, action) => {
    setPending((values) => ({ ...values, [key]: true }));
    setError('');
    try {
      await action();
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setPending((values) => ({ ...values, [key]: false }));
    }
  };

  const labelFor = (value) => types.find((type) => type.value === value)?.label || value;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold text-white">Needs a look</h2>
          <p className="mt-1 text-sm text-gray-400">{total} reels waiting for a type. Pick one to make a reel available to matching models.</p>
        </div>
        <button onClick={() => { setError(''); load(); }} disabled={loading} className="rounded-lg bg-gray-800 px-3 py-2 text-sm text-gray-200 hover:bg-gray-700 disabled:opacity-50">Refresh</button>
      </div>

      {error && <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</div>}

      {suggestions.length > 0 && (
        <section aria-label="Suggested new content types" className="flex flex-wrap gap-3">
          {suggestions.map((suggestion) => (
            <div key={suggestion.value} className="rounded-xl border border-gray-800 bg-gray-900 px-4 py-3">
              <p className="text-sm text-gray-300"><strong className="text-white">{suggestion.label}</strong> — {suggestion.count} reels</p>
              <button
                disabled={Boolean(pending[`type:${suggestion.value}`]) || loading}
                onClick={() => act(`type:${suggestion.value}`, () => createSuggestedType(suggestion.value))}
                className="mt-2 rounded-lg bg-gold px-3 py-2 text-xs font-semibold text-gray-950 hover:bg-gold-light disabled:opacity-50"
              >
                {pending[`type:${suggestion.value}`] ? 'Assigning...' : 'Create type & assign all'}
              </button>
            </div>
          ))}
        </section>
      )}

      {loading ? (
        <div role="status" className="py-20 text-center text-sm text-gray-500">Loading reels...</div>
      ) : posts.length === 0 ? (
        <div className="rounded-xl border border-gray-800 bg-gray-900 px-5 py-12 text-center text-gray-400">{error ? 'Could not load reels. Refresh to try again.' : 'No reels need a look.'}</div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {posts.map((post) => (
            <article key={post.id} className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
              <video
                src={`${API_URL}/video/${post.id}`}
                poster={`${API_URL}/thumb/${post.id}`}
                controls
                playsInline
                preload="none"
                aria-label={`Reel by ${post.account_handle}`}
                className="aspect-[4/5] w-full bg-black object-contain"
              />
              <div className="space-y-3 p-3">
                <p className="text-sm font-medium text-gold">@{post.account_handle}</p>
                <p className="text-xs text-gray-400">
                  AI guess: <span className="text-gray-200">{labelFor(post.ai_type) || post.ai_suggested_type || 'No matching type'}</span>
                  {post.ai_confidence != null && ` · ${Math.round(Number(post.ai_confidence) * 100)}% confidence`}
                </p>
                <p className="text-sm leading-relaxed text-gray-300">{post.ai_description || 'No description available.'}</p>
                <LookTagChips tags={post.ai_look_tags} />
                {post.ai_error && <p className="text-xs text-red-300">{post.ai_error}</p>}
                <div className="flex flex-wrap gap-1.5" aria-label="Choose a content type">
                  {types.map((type) => (
                    <button
                      key={type.value}
                      disabled={Boolean(pending[post.id]) || loading}
                      onClick={() => act(post.id, () => setPostContentType(post.id, type.value))}
                      className="rounded-lg border border-gray-700 bg-gray-800 px-2.5 py-2 text-xs text-gray-200 hover:border-gold hover:text-gold disabled:opacity-50"
                    >{type.label}</button>
                  ))}
                </div>
                <button
                  disabled={Boolean(pending[post.id]) || loading}
                  onClick={() => act(post.id, () => archivePost(post.id, true))}
                  className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-xs text-gray-400 hover:text-white disabled:opacity-50"
                >{pending[post.id] ? 'Saving...' : 'Not useful'}</button>
              </div>
            </article>
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3">
          <button disabled={page === 1 || loading} onClick={() => setPage((value) => value - 1)} className="rounded-lg bg-gray-800 px-3 py-2 text-sm text-gray-300 disabled:opacity-30">Previous</button>
          <span className="text-sm text-gray-400">Page {page} of {totalPages}</span>
          <button disabled={page === totalPages || loading} onClick={() => setPage((value) => value + 1)} className="rounded-lg bg-gray-800 px-3 py-2 text-sm text-gray-300 disabled:opacity-30">Next</button>
        </div>
      )}
    </div>
  );
}
