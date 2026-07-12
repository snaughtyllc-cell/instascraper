import React, { useState, useEffect, useRef } from 'react';
import * as Sentry from '@sentry/react';
import API_URL from '../api-base';

// Lean, model-only reel card (Feed + Saved). The reel fills the screen and every
// piece of context — @handle, ER, views, caption, and the Save / Open / Sound
// actions — rides ON the video, Instagram-style. The admin Library keeps
// ContentCard untouched.
//
// PLAYBACK (the "videos won't play on the phone" fix): React's `muted` prop is
// unreliable on iOS — it sets the attribute but not the muted *property*, so iOS
// treats a muted-autoplay <video> as unmuted and silently BLOCKS autoplay,
// leaving a frozen poster. We therefore set `muted` on the element imperatively
// and call play() ourselves, and make the whole reel tap-to-play/pause so a
// blocked autoplay (e.g. iOS Low Power Mode) is always recoverable by tapping.

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
function formatDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function ReelCard({
  post,
  autoplayInView = false,
  isActive = false,
  soundOn = false,
  onToggleSound,
  registerRef,
  onToggleSave,
  isSaved = false,
  feedback,
  onNotInterested,
  actionPending = false,
  pageActive = true,
  reelMode = false,
  pickedForYou = false,
  accessiblePosition,
}) {
  const [showVideo, setShowVideo] = useState(false); // desktop tap-to-play fallback
  const [videoFailed, setVideoFailed] = useState(false);
  const [manualPaused, setManualPaused] = useState(false);
  const [documentVisible, setDocumentVisible] = useState(() => typeof document === 'undefined' || !document.hidden);
  const cardRef = useRef(null);
  const videoRef = useRef(null);

  const cardId = post.id ?? post.shortcode;
  const reelUrl = post.post_url || (post.shortcode ? `https://www.instagram.com/reel/${post.shortcode}/` : null);
  const thumbnailSrc = cardId ? `${API_URL}/thumb/${cardId}` : post.thumbnail_url;
  const videoSrc = cardId ? `${API_URL}/video/${cardId}` : post.video_url;
  const typeLabel = post.niche || post.content_type;

  // Reset per-reel playback flags when the underlying reel changes.
  useEffect(() => { setVideoFailed(false); setManualPaused(false); setShowVideo(false); }, [cardId]);

  useEffect(() => {
    const onVisibility = () => setDocumentVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  useEffect(() => {
    if (pageActive) return;
    setShowVideo(false);
    setManualPaused(false);
    if (videoRef.current && !videoRef.current.paused) videoRef.current.pause();
  }, [pageActive]);

  useEffect(() => {
    if (!cardRef.current || !showVideo || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting || entry.intersectionRatio < 0.1) {
        setShowVideo(false);
        setManualPaused(false);
      }
    }, { threshold: [0, 0.1] });
    observer.observe(cardRef.current);
    return () => observer.disconnect();
  }, [showVideo]);

  // Register with the shared in-view observer so only the most-visible reel plays.
  useEffect(() => {
    if (!autoplayInView || !registerRef || !cardRef.current) return;
    const el = cardRef.current;
    registerRef(cardId, el);
    return () => registerRef(cardId, null);
  }, [autoplayInView, registerRef, cardId]);

  const playing = pageActive && documentVisible && (showVideo || (autoplayInView && isActive)) && !videoFailed && cardId != null;

  // Drive playback imperatively (see file header). Runs whenever the reel becomes
  // the active/playing one, or when mute/pause state changes.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.muted = !soundOn;
    if (playing && !manualPaused) {
      const p = el.play();
      if (p && typeof p.catch === 'function') p.catch(() => {
        if (!soundOn) {
          setManualPaused(true);
          return;
        }
        // Browsers commonly reject unmuted autoplay after a swipe. Fall back to
        // muted playback so the next reel keeps moving instead of freezing.
        el.muted = true;
        onToggleSound?.();
        const retry = el.play();
        if (retry && typeof retry.catch === 'function') retry.catch(() => setManualPaused(true));
      });
    } else if (!el.paused) {
      el.pause();
    }
  }, [playing, soundOn, manualPaused]);

  // Tap the reel surface. If the <video> isn't mounted yet (this reel is showing
  // its poster because it isn't the active/autoplaying one, or a prior load
  // errored), force-mount it and let the playback effect start it. Otherwise
  // toggle play/pause. This is what makes tapping ANY reel play it — not just the
  // one the in-view observer picked.
  const handleSurfaceTap = () => {
    const el = videoRef.current;
    if (!el) return;
    if (!playing || !el.currentSrc) {
      setVideoFailed(false);
      setManualPaused(false);
      // Let React attach the src before the playback effect calls play(). Setting
      // src/load/play here and then rendering the same src can interrupt the
      // first play request, leaving a ready video paused after one tap.
      setShowVideo(true);
      return;
    }
    if (el.paused) {
      if (el.readyState === 0) el.load();
      el.muted = !soundOn;
      const p = el.play();
      if (p && typeof p.catch === 'function') p.catch(() => setManualPaused(true));
      setManualPaused(false);
    } else {
      el.pause();
      setManualPaused(true);
    }
  };

  // Center play affordance: whenever a reel is showing its poster (tap to play),
  // or when it's paused.
  const showCenterPlay = !playing || manualPaused;

  return (
    <div
      ref={cardRef}
      className={`relative w-full overflow-hidden bg-black ${reelMode
        ? 'h-full rounded-none sm:rounded-lg sm:ring-1 sm:ring-model-ink/10'
        : 'h-[calc(100svh-205px)] min-h-[440px] max-h-[720px] rounded-lg ring-1 ring-model-ink/10 shadow-[0_14px_34px_rgba(32,33,31,0.14)]'}`}
      role="group"
      aria-label={`${accessiblePosition ? `${accessiblePosition}. ` : ''}Reel by @${post.account_handle || 'creator'}`}
    >
      {/* Media — true aspect, no crop */}
      <video
        ref={videoRef}
        src={playing ? videoSrc : undefined}
        poster={thumbnailSrc}
        autoPlay={playing}
        playsInline
        muted={!soundOn}
        loop={autoplayInView}
        controls={false}
        preload="metadata"
        className={`absolute inset-0 w-full h-full object-contain ${playing ? 'block' : 'hidden'}`}
        onError={() => {
          setVideoFailed(true);
          Sentry.captureMessage('Model reel playback failed', { level: 'warning', tags: { surface: 'model-feed', post_id: String(cardId) } });
        }}
      />
      {!playing && (
        <img
          src={thumbnailSrc}
          alt=""
          className="absolute inset-0 w-full h-full object-contain"
          loading="lazy"
          onError={(e) => {
            if (e.target.src !== post.thumbnail_url && post.thumbnail_url) e.target.src = post.thumbnail_url;
          }}
        />
      )}

      {/* Full-surface tap layer: play/pause (mobile) or start (desktop). Sits below
          the action rail (z-20) and above the pointer-events-none overlay. */}
      <button
        type="button"
        onClick={handleSurfaceTap}
        className="absolute inset-0 z-[5] w-full h-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white"
        aria-label={playing && !manualPaused ? 'Pause' : 'Play'}
      >
        {showCenterPlay && (
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="w-14 h-14 rounded-full bg-model-surface/90 text-model-ink flex items-center justify-center shadow-lg backdrop-blur">
              <svg className="w-6 h-6 ml-1" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
            </span>
          </span>
        )}
      </button>

      {/* "playing" pill — reassures the model the video is live */}
      {playing && !manualPaused && autoplayInView && (
        <div className="pointer-events-none absolute top-3 left-3 z-20 flex items-center gap-1.5 rounded-full bg-model-surface/90 px-2.5 py-1 text-[10px] font-bold text-model-ink shadow-sm backdrop-blur">
          <span className="w-[7px] h-[7px] rounded-full bg-model-sage ring-1 ring-model-ink/15" />
          playing
        </div>
      )}

      {pickedForYou && (
        <div className="pointer-events-none absolute left-3 top-12 z-20 rounded-full border border-white/30 bg-model-coral/95 px-2.5 py-1 text-[10px] font-extrabold text-white shadow-sm backdrop-blur">
          Picked for you
        </div>
      )}

      {videoFailed && (
        <div className="pointer-events-none absolute left-3 top-3 z-20 rounded-full bg-model-surface/95 px-2.5 py-1 text-[11px] font-bold text-model-ink shadow-sm backdrop-blur">
          Video unavailable
        </div>
      )}

      {/* Right action rail */}
      <div className={`absolute right-3 bottom-[102px] z-20 flex flex-col items-center gap-2.5 ${reelMode ? 'model-reel-actions' : ''}`}>
        {onToggleSave && (
          <button
            onClick={(e) => { e.stopPropagation(); onToggleSave(post); }}
            disabled={actionPending}
            aria-busy={actionPending}
            className={`w-11 h-11 rounded-full border flex items-center justify-center shadow-lg backdrop-blur transition-transform active:scale-95 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white ${
              isSaved ? 'border-white/50 bg-model-coral text-white' : 'border-model-ink/15 bg-model-surface/95 text-model-ink'
            }`}
            title={isSaved ? 'Unsave' : 'Save'}
            aria-label={isSaved ? 'Unsave' : 'Save'}
            aria-pressed={isSaved}
          >
            <svg
              className="w-[21px] h-[21px]"
              fill={isSaved ? 'currentColor' : 'none'}
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
            </svg>
          </button>
        )}
        {onNotInterested && (
          <button
            onClick={(e) => { e.stopPropagation(); onNotInterested(post); }}
            disabled={actionPending}
            aria-busy={actionPending}
            className={`w-11 h-11 rounded-full border flex items-center justify-center shadow-lg backdrop-blur transition-transform active:scale-95 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white ${
              feedback === 'not_my_style'
                ? 'border-white/50 bg-model-coral text-white'
                : 'border-model-ink/15 bg-model-surface/95 text-model-ink'
            }`}
            title="Not interested"
            aria-label="Not interested"
          >
            <svg className="w-[21px] h-[21px]" fill="none" stroke="currentColor" strokeWidth={2.4} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        )}
        {reelUrl && (
          <a
            href={reelUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="w-11 h-11 rounded-full border border-model-ink/15 bg-model-surface/95 text-model-ink shadow-lg backdrop-blur flex items-center justify-center transition-transform active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            title="Open on Instagram"
            aria-label="Open on Instagram"
          >
            <svg className="w-[21px] h-[21px]" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <rect x="3" y="3" width="18" height="18" rx="5" />
              <circle cx="12" cy="12" r="3.6" />
              <circle cx="17.4" cy="6.6" r="1" fill="currentColor" stroke="none" />
            </svg>
          </a>
        )}
        {onToggleSound && (
          <button
            onClick={(e) => { e.stopPropagation(); onToggleSound && onToggleSound(); }}
            className="w-11 h-11 rounded-full border border-model-ink/15 bg-model-sage/95 text-model-ink shadow-lg backdrop-blur flex items-center justify-center transition-transform active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            title={soundOn ? 'Mute' : 'Unmute'}
            aria-label={soundOn ? 'Mute' : 'Unmute'}
            aria-pressed={soundOn}
          >
            <svg className="w-[21px] h-[21px]" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M11 5L6 9H2v6h4l5 4V5z" />
              {soundOn
                ? <path strokeLinecap="round" strokeLinejoin="round" d="M15.5 8.5a5 5 0 010 7M18 6a9 9 0 010 12" />
                : <path strokeLinecap="round" strokeLinejoin="round" d="M17 9l4 6m0-6l-4 6" />}
            </svg>
          </button>
        )}
      </div>

      {/* Bottom overlay: handle + meta + caption + type — pointer-events-none so
          taps fall through to the play/pause surface. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 px-3.5 pt-12 pb-3.5 pr-16 bg-gradient-to-t from-black/90 via-black/45 to-transparent">
        <div className="flex items-center gap-2 text-sm font-bold text-white">
          <span className="w-6 h-6 rounded-full bg-model-coral ring-[1.5px] ring-white/80 shrink-0" />
          @{post.account_handle}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs font-semibold text-white/90">
          {post.er_percent != null && post.er_label && (
            <>
              <span className="text-emerald-400">{post.er_percent}% ER</span>
              <span className="w-[3px] h-[3px] rounded-full bg-white/40" />
            </>
          )}
          <span>{formatViews(post.view_count)} views</span>
          {post.posted_at && (
            <>
              <span className="w-[3px] h-[3px] rounded-full bg-white/40" />
              <span>{formatDate(post.posted_at)}</span>
            </>
          )}
        </div>
        {post.caption && (
          <p className="mt-1.5 text-[12.5px] leading-snug text-white/90 line-clamp-2">{post.caption}</p>
        )}
        {typeLabel && (
          <span className="mt-2 inline-block rounded-full border border-white/25 bg-model-butter/95 px-2 py-0.5 text-[10px] font-bold text-model-ink">
            {typeLabel}
          </span>
        )}
      </div>
    </div>
  );
}
