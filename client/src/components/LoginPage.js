import React, { useState } from 'react';
import { login } from '../api';

export default function LoginPage({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      await login(email || undefined, password);
      onLogin();
    } catch (err) {
      setError(err.response?.data?.error || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-model-canvas text-model-ink flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm rounded-lg border border-model-line bg-model-surface p-6 shadow-[0_20px_50px_rgba(32,33,31,0.12)]">
        <div className="text-center mb-7">
          <div className="w-12 h-12 rounded-full bg-model-butter text-model-ink flex items-center justify-center mx-auto mb-4 ring-1 ring-model-ink/10">
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </div>
          <p className="text-[10px] font-extrabold uppercase tracking-[0.16em] text-model-coral">Welcome back</p>
          <h1 className="mt-1 text-2xl font-black text-model-ink">InstaScraper</h1>
          <p className="text-model-muted text-sm mt-1">Sign in to continue</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email (models only — leave blank for team login)"
              autoFocus
              className="w-full bg-white border border-model-line rounded-lg px-4 py-3 text-model-ink text-sm placeholder-model-muted focus:outline-none focus:ring-2 focus:ring-model-coral/30 focus:border-model-coral"
            />
          </div>

          <div>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              className="w-full bg-white border border-model-line rounded-lg px-4 py-3 text-model-ink text-sm placeholder-model-muted focus:outline-none focus:ring-2 focus:ring-model-coral/30 focus:border-model-coral"
              required
            />
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-2 text-sm text-center">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-model-ink hover:bg-black text-white font-bold py-3 rounded-lg text-sm transition-colors disabled:opacity-50"
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}
