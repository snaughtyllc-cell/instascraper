import React, { useState, useEffect } from 'react';
import api from './api';
import ScrapeTab from './pages/ScrapeTab';
import LibraryTab from './pages/LibraryTab';
import EngagementTab from './pages/EngagementTab';
import LoginPage from './components/LoginPage';

const TABS = [
  { id: 'scrape', label: 'Scrape New Content' },
  { id: 'library', label: 'Content Library' },
  { id: 'engagement', label: 'Engagement' },
];

export default function App() {
  const [activeTab, setActiveTab] = useState('library');
  const [authState, setAuthState] = useState('loading'); // 'loading' | 'login' | 'app'

  useEffect(() => {
    checkAuth();
  }, []);

  const checkAuth = async () => {
    try {
      const { data } = await api.get('/auth/check');
      if (!data.authRequired || data.authenticated) {
        setAuthState('app');
      } else {
        setAuthState('login');
      }
    } catch {
      setAuthState('login');
    }
  };

  const handleLogout = async () => {
    await api.post('/logout');
    setAuthState('login');
  };

  if (authState === 'loading') {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-gold border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (authState === 'login') {
    return <LoginPage onLogin={() => setAuthState('app')} />;
  }

  return (
    <div className="min-h-screen bg-gray-950">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-950/80 backdrop-blur sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gold/20 flex items-center justify-center">
              <svg className="w-5 h-5 text-gold" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </div>
            <h1 className="text-xl font-bold text-white">
              Insta<span className="text-gold">Scraper</span>
            </h1>
          </div>

          <div className="flex items-center gap-3">
            {/* Tabs */}
            <nav className="flex gap-1 bg-gray-900 rounded-lg p-1">
              {TABS.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${
                    activeTab === tab.id
                      ? 'bg-gold text-gray-950'
                      : 'text-gray-400 hover:text-white hover:bg-gray-800'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </nav>

            {/* Logout */}
            <button
              onClick={handleLogout}
              className="px-3 py-2 rounded-lg text-sm text-gray-500 hover:text-gray-300 hover:bg-gray-800 transition-colors"
              title="Sign out"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
        {activeTab === 'scrape' && <ScrapeTab />}
        {activeTab === 'library' && <LibraryTab />}
        {activeTab === 'engagement' && <EngagementTab />}
      </main>
    </div>
  );
}
