const fetch = require('node-fetch');
const db = require('./db');

const APIFY_BASE = 'https://api.apify.com/v2';
const REEL_ACTOR_ID = 'apify~instagram-reel-scraper';
const GENERIC_ACTOR_ID = 'apify~instagram-scraper';

class InstagramScraper {
  constructor(apiKey) {
    this.apiKey = apiKey;
  }

  async startScrapeJob({ query, queryType, minLikes, minViews, startDate, endDate }) {
    const job = db.prepare(`
      INSERT INTO scrape_jobs (query, query_type, status)
      VALUES (?, ?, 'running')
    `).run(query, queryType);

    const jobId = job.lastInsertRowid;

    try {
      const { actorId, input } = this._buildInput(query, queryType);
      const run = await this._startApifyRun(actorId, input);

      db.prepare('UPDATE scrape_jobs SET apify_run_id = ? WHERE id = ?')
        .run(run.id, jobId);

      // Poll for completion in background
      this._pollAndStore(run.id, jobId, { minLikes, minViews, startDate, endDate, query });

      return { jobId, apifyRunId: run.id, status: 'running' };
    } catch (err) {
      db.prepare('UPDATE scrape_jobs SET status = ?, error = ? WHERE id = ?')
        .run('failed', err.message, jobId);
      throw err;
    }
  }

  _buildInput(query, queryType) {
    if (queryType === 'username') {
      // Use the dedicated reel scraper for usernames
      return {
        actorId: REEL_ACTOR_ID,
        input: {
          username: [query.replace('@', '')],
          resultsLimit: 50,
        },
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
        input: {
          directUrls: [query],
          resultsLimit: 50,
        },
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

    const poll = async () => {
      attempts++;
      try {
        const res = await fetch(
          `${APIFY_BASE}/actor-runs/${runId}?token=${this.apiKey}`
        );
        const data = await res.json();
        const run = data.data;
        const status = run.status;

        // Calculate progress from Apify stats
        const statusMessage = run.statusMessage || '';
        let progress = Math.min(Math.round((attempts / maxAttempts) * 80), 80); // fallback: time-based estimate

        if (run.stats) {
          const itemCount = run.stats.itemCount || run.stats.pagesLoaded || 0;
          if (itemCount > 0) {
            progress = Math.min(Math.round((itemCount / resultsLimit) * 90), 90);
          }
        }

        if (status === 'SUCCEEDED') {
          db.prepare('UPDATE scrape_jobs SET progress = 95, status_message = ? WHERE id = ?')
            .run('Saving results...', jobId);
          await this._fetchAndStoreResults(runId, jobId, filters);
          return;
        } else if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
          db.prepare('UPDATE scrape_jobs SET status = ?, error = ?, progress = ?, status_message = ?, completed_at = datetime(\'now\') WHERE id = ?')
            .run('failed', `Apify run ${status}`, progress, statusMessage, jobId);
          return;
        }

        // Update progress while running
        db.prepare('UPDATE scrape_jobs SET progress = ?, status_message = ? WHERE id = ?')
          .run(progress, statusMessage || `Scraping... (poll ${attempts}/${maxAttempts})`, jobId);

        if (attempts < maxAttempts) {
          setTimeout(poll, 5000);
        } else {
          db.prepare('UPDATE scrape_jobs SET status = ?, error = ?, progress = ?, completed_at = datetime(\'now\') WHERE id = ?')
            .run('failed', 'Polling timeout', progress, jobId);
        }
      } catch (err) {
        db.prepare('UPDATE scrape_jobs SET status = ?, error = ?, completed_at = datetime(\'now\') WHERE id = ?')
          .run('failed', err.message, jobId);
      }
    };

    // Initial progress
    db.prepare('UPDATE scrape_jobs SET progress = 5, status_message = ? WHERE id = ?')
      .run('Starting Apify actor...', jobId);

    setTimeout(poll, 10000);
  }

  async _fetchAndStoreResults(runId, jobId, filters) {
    const res = await fetch(
      `${APIFY_BASE}/actor-runs/${runId}/dataset/items?token=${this.apiKey}`
    );
    const items = await res.json();

    const insert = db.prepare(`
      INSERT OR IGNORE INTO posts
        (shortcode, video_url, thumbnail_url, caption, like_count, comment_count, view_count, posted_at, account_handle, post_url, source_query)
      VALUES
        (@shortcode, @videoUrl, @thumbnailUrl, @caption, @likeCount, @commentCount, @viewCount, @postedAt, @accountHandle, @postUrl, @sourceQuery)
    `);

    let count = 0;
    let matched = 0;
    const insertMany = db.transaction((posts) => {
      for (const post of posts) {
        if (this._passesFilters(post, filters)) {
          matched++;
          const result = insert.run(post);
          if (result.changes > 0) count++;
        }
      }
    });

    const mapped = items.map((item) => {
      // Handle -1 values (Apify uses -1 for "unavailable")
      const likes = (item.likesCount != null && item.likesCount >= 0) ? item.likesCount : (item.likes || 0);
      const comments = (item.commentsCount != null && item.commentsCount >= 0) ? item.commentsCount : (item.comments || 0);
      // Prefer videoPlayCount (total plays) > videoViewCount > 0
      const views = item.videoPlayCount || item.videoViewCount || 0;

      // Parse timestamp — Apify returns ISO string or unix seconds
      let postedAt = null;
      if (item.timestamp) {
        postedAt = typeof item.timestamp === 'string' ? item.timestamp : new Date(item.timestamp * 1000).toISOString();
      } else if (item.takenAtTimestamp) {
        postedAt = new Date(item.takenAtTimestamp * 1000).toISOString();
      }

      return {
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
      };
    });

    insertMany(mapped);

    db.prepare('UPDATE scrape_jobs SET status = ?, posts_found = ?, progress = 100, status_message = ?, completed_at = datetime(\'now\') WHERE id = ?')
      .run('completed', count, `Done — ${count} new, ${matched} reels matched (${items.length} total scraped)`, jobId);
  }

  _passesFilters(post, filters) {
    // Only allow reels/videos
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

  getJobStatus(jobId) {
    return db.prepare('SELECT * FROM scrape_jobs WHERE id = ?').get(jobId);
  }

  getAllJobs() {
    return db.prepare('SELECT * FROM scrape_jobs ORDER BY created_at DESC LIMIT 20').all();
  }
}

module.exports = InstagramScraper;
