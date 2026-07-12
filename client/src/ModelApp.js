import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import FeedPage from './pages/model/FeedPage';
import SoundsPage from './pages/model/SoundsPage';
import SavedPage from './pages/model/SavedPage';
import IdeasPage from './pages/model/IdeasPage';

const PAGE_META = {
  feed: { eyebrow: 'Made for you', title: 'Fresh picks' },
  sounds: { eyebrow: 'Trending now', title: 'Audio' },
  saved: { eyebrow: 'Your shortlist', title: 'Saved' },
  ideas: { eyebrow: 'Ready to make', title: 'Ideas' },
};

const TABS = [
  {
    id: 'feed',
    label: 'Feed',
    icon: (active) => (
      <svg className="w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={active ? 2.5 : 2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
      </svg>
    ),
  },
  {
    id: 'sounds',
    label: 'Audio',
    icon: (active) => (
      <svg className="w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={active ? 2.5 : 2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 19V6l12-2v13M9 19a3 3 0 11-6 0 3 3 0 016 0zM21 17a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
  },
  {
    id: 'saved',
    label: 'Saved',
    icon: (active) => (
      <svg className="w-[18px] h-[18px]" fill={active ? 'currentColor' : 'none'} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
      </svg>
    ),
  },
  {
    id: 'ideas',
    label: 'Ideas',
    icon: (active) => (
      <svg className="w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={active ? 2.5 : 2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0c-.712.712-1.293 1.63-1.293 2.657a2 2 0 01-2 2h-.5a2 2 0 01-2-2c0-1.027-.581-1.945-1.293-2.657z" />
      </svg>
    ),
  },
];

export default function ModelApp({ onLogout }) {
  const [tab, setTab] = useState(() => {
    try {
      const saved = window.sessionStorage.getItem('instascraper:model-tab');
      return TABS.some((item) => item.id === saved) ? saved : 'feed';
    } catch {
      return 'feed';
    }
  });
  const tabRef = useRef(tab);
  const scrollByTabRef = useRef({ feed: 0, sounds: 0, saved: 0, ideas: 0 });
  const pendingScrollTabRef = useRef(null);
  const headerRef = useRef(null);
  const navRef = useRef(null);
  const [feedViewportHeight, setFeedViewportHeight] = useState(null);
  const [feedResetSignal, setFeedResetSignal] = useState(0);

  useLayoutEffect(() => {
    const measure = () => {
      const headerHeight = headerRef.current?.getBoundingClientRect().height || 0;
      const navHeight = navRef.current?.getBoundingClientRect().height || 0;
      setFeedViewportHeight(Math.max(1, window.innerHeight - headerHeight - navHeight));
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    if (headerRef.current) observer?.observe(headerRef.current);
    if (navRef.current) observer?.observe(navRef.current);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  useLayoutEffect(() => {
    if (pendingScrollTabRef.current !== tab) return;
    window.scrollTo({ top: scrollByTabRef.current[tab] || 0, behavior: 'auto' });
    pendingScrollTabRef.current = null;
  }, [tab]);

  useEffect(() => {
    try { window.sessionStorage.setItem('instascraper:model-tab', tab); } catch { /* storage may be unavailable */ }
  }, [tab]);

  const switchTab = (nextTab) => {
    scrollByTabRef.current[tabRef.current] = window.scrollY;
    if (nextTab === tabRef.current) {
      if (nextTab === 'feed') {
        setFeedResetSignal((signal) => signal + 1);
        return;
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
      scrollByTabRef.current[nextTab] = 0;
      return;
    }
    tabRef.current = nextTab;
    pendingScrollTabRef.current = nextTab;
    setTab(nextTab);
  };

  const pageMeta = PAGE_META[tab];

  return (
    <div className="model-app min-h-screen bg-model-canvas text-model-ink flex flex-col">
      {/* Top bar — light, uncluttered: one accent mark, restrained title weight */}
      <header ref={headerRef} className="sticky top-0 z-40 border-b border-model-line/80 bg-model-surface/95 backdrop-blur-xl">
        <div className="max-w-xl mx-auto px-4 pt-[max(14px,env(safe-area-inset-top))] pb-3 flex items-center justify-between">
          <div className="min-w-0">
            <p className="text-[11px] font-extrabold uppercase tracking-[0.16em] text-model-coral-ink">{pageMeta.eyebrow}</p>
            <h1 className="mt-0.5 text-[25px] leading-none font-black text-model-ink">{pageMeta.title}</h1>
          </div>
          <button
            onClick={onLogout}
            className="w-10 h-10 shrink-0 flex items-center justify-center rounded-full border border-model-line bg-white text-model-ink shadow-sm transition-colors hover:bg-model-butter focus:outline-none focus:ring-2 focus:ring-model-coral/40"
            title="Sign out"
            aria-label="Sign out"
          >
            <svg className="w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
          </button>
        </div>
      </header>

      {/* Active page — a calm max-width so content doesn't stretch edge-to-edge
          on larger phones; bottom padding clears the fixed nav */}
      <main className={tab === 'feed' ? 'flex-1 min-h-0' : 'flex-1 pb-24'}>
        <div className="max-w-xl mx-auto">
          <section
            className={tab === 'feed' ? 'block overflow-hidden' : 'hidden'}
            style={feedViewportHeight ? { height: `${feedViewportHeight}px` } : { height: 'calc(100svh - 144px)' }}
            aria-hidden={tab !== 'feed'}
          >
            <FeedPage active={tab === 'feed'} resetSignal={feedResetSignal} />
          </section>
          <section className={tab === 'sounds' ? 'block' : 'hidden'} aria-hidden={tab !== 'sounds'}>
            <SoundsPage active={tab === 'sounds'} />
          </section>
          <section className={tab === 'saved' ? 'block' : 'hidden'} aria-hidden={tab !== 'saved'}>
            <SavedPage active={tab === 'saved'} onExplore={() => switchTab('feed')} />
          </section>
          <section className={tab === 'ideas' ? 'block' : 'hidden'} aria-hidden={tab !== 'ideas'}>
            <IdeasPage active={tab === 'ideas'} />
          </section>
        </div>
      </main>

      <nav ref={navRef} className="fixed bottom-0 left-0 right-0 z-40 border-t border-model-line bg-model-surface/95 backdrop-blur-xl pb-[env(safe-area-inset-bottom)]">
        <div className="max-w-xl mx-auto grid grid-cols-4 px-2">
          {TABS.map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => switchTab(t.id)}
                className={`flex min-w-0 flex-col items-center justify-center gap-1 py-2 min-h-[62px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-model-coral/50 ${
                  active ? 'text-model-ink' : 'text-model-muted hover:text-model-ink'
                }`}
                aria-current={active ? 'page' : undefined}
              >
                <span className={`h-7 min-w-[34px] px-2 flex items-center justify-center rounded-full transition-colors ${active ? 'bg-model-butter ring-1 ring-model-ink/15' : ''}`}>
                  {t.icon(active)}
                </span>
                <span className={`text-[11px] leading-none ${active ? 'font-bold' : 'font-medium'}`}>{t.label}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
