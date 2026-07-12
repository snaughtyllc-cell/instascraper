import React, { useState } from 'react';
import { login } from '../api';

export default function LoginPage({ onLogin, notice = '' }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      await login(email || undefined, password);
      await onLogin();
    } catch (err) {
      setError(err.response?.data?.error || (err.code === 'ECONNABORTED'
        ? 'InstaScraper took too long to respond. Try again.'
        : 'Could not sign in. Check your connection and try again.'));
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
          <p className="text-[11px] font-extrabold uppercase tracking-[0.16em] text-model-coral-ink">Welcome back</p>
          <h1 className="mt-1 text-2xl font-black text-model-ink">InstaScraper</h1>
          <p className="text-model-muted text-sm mt-1">Sign in to continue</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {notice && (
            <div className="rounded-lg border border-model-line bg-model-butter/60 px-4 py-3 text-sm font-medium text-model-ink" role="status">
              {notice}
            </div>
          )}
          <div>
            <label htmlFor="login-email" className="mb-1.5 block text-sm font-bold text-model-ink">Email</label>
            <input
              id="login-email"
              name="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="model@example.com"
              autoComplete="email"
              aria-describedby="login-email-help"
              className="w-full bg-white border border-model-line rounded-lg px-4 py-3 text-model-ink text-sm placeholder-model-muted focus:outline-none focus:ring-2 focus:ring-model-coral/30 focus:border-model-coral"
            />
            <p id="login-email-help" className="mt-1.5 text-xs font-medium text-model-muted">Team login can leave email blank.</p>
          </div>

          <div>
            <label htmlFor="login-password" className="mb-1.5 block text-sm font-bold text-model-ink">Password</label>
            <div className="relative">
              <input
                id="login-password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                autoComplete="current-password"
                className="w-full bg-white border border-model-line rounded-lg px-4 py-3 pr-12 text-model-ink text-sm placeholder-model-muted focus:outline-none focus:ring-2 focus:ring-model-coral/30 focus:border-model-coral"
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword((visible) => !visible)}
                className="absolute inset-y-0 right-0 flex w-12 items-center justify-center text-model-muted hover:text-model-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-model-coral/50"
                title={showPassword ? 'Hide password' : 'Show password'}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                aria-pressed={showPassword}
              >
                {showPassword ? (
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18M10.6 10.7a2 2 0 002.8 2.8M9.9 4.2A10.7 10.7 0 0112 4c5.5 0 9 5 9 8a13.7 13.7 0 01-2.1 3.6M6.6 6.6C4.4 8 3 10.2 3 12c0 3 3.5 8 9 8 1 0 1.9-.2 2.7-.5" />
                  </svg>
                ) : (
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 12s3.5-8 9-8 9 8 9 8-3.5 8-9 8-9-8-9-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-2 text-sm text-center" role="alert" aria-live="assertive">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full min-h-[48px] bg-model-ink hover:bg-black text-white font-bold py-3 rounded-lg text-sm transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-model-coral/50 focus-visible:ring-offset-2 focus-visible:ring-offset-model-canvas"
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}
