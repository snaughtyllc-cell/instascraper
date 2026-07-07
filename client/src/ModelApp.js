import React, { useState } from 'react';
import FeedPage from './pages/model/FeedPage';
import SavedPage from './pages/model/SavedPage';
import IdeasPage from './pages/model/IdeasPage';

const TABS = [
  {
    id: 'feed',
    label: 'Feed',
    icon: (active) => (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={active ? 2.5 : 2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
      </svg>
    ),
  },
  {
    id: 'saved',
    label: 'Saved',
    icon: (active) => (
      <svg className="w-6 h-6" fill={active ? 'currentColor' : 'none'} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
      </svg>
    ),
  },
  {
    id: 'ideas',
    label: 'Ideas',
    icon: (active) => (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={active ? 2.5 : 2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0c-.712.712-1.293 1.63-1.293 2.657a2 2 0 01-2 2h-.5a2 2 0 01-2-2c0-1.027-.581-1.945-1.293-2.657z" />
      </svg>
    ),
  },
];

export default function ModelApp({ onLogout }) {
  const [tab, setTab] = useState('feed');

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col">
      {/* Top bar — light, uncluttered: one accent mark, restrained title weight */}
      <header className="border-b border-gray-800/60 bg-gray-950/80 backdrop-blur sticky top-0 z-40">
        <div className="max-w-xl mx-auto px-5 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gold/20 flex items-center justify-center shrink-0">
              <svg className="w-5 h-5 text-gold" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </div>
            <h1 className="text-lg font-semibold text-white tracking-tight">
              Insta<span className="text-gold">Scraper</span>
            </h1>
          </div>
          <button
            onClick={onLogout}
            className="w-11 h-11 -mr-2 flex items-center justify-center rounded-full text-gray-500 hover:text-gray-300 hover:bg-gray-800/60 transition-colors"
            title="Sign out"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
          </button>
        </div>
      </header>

      {/* Active page — a calm max-width so content doesn't stretch edge-to-edge
          on larger phones; bottom padding clears the fixed nav */}
      <main className="flex-1 pb-24">
        <div className="max-w-xl mx-auto">
          {tab === 'feed' && <FeedPage />}
          {tab === 'saved' && <SavedPage />}
          {tab === 'ideas' && <IdeasPage />}
        </div>
      </main>

      {/* Fixed bottom nav — muted inactive icons, one clear gold active state */}
      <nav className="fixed bottom-0 left-0 right-0 z-40 bg-gray-950/95 backdrop-blur border-t border-gray-800/60 pb-[env(safe-area-inset-bottom)]">
        <div className="max-w-xl mx-auto flex items-stretch">
          {TABS.map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex-1 flex flex-col items-center justify-center gap-1 py-3.5 min-h-[60px] transition-colors ${
                  active ? 'text-gold' : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                {t.icon(active)}
                <span className={`text-[11px] ${active ? 'font-medium' : 'font-normal'}`}>{t.label}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
