# Codex Kickoff Brief — Reel Radar **Frontend** slice (Track B)

> Self-contained. You (Codex) own the **frontend only**. Claude is building the backend (Track A) in parallel. You meet at the frozen API contract below — code to it, don't wait on it.

## 1. What you're building
InstaScraper is an internal Node/Express + React tool for finding viral Instagram Reels. We're adding **Reel Radar**: a content-first discovery feature that surfaces top reels harvested from niche hashtags, scored by "breakout" magnitude (views ÷ the author's median views). Your job is the **React UI** for it.

- **Repo:** `github.com/snaughtyllc-cell/instascraper`
- **Read these first (already committed on the base branch):**
  - `docs/superpowers/specs/2026-06-30-reel-radar-discovery-design.md` (design)
  - `docs/superpowers/plans/2026-06-30-reel-radar-discovery.md` (the plan — your tasks are **Track B, B1–B5**)

## 2. Setup
```bash
git clone https://github.com/snaughtyllc-cell/instascraper.git   # or pull if you have it
cd instascraper
git checkout reel-radar-discovery        # base: has spec + plan
git checkout -b reel-radar-frontend      # YOUR branch — work here
npm run install:all
```
Run the app for browser smokes: `npm start` (client :3000, API :4000). Local DB is SQLite (no `DATABASE_URL`).

## 3. Your scope — touch ONLY `client/`
Implement **Track B, Tasks B1–B5** from the plan, in order:
- **B1** — `client/src/api.js` radar methods + register the **Radar** tab in `client/src/App.js` + `client/src/pages/RadarTab.js` stub.
- **B2** — Radar reels grid, **reusing `client/src/components/ContentCard.js`**; add the untracked badge, breakout pill (`${breakout_score}× median`), and `via #${discovered_via}`.
- **B3** — per-card Save / Dismiss / Track-author + multi-select bulk, **reusing `client/src/components/BulkActionBar.js`**.
- **B4** — watchlist panel (list terms, pin/exclude/pause, "Run Radar now").
- **B5** — `client/src/pages/SuggestedAccountsTab.js`: radar-source chip + "Radar-sourced" filter.

The plan has the exact code/props for each. Reuse existing components — do not rebuild card/bulk UI.

## 4. FROZEN API CONTRACT (code to this — it will not change without coordination)
```
GET  /radar/reels?term&min_breakout&since&status=new&limit=60&offset=0
  → { reels:[ { shortcode, account_handle, video_url, thumbnail_url, caption,
       like_count, comment_count, view_count, posted_at, post_url, discovered_via,
       author_followers, author_median_views, breakout_score, niche_fit_score,
       total_score, status, discovered_at } ], total }
POST /radar/reels/:shortcode/save     → { ok:true, post_id }
POST /radar/reels/:shortcode/dismiss  → { ok:true }
POST /radar/reels/bulk { shortcodes:[], action:'save'|'dismiss' } → { ok:true, updated }
GET  /radar/terms → { terms:[ { id, term, kind, source, status, last_run_at, reels_surfaced } ] }
POST /radar/terms { term, kind:'hashtag' } → { ok:true, id }
PATCH /radar/terms/:id { status:'active'|'excluded'|'paused' } → { ok:true }
POST /radar/run → { ok:true, started:true } | { ok:true, started:false, reason:'already_running' }
```
- Render `breakout_score` as “N×median”; sort is server-side by `total_score DESC`.
- **Backend not merged yet?** Seed local test data so you can build UI without the backend:
```bash
cd server && node -e "require('./db').initDB().then(async()=>{const p=require('./db');
 await p.query(\"INSERT INTO radar_reels (shortcode,account_handle,thumbnail_url,caption,like_count,view_count,breakout_score,niche_fit_score,total_score,status,discovered_via,posted_at) VALUES ('DEMO1','viralgirl','https://picsum.photos/300','leg day #fitness',5000,300000,8.2,1.2,6.1,'new','fitness','2026-06-25T00:00:00Z')\");
 console.log('seeded');process.exit(0)})"
```
The `/radar/*` routes (Track A9) implement this contract; if a route 404s, the backend slice isn't merged yet — keep building against the seed + contract.

## 5. Verification (no client unit-test runner exists)
Gate **every task**: `cd client && npm run build` compiles clean **AND** a browser smoke against `npm start`. Commit per task with the messages in the plan.

## 6. Coordination rules
- **Only edit `client/`.** Do not touch `server/`, `db.js`, or the plan/spec. (Claude owns those.)
- The API contract in §4 is **frozen** — if you think it needs to change, stop and flag it; don't fork the shape.
- Branch from `reel-radar-discovery`; if it moves, `git rebase origin/reel-radar-discovery`.
- Don't commit the untracked root experiment files (`*.pdf`, `python/`, `test_input.mp4`, `test_output/`, `generate_*.py`).
- Open a PR `reel-radar-frontend → reel-radar-discovery` when B1–B5 are done + build-clean.
```
```
