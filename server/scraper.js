const fetch = require('node-fetch');
const pool = require('./db');
const { sweepThumbnails } = require('./thumbnails');

const APIFY_BASE = 'https://api.apify.com/v2';
const REEL_ACTOR_ID = 'apify~instagram-reel-scraper';
const GENERIC_ACTOR_ID = 'apify~instagram-scraper';

function calcER(likes, comments, followers) {
  if (!followers || followers <= 0) return { er_percent: 0, er_label: null };
  const er = ((likes + comments) / followers) * 100;
  let label = 'Low';
  if (er >= 6) label = 'Viral';
  else if (er >= 3) label = 'Good';
  else if (er >= 1) label = 'Average';
  return { er_percent: Math.round(er * 100) / 100, er_label: label };
}

// Views: Apify's reel actor returns a real videoPlayCount; the generic actor
// (URL imports + small-result fallback) returns no view field at all. Return
// null ("unknown") in that case so we never store a fake 0.
function extractViews(item) {
  const play = item && item.videoPlayCount;
  if (typeof play === 'number' && Number.isFinite(play)) return play;
  const view = item && item.videoViewCount;
  if (typeof view === 'number' && Number.isFinite(view)) return view;
  return null;
}

// Collaborators: the reel actor returns taggedUsers/usertags per post. Extract
// a clean, de-duped list of handles so discovery can mine collab partners later.
function normalizeTaggedUsers(item, ownerHandle = '') {
  const raw = (item && (item.taggedUsers || item.usertags)) || [];
  if (!Array.isArray(raw)) return null;
  const owner = (ownerHandle || '').toLowerCase();
  const out = [];
  const seen = new Set();
  for (const entry of raw) {
    let handle = '';
    if (typeof entry === 'string') handle = entry;
    else if (entry && typeof entry === 'object') handle = entry.username || (entry.user && entry.user.username) || '';
    handle = String(handle || '').trim().replace(/^@/, '').toLowerCase();
    if (!handle || handle === owner || seen.has(handle)) continue;
    seen.add(handle);
    out.push(handle);
  }
  return out.length ? out : null;
}

// Read side: parse a stored tagged_users JSON value into clean handles.
// Tolerates null/empty/malformed/non-array input — never throws.
function parseTaggedUsers(json) {
  if (!json) return [];
  let arr;
  try { arr = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr.filter(h => typeof h === 'string' && h.trim()).map(h => h.trim().toLowerCase());
}

function isTrackedUsernameQuery(query) {
  return typeof query === 'string' && query.trim() !== '' && !query.startsWith('#') && !query.startsWith('http');
}

function isoNoMillis(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

class BudgetExceededError extends Error {
  constructor(status) {
    super(`Apify 30-day budget reached: ~$${status.projectedUsd.toFixed(2)} projected vs $${status.ceilingUsd.toFixed(2)} ceiling`);
    this.name = 'BudgetExceededError';
    this.budget = status;
  }
}

function extractUsageUsd(runObject) {
  const u = runObject && runObject.usageTotalUsd;
  return (typeof u === 'number' && isFinite(u)) ? u : 0;
}

// ── Targeted Suggestions: discovery precision helpers (pure) ──
const FEMALE_WORDS = /\b(woman|women|girl|girls|female|wife|mom|mama|mother|daughter|sister|gal|lady|ladies|miss|mrs|ms\.|queen|princess)\b/;
const MALE_WORDS = /\b(man|men|guy|guys|male|husband|dad|daddy|father|son|brother|king|prince|mr\.|sir|bro)\b/;

function classifyGenderKeyword(username, bio) {
  const text = `${username} ${bio || ''}`.toLowerCase();
  const femalePronouns = /\b(she\/her|she\s*\/\s*her|her\/she|she-her)\b/.test(text);
  const malePronouns = /\b(he\/him|he\s*\/\s*him|him\/he|he-him)\b/.test(text);
  if (femalePronouns && !malePronouns) return 'female';
  if (malePronouns && !femalePronouns) return 'male';
  const f = FEMALE_WORDS.test(text);
  const m = MALE_WORDS.test(text);
  if (f && !m) return 'female';
  if (m && !f) return 'male';
  return 'unknown';
}

function parseGenderBatch(text, usernames) {
  const out = {};
  for (const u of usernames) out[String(u).toLowerCase()] = 'unknown';
  if (!text) return out;
  let data;
  try {
    const block = (String(text).match(/\{[\s\S]*\}/) || [String(text)])[0];
    data = JSON.parse(block);
  } catch { return out; }
  const list = Array.isArray(data) ? data : (Array.isArray(data.verdicts) ? data.verdicts : []);
  for (const v of list) {
    const u = String((v && (v.username || v.user)) || '').toLowerCase();
    const g = String((v && v.gender) || '').toLowerCase();
    if (u in out && (g === 'female' || g === 'male')) out[u] = g;
  }
  return out;
}

function scoreCandidate({ collabStrength = 1, avgEr = 0, postsPerWeek = 0 } = {}) {
  const relevancePts = Math.min(collabStrength / 3, 1) * 50;
  const erPts = Math.min((avgEr || 0) / 6, 1) * 30;
  const freqPts = Math.min((postsPerWeek || 0) / 5, 1) * 20;
  return Math.round(relevancePts + erPts + freqPts);
}

function genderRank(gender) {
  return gender === 'female' ? 0 : 1;
}

function aggregateCandidates(rawList) {
  const map = new Map();
  for (const c of rawList || []) {
    const key = String(c.username).toLowerCase();
    if (!map.has(key)) {
      map.set(key, { ...c, sources: new Set([c.sourceAccount].filter(Boolean)) });
    } else {
      const ex = map.get(key);
      if (c.sourceAccount) ex.sources.add(c.sourceAccount);
      ex.followers = Math.max(ex.followers || 0, c.followers || 0);
      ex.avgEr = Math.max(ex.avgEr || 0, c.avgEr || 0);
      ex.postsPerWeek = Math.max(ex.postsPerWeek || 0, c.postsPerWeek || 0);
      if (!ex.bio && c.bio) ex.bio = c.bio;
      if (ex.gender === 'unknown' && c.gender && c.gender !== 'unknown') ex.gender = c.gender;
      if (!ex.captionSnippet && c.captionSnippet) ex.captionSnippet = c.captionSnippet;
    }
  }
  return [...map.values()].map((c) => {
    const collabStrength = c.sources.size || 1;
    const relevanceReason = collabStrength > 1
      ? `Collab'd with ${collabStrength} of your creators`
      : (c.relevanceReason || 'Tagged by a tracked creator');
    return { ...c, collabStrength, relevanceReason };
  });
}

function suggestionsOrderClause(sort) {
  const sortMap = { score: 'suggestion_score DESC', er: 'avg_er DESC', followers: 'followers DESC', newest: 'discovered_at DESC' };
  const tail = sortMap[sort] || 'suggestion_score DESC';
  return `CASE WHEN gender = 'female' THEN 0 ELSE 1 END, ${tail}`;
}

async function budgetStatus(db, nowMs = Date.now()) {
  const ceilingUsd = parseFloat(process.env.APIFY_BUDGET_USD_30D) || 0;
  const enforced = ceilingUsd > 0;
  const since = isoNoMillis(nowMs - 30 * 24 * 60 * 60 * 1000);
  // `spent` sums usage_usd over every finished run in the window — failed runs
  // included, since a failed Apify run still incurs cost. running rows are $0
  // until finalized, so they don't inflate `spent` (they're estimated via projectedUsd).
  const res = await db.query(
    `SELECT
       COALESCE(SUM(usage_usd), 0) AS spent,
       COALESCE(SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END), 0) AS running,
       COALESCE(AVG(CASE WHEN status = 'succeeded' THEN usage_usd END), 0) AS avg_usd,
       COALESCE(SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END), 0) AS finished
     FROM apify_runs WHERE started_at >= $1`,
    [since]
  );
  const row = res.rows[0] || {};
  const spentUsd = Number(row.spent) || 0;
  const runningCount = Number(row.running) || 0;
  const avgUsd = Number(row.avg_usd) || 0;
  const finished = Number(row.finished) || 0;
  const estPerRun = finished > 0 ? avgUsd : (parseFloat(process.env.APIFY_EST_USD_PER_RUN) || 0.05);
  const projectedUsd = spentUsd + runningCount * estPerRun;
  const over = enforced && projectedUsd >= ceilingUsd;
  return { spentUsd, projectedUsd, ceilingUsd, enforced, over, runningCount, estPerRun };
}

async function recordRunLaunch(db, { runId, actorId, purpose, query, scrapeJobId = null, nowMs = Date.now() }) {
  await db.query(
    `INSERT INTO apify_runs (run_id, actor_id, purpose, query, status, started_at, scrape_job_id)
     VALUES ($1, $2, $3, $4, 'running', $5, $6)`,
    [runId, actorId, purpose, query, isoNoMillis(nowMs), scrapeJobId]
  );
}

async function recordRunCompletion(db, { runId, runObject = null, status, nowMs = Date.now() }) {
  const usd = extractUsageUsd(runObject);
  const items = (runObject && runObject.stats && Number(runObject.stats.itemCount)) || 0;
  await db.query(
    `UPDATE apify_runs SET status = $1, results_count = $2, usage_usd = $3, completed_at = $4 WHERE run_id = $5`,
    [status, items, usd, isoNoMillis(nowMs), runId]
  );
  console.log(`[Metric] apify_run run=${runId} status=${status} items=${items} usd=${usd.toFixed(4)}`);
}

async function usageSummary(db, nowMs = Date.now()) {
  const status = await budgetStatus(db, nowMs);
  const since = isoNoMillis(nowMs - 30 * 24 * 60 * 60 * 1000);
  const totals = await db.query(`SELECT COUNT(*) AS run_count FROM apify_runs WHERE started_at >= $1`, [since]);
  const top = await db.query(
    `SELECT query, COALESCE(SUM(usage_usd), 0) AS usd, COUNT(*) AS runs
     FROM apify_runs WHERE started_at >= $1 AND query IS NOT NULL
     GROUP BY query ORDER BY usd DESC LIMIT 10`,
    [since]
  );
  return {
    window_days: 30,
    spent_usd: status.spentUsd,
    projected_usd: status.projectedUsd,
    ceiling_usd: status.ceilingUsd,
    enforced: status.enforced,
    run_count: Number(totals.rows[0].run_count) || 0,
    top_accounts: top.rows.map(r => ({ query: r.query, usd: Number(r.usd) || 0, runs: Number(r.runs) || 0 })),
  };
}

async function hasActiveJob(db, query, nowMs = Date.now(), windowMin = parseInt(process.env.APIFY_SCRAPE_DEDUP_MINUTES, 10) || 10) {
  const cutoffMs = nowMs - windowMin * 60 * 1000;
  const res = await db.query(
    `SELECT created_at FROM scrape_jobs WHERE query = $1 AND status = 'running'`,
    [query]
  );
  return res.rows.some((r) => {
    let s = (r.created_at || '').trim().replace(' ', 'T'); // sqlite "YYYY-MM-DD HH:MM:SS" → "...T..."
    if (s && !/(Z|[+-]\d\d:?\d\d)$/.test(s)) s += 'Z';      // treat a naive timestamp as UTC (both backends store UTC)
    const t = Date.parse(s);
    return Number.isFinite(t) && t >= cutoffMs;
  });
}

class InstagramScraper {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this._anthropic = null;
  }

  _getAnthropic() {
    if (this._anthropic) return this._anthropic;
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return null;
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      this._anthropic = new Anthropic({ apiKey: key });
      return this._anthropic;
    } catch { return null; }
  }

  // Classify many candidates in ONE call. items: [{ username, bio, captionSnippet, taggedBy }].
  // Returns { usernameLower: 'female'|'male'|'unknown' }. Never throws.
  async _classifyGenderBatch(items) {
    const result = {};
    const remaining = [];
    for (const it of items) {
      const kw = classifyGenderKeyword(it.username, it.bio);
      if (kw !== 'unknown') result[it.username.toLowerCase()] = kw;
      else remaining.push(it);
    }
    if (remaining.length === 0) return result;

    const client = this._getAnthropic();
    if (!client) {
      for (const it of remaining) result[it.username.toLowerCase()] = 'unknown';
      return result;
    }

    const t0 = Date.now();
    try {
      const lines = remaining.map((it, i) =>
        `${i + 1}. username: ${it.username} | bio: ${it.bio || '(none)'} | seen in caption: ${(it.captionSnippet || '').slice(0, 120) || '(none)'} | tagged by: ${it.taggedBy || '(none)'}`
      ).join('\n');
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        temperature: 0,
        system: 'You classify the likely gender of Instagram creators for a female-creator competitor list. Respond with ONLY JSON: {"verdicts":[{"username":"<as given>","gender":"female|male|unknown"}]}. Use "unknown" when unsure — do not guess.',
        messages: [{ role: 'user', content: `Classify each creator:\n${lines}` }],
      });
      const text = (response.content || []).map(b => b.text || '').join('');
      const verdicts = parseGenderBatch(text, remaining.map(it => it.username));
      Object.assign(result, verdicts);
    } catch (err) {
      console.log(`[Gender] Batch classify failed: ${err.message}`);
      for (const it of remaining) if (!(it.username.toLowerCase() in result)) result[it.username.toLowerCase()] = 'unknown';
    }
    console.log(`[Metric] classify_batch n=${remaining.length} ms=${Date.now() - t0}`);
    return result;
  }

  async startScrapeJob({ query, queryType, minLikes, minViews, startDate, endDate, source }) {
    const jobSource = source || 'manual';

    // Footgun #2: skip if an active scrape for the same query is already running.
    try {
      if (await hasActiveJob(pool, query)) {
        console.log(`[Scraper] Skipping @${query} — an active scrape job already exists.`);
        return { skipped: true, reason: 'already running' };
      }
    } catch (e) {
      console.error('[Scraper] collision check failed (continuing):', e.message);
    }

    const result = await pool.query(
      `INSERT INTO scrape_jobs (query, query_type, status, source) VALUES ($1, $2, 'running', $3) RETURNING id`,
      [query, queryType, jobSource]
    );
    const jobId = result.rows[0].id;

    try {
      const { actorId, input } = this._buildInput(query, queryType);
      const run = await this._startApifyRun(actorId, input, { purpose: 'scrape', query, scrapeJobId: jobId });

      await pool.query('UPDATE scrape_jobs SET apify_run_id = $1 WHERE id = $2', [run.id, jobId]);

      this._pollAndStore(run.id, jobId, { minLikes, minViews, startDate, endDate, query });
      return { jobId, apifyRunId: run.id, status: 'running' };
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        await pool.query('UPDATE scrape_jobs SET status = $1, error = $2 WHERE id = $3', ['skipped', err.message, jobId]);
        throw err; // let the caller (route / scheduler) handle it distinctly
      }
      await pool.query('UPDATE scrape_jobs SET status = $1, error = $2 WHERE id = $3', ['failed', err.message, jobId]);
      throw err;
    }
  }

  _buildInput(query, queryType) {
    if (queryType === 'username') {
      return {
        actorId: REEL_ACTOR_ID,
        input: { username: [query.replace('@', '')], resultsLimit: 50 },
      };
    } else if (queryType === 'hashtag') {
      return {
        actorId: GENERIC_ACTOR_ID,
        input: {
          directUrls: [`https://www.instagram.com/explore/tags/${query.replace('#', '')}/`],
          resultsLimit: 50,
          resultsType: 'posts',
        },
      };
    } else if (queryType === 'url') {
      return {
        actorId: REEL_ACTOR_ID,
        input: { directUrls: [query], resultsLimit: 50 },
      };
    }
    return { actorId: REEL_ACTOR_ID, input: { username: [query], resultsLimit: 50 } };
  }

  async _startApifyRun(actorId, input, context = {}) {
    const status = await budgetStatus(pool);
    if (status.over) throw new BudgetExceededError(status);

    const res = await fetch(
      `${APIFY_BASE}/acts/${actorId}/runs?token=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Apify API error: ${res.status} — ${text}`);
    }
    const data = await res.json();
    const run = data.data;
    try {
      await recordRunLaunch(pool, {
        runId: run.id,
        actorId,
        purpose: context.purpose || 'scrape',
        query: context.query || null,
        scrapeJobId: context.scrapeJobId || null,
      });
    } catch (e) {
      console.error('[Apify] ledger launch insert failed:', e.message);
    }
    return run;
  }

  async _pollAndStore(runId, jobId, filters) {
    const maxAttempts = 60;
    let attempts = 0;
    const resultsLimit = 50;

    await pool.query(
      'UPDATE scrape_jobs SET progress = 5, status_message = $1 WHERE id = $2',
      ['Starting Apify actor...', jobId]
    );

    const poll = async () => {
      attempts++;
      try {
        const res = await fetch(`${APIFY_BASE}/actor-runs/${runId}?token=${this.apiKey}`);
        const data = await res.json();
        const run = data.data;
        const status = run.status;
        const statusMessage = run.statusMessage || '';

        let progress = Math.min(Math.round((attempts / maxAttempts) * 80), 80);
        if (run.stats) {
          const itemCount = run.stats.itemCount || run.stats.pagesLoaded || 0;
          if (itemCount > 0) {
            progress = Math.min(Math.round((itemCount / resultsLimit) * 90), 90);
          }
        }

        if (status === 'SUCCEEDED') {
          await pool.query(
            'UPDATE scrape_jobs SET progress = 95, status_message = $1 WHERE id = $2',
            ['Saving results...', jobId]
          );
          await this._fetchAndStoreResults(runId, jobId, filters);
          try { await recordRunCompletion(pool, { runId, runObject: run, status: 'succeeded' }); } catch (e) { console.error('[Apify] ledger finalize failed:', e.message); }
          return;
        } else if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
          await pool.query(
            `UPDATE scrape_jobs SET status = $1, error = $2, progress = $3, status_message = $4, completed_at = TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') WHERE id = $5`,
            ['failed', `Apify run ${status}`, progress, statusMessage, jobId]
          );
          if (isTrackedUsernameQuery(filters.query)) {
            try { await pool.query(`UPDATE tracked_accounts SET consecutive_failures = COALESCE(consecutive_failures, 0) + 1 WHERE username = $1`, [filters.query.replace('@', '')]); } catch (e) {}
          }
          try { await recordRunCompletion(pool, { runId, runObject: run, status: 'failed' }); } catch (e) { console.error('[Apify] ledger finalize failed:', e.message); }
          return;
        }

        await pool.query(
          'UPDATE scrape_jobs SET progress = $1, status_message = $2 WHERE id = $3',
          [progress, statusMessage || `Scraping... (poll ${attempts}/${maxAttempts})`, jobId]
        );

        if (attempts < maxAttempts) {
          setTimeout(poll, 5000);
        } else {
          await pool.query(
            `UPDATE scrape_jobs SET status = $1, error = $2, progress = $3, completed_at = TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') WHERE id = $4`,
            ['failed', 'Polling timeout', progress, jobId]
          );
          if (isTrackedUsernameQuery(filters.query)) {
            try { await pool.query(`UPDATE tracked_accounts SET consecutive_failures = COALESCE(consecutive_failures, 0) + 1 WHERE username = $1`, [filters.query.replace('@', '')]); } catch (e) {}
          }
          try { await recordRunCompletion(pool, { runId, runObject: run, status: 'failed' }); } catch (e) { console.error('[Apify] ledger finalize failed:', e.message); }
        }
      } catch (err) {
        await pool.query(
          `UPDATE scrape_jobs SET status = $1, error = $2, completed_at = TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') WHERE id = $3`,
          ['failed', err.message, jobId]
        );
        try { await recordRunCompletion(pool, { runId, status: 'failed' }); } catch (e) { console.error('[Apify] ledger finalize failed:', e.message); }
      }
    };

    setTimeout(poll, 10000);
  }

  async _fetchAndStoreResults(runId, jobId, filters) {
    const res = await fetch(`${APIFY_BASE}/actor-runs/${runId}/dataset/items?token=${this.apiKey}`);
    let items = await res.json();

    // Fallback: if reel scraper returned very few items, retry with generic scraper
    const fallbackDisabled = /^(1|true|yes)$/i.test(process.env.APIFY_DISABLE_REEL_FALLBACK || '');
    if (!fallbackDisabled && items.length <= 3 && filters.query && !filters.query.startsWith('#') && !filters.query.startsWith('http')) {
      console.log(`[Scraper] Reel scraper returned only ${items.length} items for "${filters.query}", trying generic scraper...`);
      await pool.query('UPDATE scrape_jobs SET status_message = $1 WHERE id = $2', ['Retrying with generic scraper...', jobId]);
      try {
        const fallbackRun = await this._startApifyRun(GENERIC_ACTOR_ID, {
          directUrls: [`https://www.instagram.com/${filters.query.replace('@', '')}/`],
          resultsType: 'posts',
          resultsLimit: 50,
        }, { purpose: 'fallback', query: filters.query });
        const fallbackItems = await this._waitForRun(fallbackRun.id, 30);
        if (fallbackItems && fallbackItems.length > items.length) {
          console.log(`[Scraper] Generic scraper returned ${fallbackItems.length} items (vs ${items.length})`);
          items = fallbackItems;
        }
      } catch (err) {
        console.log(`[Scraper] Generic fallback failed: ${err.message}`);
      }
    }

    let followersCount = 0;
    for (const item of items) {
      const fc = item.ownerFollowerCount || item.followersCount || item.owner?.followerCount || 0;
      if (fc > 0) { followersCount = fc; break; }
    }

    let count = 0;
    let matched = 0;
    let accountHandle = '';

    for (const item of items) {
      const likes = (item.likesCount != null && item.likesCount >= 0) ? item.likesCount : (item.likes || 0);
      const comments = (item.commentsCount != null && item.commentsCount >= 0) ? item.commentsCount : (item.comments || 0);
      const views = extractViews(item);

      let postedAt = null;
      if (item.timestamp) {
        postedAt = typeof item.timestamp === 'string' ? item.timestamp : new Date(item.timestamp * 1000).toISOString();
      } else if (item.takenAtTimestamp) {
        postedAt = new Date(item.takenAtTimestamp * 1000).toISOString();
      }

      const itemFollowers = item.ownerFollowerCount || item.followersCount || item.owner?.followerCount || followersCount;
      const { er_percent, er_label } = calcER(likes, comments, itemFollowers);

      const taggedHandles = normalizeTaggedUsers(item, item.ownerUsername || item.owner?.username || '');
      const taggedJson = taggedHandles ? JSON.stringify(taggedHandles) : null;

      const post = {
        _type: item.type || 'Unknown',
        _productType: item.productType || '',
        shortcode: item.shortCode || item.id || `post_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        videoUrl: item.videoUrl || null,
        thumbnailUrl: item.displayUrl || (item.images && item.images[0]) || null,
        caption: item.caption || '',
        likeCount: likes,
        commentCount: comments,
        viewCount: views,
        postedAt,
        accountHandle: item.ownerUsername || item.owner?.username || '',
        postUrl: item.url || (item.shortCode ? `https://www.instagram.com/p/${item.shortCode}/` : ''),
        sourceQuery: filters.query || '',
        followersAtScrape: itemFollowers,
        erPercent: er_percent,
        erLabel: er_label,
      };

      if (!this._passesFilters(post, filters)) continue;
      matched++;
      if (post.accountHandle) accountHandle = post.accountHandle;

      try {
        const insertResult = await pool.query(`
          INSERT INTO posts (shortcode, video_url, thumbnail_url, caption, like_count, comment_count,
            view_count, posted_at, account_handle, post_url, source_query, followers_at_scrape, er_percent, er_label, tagged_users)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
          ON CONFLICT (shortcode) DO UPDATE SET
            thumbnail_url = EXCLUDED.thumbnail_url,
            video_url = EXCLUDED.video_url,
            like_count = EXCLUDED.like_count,
            comment_count = EXCLUDED.comment_count,
            view_count = EXCLUDED.view_count,
            followers_at_scrape = EXCLUDED.followers_at_scrape,
            er_percent = EXCLUDED.er_percent,
            er_label = EXCLUDED.er_label,
            tagged_users = EXCLUDED.tagged_users,
            thumbnail_cache_status = 'pending'
        `, [
          post.shortcode, post.videoUrl, post.thumbnailUrl, post.caption,
          post.likeCount, post.commentCount, post.viewCount, post.postedAt,
          post.accountHandle, post.postUrl, post.sourceQuery,
          post.followersAtScrape, post.erPercent, post.erLabel, taggedJson,
        ]);
        if (insertResult.rowCount > 0) count++; // counts both new inserts and refreshed rows
      } catch (e) {
        // skip on error
      }
    }

    // Update tracked account if it exists
    if (accountHandle) {
      await pool.query(
        `UPDATE tracked_accounts SET last_scraped_at = TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), last_post_count = $1, followers = $2, consecutive_failures = 0, updated_at = TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') WHERE username = $3`,
        [count, followersCount, accountHandle]
      );
    } else if (count === 0 && isTrackedUsernameQuery(filters.query) && !filters.minLikes && !filters.minViews && !filters.startDate && !filters.endDate) {
      // Scrape completed but found nothing for a tracked account (no filters) → count as a failure for cadence backoff.
      try {
        await pool.query(
          `UPDATE tracked_accounts SET consecutive_failures = COALESCE(consecutive_failures, 0) + 1 WHERE username = $1`,
          [filters.query.replace('@', '')]
        );
      } catch (e) { console.error('[Cadence] 0-post failure record failed:', e.message); }
    }

    await pool.query(
      `UPDATE scrape_jobs SET status = $1, posts_found = $2, progress = 100, status_message = $3, completed_at = TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') WHERE id = $4`,
      ['completed', count, `Done — ${count} new, ${matched} reels matched (${items.length} total scraped)`, jobId]
    );

    // Fire-and-forget: cache thumbnails for the just-scraped posts while URLs are fresh.
    sweepThumbnails({ batchLimit: 80 }).catch(err => console.error('[Sweep] post-scrape sweep failed:', err.message));
  }

  _passesFilters(post, filters) {
    const isVideo = post._type === 'Video' || post._productType === 'clips' || !!post.videoUrl;
    if (!isVideo) return false;
    const likes = post.likeCount || 0;
    const views = post.viewCount || 0;
    if (filters.minLikes && likes < filters.minLikes) return false;
    if (filters.minViews && views < filters.minViews) return false;
    if (filters.startDate && post.postedAt) {
      if (new Date(post.postedAt) < new Date(filters.startDate)) return false;
    }
    if (filters.endDate && post.postedAt) {
      if (new Date(post.postedAt) > new Date(filters.endDate)) return false;
    }
    return true;
  }

  // ─── Discovery: find related accounts ──────────────────────────
  // opts.enrich (default true): when false, return raw harvested candidates
  // (DB caption/tagged mining + generic-actor mentions/tagged) and skip the
  // per-candidate Apify enrichment + gender filter. The caller (runDiscovery)
  // then enriches/classifies the deduped batch once, globally.
  async discoverRelated(username, opts = {}) {
    const { enrich = true } = opts;
    const candidates = [];
    const seen = new Set();

    // Phase 1: Mine existing posts in DB for @mentions and tagged collaborators
    const postsResult = await pool.query(
      "SELECT caption, tagged_users FROM posts WHERE account_handle = $1",
      [username]
    );

    for (const post of postsResult.rows) {
      const mentions = (post.caption || '').match(/@([a-zA-Z0-9_.]{3,30})/g) || [];
      for (const mention of mentions) {
        const handle = mention.replace('@', '').toLowerCase();
        if (!seen.has(handle) && handle !== username.toLowerCase()) {
          seen.add(handle);
          candidates.push({
            username: handle,
            source: `mentioned_by:${username}`,
            sourceAccount: username,
            captionSnippet: (post.caption || '').slice(0, 160),
            relevanceReason: `Tagged by @${username}`,
            relevanceScore: 35,
          });
        }
      }
      for (const handle of parseTaggedUsers(post.tagged_users)) {
        if (!seen.has(handle) && handle !== username.toLowerCase()) {
          seen.add(handle);
          candidates.push({
            username: handle,
            source: `tagged_by:${username}`,
            sourceAccount: username,
            captionSnippet: (post.caption || '').slice(0, 160),
            relevanceReason: `Photo-tagged by @${username}`,
            relevanceScore: 40,
          });
        }
      }
    }
    console.log(`[Discovery] Phase-1 DB mining for @${username}: ${candidates.length} candidates (caption + tagged)`);

    // Phase 2: Use Apify to scrape posts for mentions and tagged users
    try {
      console.log(`[Discovery] Running Apify for @${username}...`);
      const run = await this._startApifyRun(GENERIC_ACTOR_ID, {
        directUrls: [`https://www.instagram.com/${username}/`],
        resultsType: 'posts',
        resultsLimit: 30,
      }, { purpose: 'discovery', query: username });

      const items = await this._waitForRun(run.id, 30);
      if (!items) {
        console.log(`[Discovery] Apify run failed for @${username}`);
        return candidates;
      }

      for (const item of items) {
        const mentions = (item.caption || '').match(/@([a-zA-Z0-9_.]{3,30})/g) || [];
        for (const mention of mentions) {
          const handle = mention.replace('@', '').toLowerCase();
          if (!seen.has(handle) && handle !== username.toLowerCase()) {
            seen.add(handle);
            candidates.push({
              username: handle,
              source: `mentioned_by:${username}`,
              sourceAccount: username,
              captionSnippet: (item.caption || '').slice(0, 160),
              relevanceReason: `Tagged by @${username}`,
              relevanceScore: 35,
            });
          }
        }

        const taggedUsers = item.taggedUsers || item.usertags || [];
        for (const tag of taggedUsers) {
          const handle = (typeof tag === 'string' ? tag : tag.username || tag.user?.username || '').toLowerCase();
          if (handle && !seen.has(handle) && handle !== username.toLowerCase()) {
            seen.add(handle);
            candidates.push({
              username: handle,
              source: `tagged_by:${username}`,
              sourceAccount: username,
              captionSnippet: (item.caption || '').slice(0, 160),
              relevanceReason: `Photo-tagged by @${username}`,
              relevanceScore: 40,
            });
          }
        }
      }
    } catch (err) {
      console.error(`[Discovery] Apify error for @${username}:`, err.message);
    }

    // Harvest-only mode: hand the raw candidates back so the caller can enrich +
    // gender-classify the deduped batch once, instead of per-source.
    if (!enrich) {
      console.log(`[Discovery] Harvest-only for @${username}: ${candidates.length} raw candidates`);
      return candidates;
    }

    const enriched = await this.enrichCandidates(candidates, { apifyMax: 4, dbMax: 20 });

    let filtered = enriched.filter(c => c.followers <= 500000);

    // Gender: classify the whole batch once; drop male, keep female + unknown (unknown parks at read time).
    console.log(`[Discovery] Classifying gender for ${filtered.length} candidates...`);
    const verdicts = await this._classifyGenderBatch(
      filtered.map(c => ({ username: c.username, bio: c.bio || '', captionSnippet: c.captionSnippet, taggedBy: c.sourceAccount }))
    );
    const genderResults = [];
    for (const c of filtered) {
      const gender = verdicts[c.username.toLowerCase()] || 'unknown';
      if (gender === 'male') { console.log(`[Discovery] Filtered out @${c.username} (male)`); continue; }
      c.gender = gender;
      genderResults.push(c);
    }
    filtered = genderResults;

    console.log(`[Discovery] Found ${filtered.length} female/unknown candidates for @${username}`);
    return filtered;
  }

  // Enrich candidates: DB-first (free — reuse already-scraped posts), then a
  // single Apify profile fetch for up to `apifyMax` that lack DB data. Mutates
  // and returns the candidate objects. Shared by per-source discovery and the
  // global post-aggregation pass so each unique candidate is enriched ≤ once.
  async enrichCandidates(candidates, opts = {}) {
    const { apifyMax = 4, dbMax = 20 } = opts;
    const enriched = [];
    const needsApify = [];

    for (const candidate of candidates.slice(0, dbMax)) {
      if (!candidate.followers) candidate.followers = 0;
      if (!candidate.avgEr) candidate.avgEr = 0;
      if (!candidate.postsPerWeek) candidate.postsPerWeek = 0;
      if (!candidate.bio) candidate.bio = '';
      if (!candidate.contentBreakdown) candidate.contentBreakdown = '';
      if (!candidate.topHashtags) candidate.topHashtags = '';

      const existing = await pool.query(
        `SELECT COUNT(*) as cnt, ROUND(AVG(er_percent)::numeric, 2) as avg_er, MAX(followers_at_scrape) as followers
         FROM posts WHERE account_handle = $1`,
        [candidate.username]
      );
      const row = existing.rows[0];

      if (row && parseInt(row.cnt) > 0 && row.followers > 0) {
        candidate.followers = row.followers;
        candidate.avgEr = parseFloat(row.avg_er) || 0;

        const datesResult = await pool.query(
          'SELECT posted_at FROM posts WHERE account_handle = $1 AND posted_at IS NOT NULL ORDER BY posted_at',
          [candidate.username]
        );
        const dates = datesResult.rows;
        if (dates.length >= 2) {
          const first = new Date(dates[0].posted_at).getTime();
          const last = new Date(dates[dates.length - 1].posted_at).getTime();
          const weeks = (last - first) / (7 * 24 * 60 * 60 * 1000);
          candidate.postsPerWeek = weeks > 0 ? Math.round((dates.length / weeks) * 10) / 10 : 0;
        }
        enriched.push(candidate);
      } else {
        needsApify.push(candidate);
      }
    }

    console.log(`[Discovery] Enriching ${Math.min(needsApify.length, apifyMax)} candidates via Apify...`);
    for (const candidate of needsApify.slice(0, apifyMax)) {
      try {
        const profile = await this._fetchProfileQuick(candidate.username);
        if (profile) {
          candidate.followers = profile.followers;
          candidate.bio = profile.bio || '';
          candidate.avgEr = profile.avgEr || 0;
          candidate.postsPerWeek = profile.postsPerWeek || 0;
          candidate.contentBreakdown = profile.contentBreakdown || '';
          if (profile.topHashtags) candidate.topHashtags = profile.topHashtags;
        }
      } catch (err) {
        console.log(`[Discovery] Could not enrich @${candidate.username}: ${err.message}`);
      }
      enriched.push(candidate);
      await new Promise(r => setTimeout(r, 2000));
    }

    for (const candidate of needsApify.slice(apifyMax)) {
      enriched.push(candidate);
    }

    return enriched;
  }

  // Helper: wait for an Apify run to finish
  async _waitForRun(runId, maxPolls = 20) {
    for (let i = 0; i < maxPolls; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const res = await fetch(`${APIFY_BASE}/actor-runs/${runId}?token=${this.apiKey}`);
      const data = await res.json();
      if (data.data.status === 'SUCCEEDED') {
        try { await recordRunCompletion(pool, { runId, runObject: data.data, status: 'succeeded' }); } catch (e) { console.error('[Apify] ledger finalize failed:', e.message); }
        const itemsRes = await fetch(`${APIFY_BASE}/actor-runs/${runId}/dataset/items?token=${this.apiKey}`);
        return await itemsRes.json();
      }
      if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(data.data.status)) {
        try { await recordRunCompletion(pool, { runId, runObject: data.data, status: 'failed' }); } catch (e) { console.error('[Apify] ledger finalize failed:', e.message); }
        return null;
      }
    }
    try { await recordRunCompletion(pool, { runId, status: 'failed' }); } catch (e) { console.error('[Apify] ledger finalize failed:', e.message); }
    return null;
  }

  // Lightweight profile fetch — SINGLE Apify call for details
  async _fetchProfileQuick(username) {
    console.log(`[Enrich] Fetching profile for @${username}...`);
    const run = await this._startApifyRun(GENERIC_ACTOR_ID, {
      directUrls: [`https://www.instagram.com/${username}/`],
      resultsType: 'details',
      resultsLimit: 1,
    }, { purpose: 'enrichment', query: username });

    const items = await this._waitForRun(run.id, 12);
    if (!items || items.length === 0) return null;

    const profile = items[0];
    const followers = profile.followersCount || profile.followedByCount || profile.edge_followed_by?.count || 0;
    const bio = profile.biography || profile.bio || '';
    console.log(`[Enrich] @${username}: ${followers} followers`);

    const posts = profile.latestPosts || [];
    let totalEr = 0, erCount = 0;
    let reelCount = 0, imageCount = 0, carouselCount = 0;
    const hashtagCounts = {};

    for (const p of posts) {
      const likes = p.likesCount ?? p.likes ?? 0;
      const comments = p.commentsCount ?? p.comments ?? 0;
      if (followers > 0) { totalEr += ((likes + comments) / followers) * 100; erCount++; }
      if (p.type === 'Video' || p.productType === 'clips') reelCount++;
      else if (p.type === 'Sidecar') carouselCount++;
      else imageCount++;
      const tags = (p.caption || '').match(/#([a-zA-Z0-9_]+)/g) || [];
      tags.forEach(t => { hashtagCounts[t.toLowerCase()] = (hashtagCounts[t.toLowerCase()] || 0) + 1; });
    }

    const avgEr = erCount > 0 ? Math.round((totalEr / erCount) * 100) / 100 : 0;

    let postsPerWeek = 0;
    const timestamps = posts.map(p => p.timestamp || p.takenAtTimestamp).filter(Boolean)
      .map(t => typeof t === 'string' ? new Date(t).getTime() : t * 1000).sort();
    if (timestamps.length >= 2) {
      const spanWeeks = (timestamps[timestamps.length - 1] - timestamps[0]) / (7 * 24 * 60 * 60 * 1000);
      postsPerWeek = spanWeeks > 0 ? Math.round((timestamps.length / spanWeeks) * 10) / 10 : 0;
    }

    const total = reelCount + imageCount + carouselCount;
    const parts = [];
    if (total > 0) {
      if (reelCount > 0) parts.push(`${Math.round(reelCount / total * 100)}% Reels`);
      if (imageCount > 0) parts.push(`${Math.round(imageCount / total * 100)}% Images`);
      if (carouselCount > 0) parts.push(`${Math.round(carouselCount / total * 100)}% Carousels`);
    }

    const topHashtags = Object.entries(hashtagCounts)
      .sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => t).join(', ');

    return { followers, bio, avgEr, postsPerWeek, contentBreakdown: parts.join(', '), topHashtags };
  }

  async importByUrls(urls) {
    if (!urls || urls.length === 0) throw new Error('No URLs provided');
    const cleanUrls = urls.map(u => u.trim()).filter(Boolean);
    if (cleanUrls.length === 0) throw new Error('No valid URLs');

    // Use generic scraper with directUrls
    const run = await this._startApifyRun(GENERIC_ACTOR_ID, {
      directUrls: cleanUrls,
      resultsType: 'posts',
      resultsLimit: cleanUrls.length,
    }, { purpose: 'import', query: cleanUrls[0] || 'import' });

    const items = await this._waitForRun(run.id, 40);
    if (!items || items.length === 0) return { imported: 0, total: cleanUrls.length };

    let followersCount = 0;
    for (const item of items) {
      const fc = item.ownerFollowerCount || item.followersCount || item.owner?.followerCount || 0;
      if (fc > 0) { followersCount = fc; break; }
    }

    let count = 0;
    for (const item of items) {
      const likes = (item.likesCount != null && item.likesCount >= 0) ? item.likesCount : (item.likes || 0);
      const comments = (item.commentsCount != null && item.commentsCount >= 0) ? item.commentsCount : (item.comments || 0);
      const views = extractViews(item);

      let postedAt = null;
      if (item.timestamp) {
        postedAt = typeof item.timestamp === 'string' ? item.timestamp : new Date(item.timestamp * 1000).toISOString();
      } else if (item.takenAtTimestamp) {
        postedAt = new Date(item.takenAtTimestamp * 1000).toISOString();
      }

      const itemFollowers = item.ownerFollowerCount || item.followersCount || item.owner?.followerCount || followersCount;
      const { er_percent, er_label } = calcER(likes, comments, itemFollowers);

      const taggedHandles = normalizeTaggedUsers(item, item.ownerUsername || item.owner?.username || '');
      const taggedJson = taggedHandles ? JSON.stringify(taggedHandles) : null;

      const shortcode = item.shortCode || item.id || `import_${Date.now()}_${Math.random().toString(36).slice(2)}`;

      try {
        const insertResult = await pool.query(`
          INSERT INTO posts (shortcode, video_url, thumbnail_url, caption, like_count, comment_count,
            view_count, posted_at, account_handle, post_url, source_query, followers_at_scrape, er_percent, er_label, tagged_users)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
          ON CONFLICT (shortcode) DO NOTHING
        `, [
          shortcode,
          item.videoUrl || null,
          item.displayUrl || (item.images && item.images[0]) || null,
          item.caption || '',
          likes, comments, views, postedAt,
          item.ownerUsername || item.owner?.username || '',
          item.url || (item.shortCode ? `https://www.instagram.com/p/${item.shortCode}/` : ''),
          'manual_import',
          itemFollowers, er_percent, er_label, taggedJson,
        ]);
        if (insertResult.rowCount > 0) count++;
      } catch (e) { /* skip duplicates */ }
    }

    return { imported: count, total: cleanUrls.length, scraped: items.length };
  }

  async getJobStatus(jobId) {
    const result = await pool.query('SELECT * FROM scrape_jobs WHERE id = $1', [jobId]);
    return result.rows[0] || null;
  }

  async getAllJobs() {
    const result = await pool.query('SELECT * FROM scrape_jobs ORDER BY created_at DESC LIMIT 20');
    return result.rows;
  }
}

module.exports = InstagramScraper;
module.exports.isoNoMillis = isoNoMillis;
module.exports.BudgetExceededError = BudgetExceededError;
module.exports.extractUsageUsd = extractUsageUsd;
module.exports.budgetStatus = budgetStatus;
module.exports.recordRunLaunch = recordRunLaunch;
module.exports.recordRunCompletion = recordRunCompletion;
module.exports.usageSummary = usageSummary;
module.exports.hasActiveJob = hasActiveJob;
module.exports.extractViews = extractViews;
module.exports.normalizeTaggedUsers = normalizeTaggedUsers;
module.exports.parseTaggedUsers = parseTaggedUsers;
module.exports.isTrackedUsernameQuery = isTrackedUsernameQuery;
module.exports.classifyGenderKeyword = classifyGenderKeyword;
module.exports.parseGenderBatch = parseGenderBatch;
module.exports.scoreCandidate = scoreCandidate;
module.exports.genderRank = genderRank;
module.exports.aggregateCandidates = aggregateCandidates;
module.exports.suggestionsOrderClause = suggestionsOrderClause;
