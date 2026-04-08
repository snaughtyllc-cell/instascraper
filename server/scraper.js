const fetch = require('node-fetch');
const pool = require('./db');

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

class InstagramScraper {
  constructor(apiKey) {
    this.apiKey = apiKey;
  }

  async startScrapeJob({ query, queryType, minLikes, minViews, startDate, endDate, source }) {
    const jobSource = source || 'manual';
    const result = await pool.query(
      `INSERT INTO scrape_jobs (query, query_type, status, source) VALUES ($1, $2, 'running', $3) RETURNING id`,
      [query, queryType, jobSource]
    );
    const jobId = result.rows[0].id;

    try {
      const { actorId, input } = this._buildInput(query, queryType);
      const run = await this._startApifyRun(actorId, input);

      await pool.query('UPDATE scrape_jobs SET apify_run_id = $1 WHERE id = $2', [run.id, jobId]);

      this._pollAndStore(run.id, jobId, { minLikes, minViews, startDate, endDate, query });
      return { jobId, apifyRunId: run.id, status: 'running' };
    } catch (err) {
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

  async _startApifyRun(actorId, input) {
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
    return data.data;
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
          return;
        } else if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
          await pool.query(
            `UPDATE scrape_jobs SET status = $1, error = $2, progress = $3, status_message = $4, completed_at = TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') WHERE id = $5`,
            ['failed', `Apify run ${status}`, progress, statusMessage, jobId]
          );
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
        }
      } catch (err) {
        await pool.query(
          `UPDATE scrape_jobs SET status = $1, error = $2, completed_at = TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') WHERE id = $3`,
          ['failed', err.message, jobId]
        );
      }
    };

    setTimeout(poll, 10000);
  }

  async _fetchAndStoreResults(runId, jobId, filters) {
    const res = await fetch(`${APIFY_BASE}/actor-runs/${runId}/dataset/items?token=${this.apiKey}`);
    const items = await res.json();

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
      const views = item.videoPlayCount || item.videoViewCount || 0;

      let postedAt = null;
      if (item.timestamp) {
        postedAt = typeof item.timestamp === 'string' ? item.timestamp : new Date(item.timestamp * 1000).toISOString();
      } else if (item.takenAtTimestamp) {
        postedAt = new Date(item.takenAtTimestamp * 1000).toISOString();
      }

      const itemFollowers = item.ownerFollowerCount || item.followersCount || item.owner?.followerCount || followersCount;
      const { er_percent, er_label } = calcER(likes, comments, itemFollowers);

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
            view_count, posted_at, account_handle, post_url, source_query, followers_at_scrape, er_percent, er_label)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
          ON CONFLICT (shortcode) DO NOTHING
        `, [
          post.shortcode, post.videoUrl, post.thumbnailUrl, post.caption,
          post.likeCount, post.commentCount, post.viewCount, post.postedAt,
          post.accountHandle, post.postUrl, post.sourceQuery,
          post.followersAtScrape, post.erPercent, post.erLabel,
        ]);
        if (insertResult.rowCount > 0) count++;
      } catch (e) {
        // skip duplicates
      }
    }

    // Update tracked account if it exists
    if (accountHandle) {
      await pool.query(
        `UPDATE tracked_accounts SET last_scraped_at = TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), last_post_count = $1, followers = $2, updated_at = TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') WHERE username = $3`,
        [count, followersCount, accountHandle]
      );
    }

    await pool.query(
      `UPDATE scrape_jobs SET status = $1, posts_found = $2, progress = 100, status_message = $3, completed_at = TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') WHERE id = $4`,
      ['completed', count, `Done — ${count} new, ${matched} reels matched (${items.length} total scraped)`, jobId]
    );
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
  async discoverRelated(username) {
    const candidates = [];
    const seen = new Set();

    // Phase 1: Mine existing posts in DB for @mentions
    const postsResult = await pool.query(
      "SELECT caption FROM posts WHERE account_handle = $1 AND caption IS NOT NULL",
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
            relevanceReason: `Tagged by @${username}`,
            relevanceScore: 35,
          });
        }
      }
    }

    // Phase 1b: Find accounts that share hashtags with tracked accounts
    const topHashtagsResult = await pool.query(
      `SELECT caption FROM posts WHERE account_handle = $1 AND caption LIKE '%#%' ORDER BY like_count DESC LIMIT 20`,
      [username]
    );

    const hashtagCounts = {};
    for (const p of topHashtagsResult.rows) {
      const tags = (p.caption || '').match(/#([a-zA-Z0-9_]+)/g) || [];
      tags.forEach(t => { hashtagCounts[t.toLowerCase()] = (hashtagCounts[t.toLowerCase()] || 0) + 1; });
    }
    const commonHashtags = Object.entries(hashtagCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t]) => t);

    if (commonHashtags.length > 0) {
      const otherPostsResult = await pool.query(
        `SELECT DISTINCT account_handle, caption, like_count, comment_count, followers_at_scrape
         FROM posts WHERE account_handle != $1 AND account_handle != ''
         AND (soft_deleted = 0 OR soft_deleted IS NULL)`,
        [username]
      );

      for (const p of otherPostsResult.rows) {
        if (seen.has(p.account_handle.toLowerCase())) continue;
        const postTags = (p.caption || '').match(/#([a-zA-Z0-9_]+)/g) || [];
        const overlap = postTags.filter(t => commonHashtags.includes(t.toLowerCase()));
        if (overlap.length >= 2) {
          seen.add(p.account_handle.toLowerCase());
          candidates.push({
            username: p.account_handle,
            source: `hashtag_overlap:${username}`,
            relevanceReason: `Shares hashtags with @${username}: ${overlap.slice(0, 3).join(', ')}`,
            relevanceScore: 25,
            followers: p.followers_at_scrape || 0,
          });
        }
      }
    }

    // Phase 2: Use Apify to scrape posts for mentions and tagged users
    try {
      console.log(`[Discovery] Running Apify for @${username}...`);
      const run = await this._startApifyRun(GENERIC_ACTOR_ID, {
        directUrls: [`https://www.instagram.com/${username}/`],
        resultsType: 'posts',
        resultsLimit: 30,
      });

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
              relevanceReason: `Photo-tagged by @${username}`,
              relevanceScore: 40,
            });
          }
        }
      }
    } catch (err) {
      console.error(`[Discovery] Apify error for @${username}:`, err.message);
    }

    // Enrich candidates
    const enriched = [];
    const needsApify = [];

    for (const candidate of candidates.slice(0, 20)) {
      if (!candidate.followers) candidate.followers = 0;
      if (!candidate.avgEr) candidate.avgEr = 0;
      if (!candidate.postsPerWeek) candidate.postsPerWeek = 0;
      if (!candidate.bio) candidate.bio = '';
      if (!candidate.contentBreakdown) candidate.contentBreakdown = '';
      if (!candidate.topHashtags) candidate.topHashtags = commonHashtags.join(', ');

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

    console.log(`[Discovery] Enriching ${Math.min(needsApify.length, 4)} candidates via Apify...`);
    for (const candidate of needsApify.slice(0, 4)) {
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

    for (const candidate of needsApify.slice(4)) {
      enriched.push(candidate);
    }

    const filtered = enriched.filter(c => c.followers <= 500000);
    console.log(`[Discovery] Found ${filtered.length} candidates for @${username}`);
    return filtered;
  }

  // Helper: wait for an Apify run to finish
  async _waitForRun(runId, maxPolls = 20) {
    for (let i = 0; i < maxPolls; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const res = await fetch(`${APIFY_BASE}/actor-runs/${runId}?token=${this.apiKey}`);
      const data = await res.json();
      if (data.data.status === 'SUCCEEDED') {
        const itemsRes = await fetch(`${APIFY_BASE}/actor-runs/${runId}/dataset/items?token=${this.apiKey}`);
        return await itemsRes.json();
      }
      if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(data.data.status)) return null;
    }
    return null;
  }

  // Lightweight profile fetch — SINGLE Apify call for details
  async _fetchProfileQuick(username) {
    console.log(`[Enrich] Fetching profile for @${username}...`);
    const run = await this._startApifyRun(GENERIC_ACTOR_ID, {
      directUrls: [`https://www.instagram.com/${username}/`],
      resultsType: 'details',
      resultsLimit: 1,
    });

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
