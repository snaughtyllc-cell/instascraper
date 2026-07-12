import React, { useState, useEffect } from 'react';
import * as Sentry from '@sentry/react';
import api from './api';
import ScrapeTab from './pages/ScrapeTab';
import LibraryTab from './pages/LibraryTab';
import EngagementTab from './pages/EngagementTab';
import TrackedAccountsTab from './pages/TrackedAccountsTab';
import SuggestedAccountsTab from './pages/SuggestedAccountsTab';
import DeleteLogTab from './pages/DeleteLogTab';
import ModelsTab from './pages/ModelsTab';
import AudioTab from './pages/AudioTab';
import AdminCockpitTab from './pages/AdminCockpitTab';
import LoginPage from './components/LoginPage';
import ModelApp from './ModelApp';

const TABS = [
  { id: 'cockpit', label: 'Cockpit' },
  { id: 'tracked', label: 'Tracked' },
  { id: 'scrape', label: 'Scrape' },
  { id: 'library', label: 'Library' },
  { id: 'engagement', label: 'Engagement' },
  { id: 'models', label: 'Models' },
  { id: 'suggested', label: 'Suggested' },
  { id: 'audio', label: 'Audio' },
  { id: 'deletelog', label: 'Delete Log' },
];

export default function App() {
  const [activeTab, setActiveTab] = useState('cockpit');
  const [authState, setAuthState] = useState('loading');
  const [role, setRole] = useState(null);
  const [modelId, setModelId] = useState(null);
  const [loginNotice, setLoginNotice] = useState('');

  useEffect(() => {
    checkAuth();
  }, []);

  useEffect(() => {
    const interceptor = api.interceptors.response.use(
      (response) => response,
      (error) => {
        const status = error.response?.status;
        const url = String(error.config?.url || '');
        const responseError = String(error.response?.data?.error || '');
        if (url.startsWith('/me/') && (!status || status >= 500)) {
          Sentry.captureException(new Error(`Model API request failed: ${url}`), {
            tags: { api_status: String(status || 'network') },
            extra: { code: error.code || null },
          });
        }
        const sessionEnded = url !== '/login' && (status === 401 || (status === 403 && responseError === 'Account disabled'));
        if (sessionEnded) {
          setRole(null);
          setModelId(null);
          setLoginNotice(status === 403 ? 'Your model access is no longer active.' : 'Your session expired. Sign in again.');
          setAuthState('login');
          Sentry.setUser(null);
        }
        return Promise.reject(error);
      }
    );
    return () => api.interceptors.response.eject(interceptor);
  }, []);

  const checkAuth = async () => {
    try {
      const { data } = await api.get('/auth/check');
      if (!data.authRequired || data.authenticated) {
        const nextRole = data.role || 'admin';
        const nextModelId = data.modelId || null;
        setRole(nextRole);
        setModelId(nextModelId);
        setLoginNotice('');
        Sentry.setUser({ id: nextRole === 'model' ? `model:${nextModelId}` : 'admin' });
        setAuthState('app');
      } else {
        setRole(null);
        setModelId(null);
        setAuthState('login');
      }
    } catch (error) {
      setLoginNotice(error.code === 'ECONNABORTED'
        ? 'InstaScraper took too long to respond. Try again.'
        : 'We could not reach InstaScraper. Check your connection and try again.');
      setAuthState('login');
    }
  };

  const handleLogout = async () => {
    try {
      await api.post('/logout');
    } finally {
      setRole(null);
      setModelId(null);
      setLoginNotice('');
      setAuthState('login');
      Sentry.setUser(null);
    }
  };

  if (authState === 'loading') {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-gold border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (authState === 'login') {
    return <LoginPage onLogin={checkAuth} notice={loginNotice} />;
  }

  if (role === 'model') {
    return <ModelApp key={modelId || 'model'} onLogout={handleLogout} />;
  }

  return (
    <div className="min-h-screen bg-gray-950">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-950/80 backdrop-blur sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 sm:py-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {/* Logo row (logout sits here on mobile) */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-gold/20 flex items-center justify-center shrink-0">
                <svg className="w-5 h-5 text-gold" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </div>
              <h1 className="text-xl font-bold text-white">
                Insta<span className="text-gold">Scraper</span>
              </h1>
            </div>
            {/* Logout — mobile only */}
            <button
              onClick={handleLogout}
              className="sm:hidden px-3 py-2 rounded-lg text-sm text-gray-500 hover:text-gray-300 hover:bg-gray-800 transition-colors"
              title="Sign out"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
            </button>
          </div>

          <div className="flex items-center gap-3 min-w-0">
            {/* Tabs — horizontally scrollable on small screens */}
            <nav className="flex gap-1 bg-gray-900 rounded-lg p-1 overflow-x-auto">
              {TABS.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`shrink-0 whitespace-nowrap px-3 py-2 rounded-md text-sm font-medium transition-all ${
                    activeTab === tab.id
                      ? 'bg-gold text-gray-950'
                      : 'text-gray-400 hover:text-white hover:bg-gray-800'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </nav>

            {/* Logout — desktop only */}
            <button
              onClick={handleLogout}
              className="hidden sm:block shrink-0 px-3 py-2 rounded-lg text-sm text-gray-500 hover:text-gray-300 hover:bg-gray-800 transition-colors"
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
        {activeTab === 'cockpit' && <AdminCockpitTab />}
        {activeTab === 'tracked' && <TrackedAccountsTab />}
        {activeTab === 'scrape' && <ScrapeTab />}
        {activeTab === 'library' && <LibraryTab />}
        {activeTab === 'engagement' && <EngagementTab />}
        {activeTab === 'models' && <ModelsTab />}
        {activeTab === 'suggested' && <SuggestedAccountsTab />}
        {activeTab === 'audio' && <AudioTab />}
        {activeTab === 'deletelog' && <DeleteLogTab />}
      </main>
    </div>
  );
}
