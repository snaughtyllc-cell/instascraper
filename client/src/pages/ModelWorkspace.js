import React, { useCallback, useEffect, useState } from 'react';
import {
  getWorkspace, getWorkspaceCreators, addWorkspaceCreator, removeWorkspaceCreator,
  getWorkspaceReels, getWorkspaceProposals, refreshWorkspaceProposals, confirmWorkspaceProposal,
  rejectWorkspaceProposal, confirmAllWorkspaceProposals, getWorkspaceSuggestions,
  approveWorkspaceSuggestion, dismissWorkspaceSuggestion, snoozeWorkspaceSuggestion,
  getContentTypes, getLookTags, getWorkspaceTaste, addCreatorLookTag, removeCreatorLookTag,
} from '../api';
import API_URL from '../api-base';
import { SuggestedReelStrip } from './SuggestedAccountsTab';
import { LookTagChips } from '../components/LookTags';
import Transcript from '../components/Transcript';

const button = 'px-3 py-2 rounded-lg text-xs font-medium bg-gray-800 border border-gray-700 hover:border-gray-500 disabled:opacity-50';

export default function ModelWorkspace({ modelId, onBack, onEdit }) {
  const [workspace, setWorkspace] = useState(null);
  const [creators, setCreators] = useState([]);
  const [proposals, setProposals] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [reels, setReels] = useState([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [tab, setTab] = useState('Creators');
  const [username, setUsername] = useState('');
  const [labels, setLabels] = useState({});
  const [lookTags, setLookTags] = useState([]);
  const [taste, setTaste] = useState({ liked: [], disliked: [] });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const [summary, owned, proposed, routed, feed, learned, vocabulary] = await Promise.all([
      getWorkspace(modelId), getWorkspaceCreators(modelId), getWorkspaceProposals(modelId),
      getWorkspaceSuggestions(modelId), getWorkspaceReels(modelId), getWorkspaceTaste(modelId), getLookTags(),
    ]);
    setWorkspace(summary.data);
    setCreators(owned.data);
    setProposals(proposed.data);
    setSuggestions(routed.data);
    setReels(feed.data);
    setTaste(learned.data);
    setLookTags(vocabulary.data);
    setPage(1);
    setHasMore(feed.data.length === 24);
  }, [modelId]);
  useEffect(() => {
    load().catch(err => setError(err.response?.data?.error || err.message));
    getContentTypes().then(({ data }) => setLabels(Object.fromEntries(data.map(t => [t.value, t.label])))).catch(() => {});
  }, [load]);
  const act = async action => {
    setBusy(true);
    setError('');
    try { await action(); await load(); }
    catch (err) { setError(err.response?.data?.error || err.message); }
    finally { setBusy(false); }
  };
  const more = async () => {
    setBusy(true);
    try {
      const { data } = await getWorkspaceReels(modelId, page + 1);
      setReels(previous => [...previous, ...data]);
      setPage(page + 1);
      setHasMore(data.length === 24);
    } catch (err) { setError(err.response?.data?.error || err.message); }
    finally { setBusy(false); }
  };
  return (
    <div className="space-y-5">
      <button onClick={onBack} className="text-sm text-gold hover:text-gold-light">← Back to models</button>
      {error && <p role="alert" className="p-3 rounded-lg bg-red-500/10 text-red-300">{error}</p>}
      {!workspace ? <p className="text-gray-400">Loading workspace…</p> : <>
        <header>
          <h2 className="text-2xl font-bold text-white">{workspace.model.name}</h2>
          <p className="text-sm text-gray-400 mt-1">{[workspace.model.primary_niche, ...(workspace.model.secondary_niches || '').split(',')].filter(Boolean).map(n => labels[n.trim()] || n.trim()).join(' · ')}</p>
          <div className="flex flex-wrap items-center gap-3">
            <LookTagChips tags={workspace.model.look_tags} vocabulary={lookTags} />
            <button onClick={() => onEdit(workspace.model)} className="mt-2 text-xs text-gold underline underline-offset-4">Edit look</button>
          </div>
        </header>
        <section aria-labelledby="model-taste-title" className="rounded-xl border border-gray-800 bg-gray-900 p-4">
          <h3 id="model-taste-title" className="font-semibold text-white">Her taste</h3>
          <p className="mt-1 text-xs text-gray-500">Learned from her saves and reactions.</p>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            {[['liked', 'Likes', 'text-emerald-300'], ['disliked', 'Less her style', 'text-gray-400']].map(([key, title, tone]) => <div key={key}>
              <p className={`text-xs font-medium ${tone}`}>{title}</p>
              {taste[key]?.length ? <ul className="mt-2 space-y-1 text-xs text-gray-300">{taste[key].map(item => {
                const [kind, ...parts] = item.feature.split(':');
                const value = parts.join(':');
                const label = kind === 'creator' ? `@${value}` : kind === 'type' ? labels[value] || value : lookTags.find(tag => tag.value === value)?.label || value;
                return <li key={item.feature}>{label} <span className="text-gray-500">· {kind} · {item.affinity > 0 ? '+' : ''}{Number(item.affinity).toFixed(2)}</span></li>;
              })}</ul> : <p className="mt-2 text-xs text-gray-500">No signals yet.</p>}
            </div>)}
          </div>
        </section>
        {workspace.fallback && <p className="p-4 rounded-xl border border-gold/30 bg-gold/10 text-gold">No creators yet — showing every sorted reel, with her content types first.</p>}
        <div className="flex gap-2 border-b border-gray-800 pb-3" role="tablist" aria-label="Workspace sections">
          {['Creators', 'Reels', 'Suggested'].map(name => <button key={name} role="tab" aria-selected={tab === name} onClick={() => setTab(name)} className={`${button} ${tab === name ? 'text-gold border-gold' : 'text-gray-400'}`}>
            {name}{name === 'Creators' ? ` (${creators.length})` : name === 'Suggested' ? ` (${suggestions.length})` : ''}
          </button>)}
        </div>
        {tab === 'Creators' && <div className="space-y-5">
          <form onSubmit={e => { e.preventDefault(); if (username.trim()) act(async () => { await addWorkspaceCreator(modelId, username.trim()); setUsername(''); }); }} className="flex gap-2">
            <input aria-label="Add creator username" value={username} onChange={e => setUsername(e.target.value)} placeholder="@username" className="flex-1 min-w-0 bg-gray-900 border border-gray-700 rounded-lg p-3 text-sm" />
            <button disabled={busy || !username.trim()} className={`${button} text-gold`}>Add creator</button>
          </form>
          <div className="rounded-xl border border-gray-800 divide-y divide-gray-800 bg-gray-900">
            {!creators.length && <p className="p-5 text-gray-500">No creators added yet.</p>}
            {creators.map(creator => <div key={creator.username} className="flex items-center gap-4 p-4">
              <div className="flex-1 min-w-0">
                <a className="font-semibold text-gold" href={`https://instagram.com/${creator.username}`} target="_blank" rel="noopener noreferrer">@{creator.username}</a>
                <p className="text-xs text-gray-400 mt-1">{creator.mix.map(m => `${labels[m.type] || m.type} ${m.pct}%`).join(' · ') || 'No sorted reels yet'}</p>
                <LookTagChips tags={creator.look} vocabulary={lookTags} disabled={busy} onRemove={tag => act(() => removeCreatorLookTag(creator.username, tag))} />
                <select value="" aria-label={`Add look tag to @${creator.username}`} disabled={busy} onChange={e => { if (e.target.value) act(() => addCreatorLookTag(creator.username, e.target.value)); }} className="mt-2 max-w-full rounded-lg border border-gray-700 bg-gray-800 px-2 py-2 text-xs text-gray-300">
                  <option value="">+ tag</option>
                  {['hair', 'aesthetic', 'setting', 'custom'].map(category => <optgroup key={category} label={category}>{lookTags.filter(tag => tag.category === category && !creator.look?.some(item => item.tag === tag.value && item.manual)).map(tag => <option key={tag.value} value={tag.value}>{tag.label}</option>)}</optgroup>)}
                </select>
                <p className="text-xs text-gray-500 mt-1">{creator.status} · Last scraped {creator.last_scraped_at ? new Date(creator.last_scraped_at).toLocaleString() : 'Never'}</p>
              </div>
              <button disabled={busy} aria-label={`Remove @${creator.username}`} onClick={() => act(() => removeWorkspaceCreator(modelId, creator.username))} className={`${button} text-red-400`}>✕</button>
            </div>)}
          </div>
          <section className="rounded-xl border border-gray-800 bg-gray-900 p-4 space-y-3">
            <div className="flex flex-wrap justify-between items-center gap-3"><h3 className="font-semibold">Proposed creators ({proposals.length})</h3>
              <div className="flex flex-wrap gap-2">
                <button disabled={busy} onClick={() => act(() => refreshWorkspaceProposals(modelId))} className={button}>Refresh proposals</button>
                {proposals.length > 0 && <button disabled={busy} onClick={() => act(() => confirmAllWorkspaceProposals(modelId))} className={`${button} text-gold`}>Confirm all</button>}
              </div>
            </div>
            {!proposals.length && <p className="text-sm text-gray-500">No proposed creators.</p>}
            {proposals.map(proposal => <div key={proposal.username} className="flex items-center gap-2">
              <p className="flex-1 text-sm">@{proposal.username} <span className="text-gray-400">· {Math.round(proposal.share * 100)}% niche match</span><span className="mt-1 block text-xs text-gray-500">Look match {Math.round((proposal.look_match || 0) * 100)}%</span></p>
              <button disabled={busy} onClick={() => act(() => confirmWorkspaceProposal(modelId, proposal.username))} className={`${button} text-green-400`}>Confirm</button>
              <button disabled={busy} onClick={() => act(() => rejectWorkspaceProposal(modelId, proposal.username))} className={`${button} text-red-400`}>Reject</button>
            </div>)}
          </section>
        </div>}
        {tab === 'Reels' && <>
          {!reels.length && <p className="text-gray-500">No playable reels in this workspace yet.</p>}
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4">
            {reels.map(reel => <article key={reel.id} className="bg-gray-900 rounded-xl overflow-hidden border border-gray-800">
              <video src={`${API_URL}/video/${reel.id}`} poster={`${API_URL}/thumb/${reel.id}`} controls playsInline preload="none" className="w-full aspect-[9/16] object-cover bg-black" />
              <div className="p-3 text-sm"><p>@{reel.account_handle}</p><p className="text-xs text-gray-400">{labels[reel.niche] || reel.niche}{reel.ai_confidence != null && ` · ${Math.round(reel.ai_confidence * 100)}%`}</p><LookTagChips tags={reel.ai_look_tags} vocabulary={lookTags} /><Transcript transcript={reel.ai_transcript} /></div>
            </article>)}
          </div>
          {hasMore && <button disabled={busy} onClick={more} className={button}>Load more reels</button>}
        </>}
        {tab === 'Suggested' && <>
          {!suggestions.length && <p className="text-gray-500">No pending suggestions.</p>}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {suggestions.map(suggestion => <article key={suggestion.username} className="bg-gray-900 rounded-xl border border-gray-800 p-4 space-y-3">
              <div className="flex justify-between"><a href={`https://instagram.com/${suggestion.username}`} target="_blank" rel="noopener noreferrer" className="font-semibold text-gold">@{suggestion.username}</a><span className="text-sm text-gray-400">{Math.round(suggestion.fit * 100)}% fit</span></div>
              <p className="text-sm text-gray-400">{suggestion.reason}</p>
              <p className="text-xs text-gray-300">Look match {Math.round((suggestion.look_match || 0) * 100)}%</p>
              <SuggestedReelStrip reels={suggestion.top_reels} />
              <div className="flex flex-wrap gap-2">
                <button disabled={busy} onClick={() => act(() => approveWorkspaceSuggestion(modelId, suggestion.username))} className={`${button} text-green-400`}>Approve</button>
                <button disabled={busy} onClick={() => act(() => dismissWorkspaceSuggestion(modelId, suggestion.username))} className={`${button} text-red-400`}>Dismiss</button>
                <button disabled={busy} onClick={() => act(() => snoozeWorkspaceSuggestion(modelId, suggestion.username))} className={`${button} text-yellow-400`}>Snooze 7d</button>
              </div>
            </article>)}
          </div>
        </>}
      </>}
    </div>
  );
}
