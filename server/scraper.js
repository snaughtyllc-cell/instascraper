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

  async startScrapeJob({ query, queryType, minLikes, minViews, startDate, endDate }) {
        const result = await pool.query(
                `INSERT INTO scrape_jobs (query, query_type, status) VALUES ($1, $2, 'running') RETURNING id`,
                [query, queryType]
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
