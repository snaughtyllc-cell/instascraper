import React, { useState, useEffect, useRef, useCallback } from 'react';
import { tagPost, saveNotes, archivePost, setCreatorType, setPostContentType } from '../api';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:4000';

const TAG_OPTIONS = [
  { value: 'recreate', label: 'Recreate', icon: '\u2705', color: 'bg-green-600' },
  { value: 'reference', label: 'Reference', icon: '\uD83D\uDCCC', color: 'bg-blue-600' },
  { value: 'skip', label: 'Skip', icon: '\u274C', color: 'bg-red-600' },
];

function formatCount(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toString();
}

function formatViews(n) {
  if (n === null || n === undefined) return '—';
  return formatCount(n);
}

function formatViewsVsMedian(value) {
  if (!value) return null;
  return `${Number(value).toFixed(1)}x median`;
}

function formatDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const ER_COLORS = {
  Viral: 'bg-red-500/80 text-white',
  Good: 'bg-green-500/80 text-white',
  Average: 'bg-yellow-500/80 text-gray-900',
  Low: 'bg-gray-600/80 text-gray-300',
};

const BADGE_POSITIONS = {
  topLeft: 'top-2 left-2',
  topRight: 'top-2 right-2',
  bottomLeft: 'bottom-2 left-2',
  bottomRight: 'bottom-2 right-2',
};

export default function ContentCard({
  post,
  creatorTypes = {},
  contentTypes = [],
  onAddContentType,
  onUpdate,
  selected = false,
  onToggleSelect,
  variant = 'library',
  thumbnailBadges = [],
  actionSlot = null,
  autoplayInView = false,
  isActive = false,
  soundOn = false,
  onToggleSound,
  registerRef,
}) {
  const [expanded, setExpanded] = useState(false);
  const [notes, setNotes] = useState(post.notes || '');
  const [showVideo, setShowVideo] = useState(false);
  const saveTimer = useRef(null);
  const cardId = post.id ?? post.shortcode;
  const isLibrary = variant === 'library';
  const reelUrl = post.post_url || (post.shortcode ? `https://www.instagram.com/reel/${post.shortcode}/` : null);
  const thumbnailSrc = !isLibrary && post.thumbnail_url
    ? post.thumbnail_url
    : cardId
      ? `${API_URL}/thumb/${cardId}`
      : post.thumbnail_url;

  const handleTag = async (tag) => {
    const newTag = post.tag === tag ? null : tag;
    await tagPost(post.id, newTag);
    onUpdate();
  };

  const handleNotesChange = useCallback((e) => {
    const val = e.target.value;
    setNotes(val);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveNotes(post.id, val);
    }, 800);
  }, [post.id]);

  const maybeAdd = async (val, apply) => {
    if (val === '__add__') {
      const label = window.prompt('New type name:');
      if (!label || !onAddContentType) return;
      const created = await onAddContentType(label);
      if (created && created.value) await apply(created.value);
      return;
    }
    await apply(val || null);
  };

  const handleCreatorType = (e) => maybeAdd(e.target.value, (v) =>
    setCreatorType(post.account_handle, v).then(onUpdate).catch((err) => {
      window.alert('Could not set creator type: ' + (err.response?.data?.error || err.message));
      onUpdate();
    }));
  const handlePostType = (e) => maybeAdd(e.target.value, (v) =>
    setPostContentType(post.id, v).then(onUpdate).catch((err) => {
      window.alert('Could not set video type: ' + (err.response?.data?.error || err.message));
      onUpdate();
    }));

  const handleArchive = async () => {
    await archivePost(post.id, !post.archived);
    onUpdate();
  };

  const tagBadge = TAG_OPTIONS.find((t) => t.value === post.tag);

  const cardRef = useRef(null);
  useEffect(() => {
    if (!autoplayInView || !registerRef || !cardRef.current) return;
    const el = cardRef.current;
    registerRef(cardId, el);
    return () => registerRef(cardId, null);
  }, [autoplayInView, registerRef, cardId]);

  return (
    <div ref={cardRef} className={`bg-gray-900 rounded-xl border overflow-hidden group transition-colors ${selected ? 'border-gold ring-1 ring-gold/50' : 'border-gray-800 hover:border-gray-700'}`}>
      {/* Thumbnail */}
      <div className="relative aspect-[4/5] bg-gray-800 overflow-hidden">
        {onToggleSelect && (
          <label className="absolute top-2 left-2 z-10 cursor-pointer" onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              checked={selected}
              onChange={() => onToggleSelect(cardId)}
              className="w-5 h-5 rounded accent-gold"
            />
          </label>
        )}
        {(showVideo || (autoplayInView && isActive)) && post.video_url ? (
          <>
            <video
              src={post.video_url}
              autoPlay
              playsInline
              muted={autoplayInView ? !soundOn : false}
              loop={autoplayInView}
              controls={!autoplayInView}
              className="w-full h-full object-cover"
              onError={() => { /* Plan 3 wires re-resolve here */ }}
            />
            {autoplayInView && (
              <button
                onClick={(e) => { e.stopPropagation(); onToggleSound && onToggleSound(); }}
                className="absolute bottom-2 right-2 z-10 w-9 h-9 rounded-full bg-black/60 text-white flex items-center justify-center"
                title={soundOn ? 'Mute' : 'Unmute'}
              >
                {soundOn ? '🔊' : '🔇'}
              </button>
            )}
          </>
        ) : (
          <>
            <img
              src={thumbnailSrc}
              alt=""
              className="w-full h-full object-cover"
              loading="lazy"
              onError={(e) => {
                if (e.target.src !== post.thumbnail_url && post.thumbnail_url) {
                  e.target.src = post.thumbnail_url;
                }
              }}
            />
            {!autoplayInView && post.video_url && (
              <button
                onClick={() => setShowVideo(true)}
                className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <div className="w-14 h-14 rounded-full bg-white/90 flex items-center justify-center">
                  <svg className="w-6 h-6 text-gray-900 ml-1" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </div>
              </button>
            )}
          </>
        )}

        {/* Tag badge */}
        {tagBadge && (
          <div className={`absolute top-2 right-2 ${tagBadge.color} px-2 py-0.5 rounded-full text-xs font-medium text-white`}>
            {tagBadge.icon} {tagBadge.label}
          </div>
        )}

        {/* ER badge — bottom-left so it never collides with the select checkbox
            (top-left) or the tag badge (top-right) */}
        {post.er_label && (
          <div className={`absolute bottom-2 left-2 z-10 ${ER_COLORS[post.er_label] || ER_COLORS.Low} px-2 py-0.5 rounded-full text-xs font-bold`}>
            {post.er_percent}% ER
          </div>
        )}
        {post.views_vs_median && (
          <div
            title={`Median for @${post.account_handle}: ${formatViews(post.account_median_views)} views`}
            className="absolute bottom-2 right-2 bg-gold/90 text-gray-950 px-2 py-0.5 rounded-full text-xs font-bold"
          >
            {formatViewsVsMedian(post.views_vs_median)}
          </div>
        )}

        {thumbnailBadges.map((badge) => (
          <div
            key={`${badge.position || 'topRight'}-${badge.label}`}
            title={badge.title}
            className={`absolute z-10 ${BADGE_POSITIONS[badge.position] || badge.position || BADGE_POSITIONS.topRight} ${badge.className}`}
          >
            {badge.label}
          </div>
        ))}
      </div>

      <div className="p-3 space-y-2.5">
        {/* Stats */}
        <div className="flex items-center gap-3 text-xs text-gray-400">
          <span title="Views" className="flex items-center gap-1">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
            {formatViews(post.view_count)}
          </span>
          <span title="Likes" className="flex items-center gap-1">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
            </svg>
            {formatCount(post.like_count)}
          </span>
          <span title="Comments" className="flex items-center gap-1">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            {formatCount(post.comment_count)}
          </span>
          {post.followers_at_scrape > 0 && (
            <span title="Followers at scrape time" className="flex items-center gap-1">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              {formatCount(post.followers_at_scrape)}
            </span>
          )}
        </div>

        {/* Handle + Date */}
        <div className="flex items-center justify-between">
          <a
            href={`https://instagram.com/${post.account_handle}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium text-gold hover:text-gold-light transition-colors"
          >
            @{post.account_handle}
          </a>
          <span className="text-xs text-gray-500">{formatDate(post.posted_at)}</span>
        </div>

        {/* Caption */}
        {post.caption && (
          <div>
            <p className={`text-xs text-gray-300 leading-relaxed ${expanded ? '' : 'line-clamp-2'}`}>
              {post.caption}
            </p>
            {post.caption.length > 100 && (
              <button
                onClick={() => setExpanded(!expanded)}
                className="text-xs text-gold hover:text-gold-light mt-0.5"
              >
                {expanded ? 'Show less' : 'Show more'}
              </button>
            )}
          </div>
        )}

        {isLibrary && (
          <>
            {/* Tags */}
            <div className="flex gap-1.5">
              {TAG_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => handleTag(opt.value)}
                  className={`flex-1 px-2 py-1.5 rounded-lg text-xs font-medium transition-all border ${
                    post.tag === opt.value
                      ? `${opt.color} border-transparent text-white`
                      : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-white hover:border-gray-600'
                  }`}
                >
                  {opt.icon} {opt.label}
                </button>
              ))}
            </div>

            {/* Content Type Selectors */}
            <div className="flex gap-1.5">
              <select
                value={creatorTypes[post.account_handle] || ''}
                onChange={handleCreatorType}
                title="Creator default type"
                className={`flex-1 px-2 py-1.5 rounded-lg text-xs border transition-all ${
                  creatorTypes[post.account_handle]
                    ? 'bg-purple-600/20 border-purple-600/40 text-purple-300'
                    : 'bg-gray-800 border-gray-700 text-gray-500'
                }`}
              >
                <option value="">Creator...</option>
                {contentTypes.map((ct) => (
                  <option key={ct.value} value={ct.value}>{ct.label}</option>
                ))}
                <option value="__add__">＋ Add new type…</option>
              </select>
              <select
                value={post.content_type || ''}
                onChange={handlePostType}
                title="Override type for this video only"
                className={`flex-1 px-2 py-1.5 rounded-lg text-xs border transition-all ${
                  post.content_type
                    ? 'bg-orange-600/20 border-orange-600/40 text-orange-300'
                    : 'bg-gray-800 border-gray-700 text-gray-500'
                }`}
              >
                <option value="">Video...</option>
                {contentTypes.map((ct) => (
                  <option key={ct.value} value={ct.value}>{ct.label}</option>
                ))}
                <option value="__add__">＋ Add new type…</option>
              </select>
            </div>

            {/* Notes */}
            <textarea
              value={notes}
              onChange={handleNotesChange}
              placeholder="Add notes..."
              rows={2}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-gray-300 placeholder-gray-600 resize-none"
            />

            {/* Archive */}
            <button
              onClick={handleArchive}
              className={`w-full px-2 py-1.5 rounded-lg text-xs font-medium transition-all border ${
                post.archived
                  ? 'bg-yellow-600/20 border-yellow-600/40 text-yellow-400 hover:bg-yellow-600/30'
                  : 'bg-gray-800 border-gray-700 text-gray-500 hover:text-gray-300 hover:border-gray-600'
              }`}
            >
              {post.archived ? '📦 Unarchive' : '📦 Archive'}
            </button>
          </>
        )}

        {reelUrl && (
          <a
            href={reelUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-medium border border-gray-700 bg-gray-800 text-gray-300 hover:text-white hover:border-gray-600"
          >
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2.2c3.2 0 3.6 0 4.9.1 1.2.1 1.8.3 2.2.4.6.2 1 .5 1.4.9.4.4.7.8.9 1.4.1.4.3 1 .4 2.2.1 1.3.1 1.7.1 4.9s0 3.6-.1 4.9c-.1 1.2-.3 1.8-.4 2.2-.2.6-.5 1-.9 1.4-.4.4-.8.7-1.4.9-.4.1-1 .3-2.2.4-1.3.1-1.7.1-4.9.1s-3.6 0-4.9-.1c-1.2-.1-1.8-.3-2.2-.4a3.9 3.9 0 0 1-1.4-.9 3.9 3.9 0 0 1-.9-1.4c-.1-.4-.3-1-.4-2.2C2.2 15.6 2.2 15.2 2.2 12s0-3.6.1-4.9c.1-1.2.3-1.8.4-2.2.2-.6.5-1 .9-1.4.4-.4.8-.7 1.4-.9.4-.1 1-.3 2.2-.4C8.4 2.2 8.8 2.2 12 2.2Zm0 3.2A6.6 6.6 0 1 0 18.6 12 6.6 6.6 0 0 0 12 5.4Zm0 10.9A4.3 4.3 0 1 1 16.3 12 4.3 4.3 0 0 1 12 16.3Zm6.9-11.1a1.5 1.5 0 1 0 1.5 1.5 1.5 1.5 0 0 0-1.5-1.5Z"/></svg>
            Open on Instagram
          </a>
        )}

        {actionSlot}
      </div>
    </div>
  );
}
