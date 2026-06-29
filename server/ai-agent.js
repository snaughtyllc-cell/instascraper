const Anthropic = require('@anthropic-ai/sdk');
const pool = require('./db');

const IDEAS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ideas'],
  properties: {
    ideas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['concept', 'format', 'why_working', 'hook_line', 'source_niche', 'source_posts'],
        properties: {
          concept: { type: 'string' },
          format: { type: 'string' },
          why_working: { type: 'string' },
          hook_line: { type: 'string' },
          source_niche: { type: 'string' },
          source_posts: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

class ContentIdeaAgent {
  constructor(apiKey) {
    this.apiKey = apiKey;
    if (apiKey) {
      this.client = new Anthropic({ apiKey });
    }
  }

  async generateIdeasForModel(modelId) {
    if (!this.client) throw new Error('ANTHROPIC_API_KEY not configured');

    // Load model
    const modelResult = await pool.query('SELECT * FROM models WHERE id = $1', [modelId]);
    const model = modelResult.rows[0];
    if (!model) throw new Error(`Model ${modelId} not found`);

    const batchId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Get top content by niche
    const { primaryPosts, secondaryPosts, staleNiches } = await this._queryTopContent(
      model.primary_niche,
      model.secondary_niches ? model.secondary_niches.split(',').map(s => s.trim()).filter(Boolean) : []
    );

    const allPosts = [...primaryPosts, ...secondaryPosts];
    if (allPosts.length === 0) {
      // No content at all — create a warning card
      await pool.query(
        `INSERT INTO idea_cards (model_id, batch_id, concept, format, why_working, hook_line, source_niche, stale_warning, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')`,
        [modelId, batchId, 'No trending content found in your niche this period.',
         '', '', '', model.primary_niche, 'No scraped content available for this niche. Add more tracked accounts.']
      );
      return { batchId, ideaCount: 0, warning: 'No content in niche' };
    }

    // Call Claude to generate ideas
    const { ideas, warning } = await this._callClaude(allPosts, model, staleNiches);

    let freshIdeas = [];
    if (warning) {
      // Surface the failure as a clear warning card instead of silently storing nothing.
      await pool.query(
        `INSERT INTO idea_cards (model_id, batch_id, concept, format, why_working, hook_line, source_niche, stale_warning, status)
         VALUES ($1, $2, $3, '', '', '', $4, $5, 'pending')`,
        [modelId, batchId, warning, model.primary_niche, warning]
      );
    } else {
      // Deduplicate against previous ideas
      freshIdeas = await this._deduplicateIdeas(modelId, ideas);

      // Store idea cards
      for (const idea of freshIdeas) {
        await pool.query(
          `INSERT INTO idea_cards (model_id, batch_id, concept, format, why_working, hook_line, source_niche, source_post_ids, stale_warning)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [modelId, batchId, idea.concept, idea.format || '', idea.why_working || '',
           idea.hook_line || '', idea.source_niche || model.primary_niche,
           Array.isArray(idea.source_posts) ? idea.source_posts.join(',') : (idea.source_post_ids || ''), idea.stale_warning || null]
        );
      }
    }

    // Add stale niche warnings
    for (const niche of staleNiches) {
      await pool.query(
        `INSERT INTO idea_cards (model_id, batch_id, concept, format, why_working, hook_line, source_niche, stale_warning)
         VALUES ($1, $2, $3, '', '', '', $4, $5)`,
        [modelId, batchId, `Limited fresh content for "${niche}" — consider scraping more accounts in this category.`,
         niche, `Fewer than 3 posts in last 14 days for ${niche}`]
      );
    }

    console.log(`[AI Agent] Generated ${freshIdeas.length} ideas for ${model.name} (batch ${batchId})`);
    return { batchId, ideaCount: freshIdeas.length, staleNiches, warning: warning || undefined };
  }

  async _queryTopContent(primaryNiche, secondaryNiches) {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const staleNiches = [];

    // Query primary niche posts
    const primaryLimit = secondaryNiches.length > 0 ? 21 : 30;
    const primaryResult = await pool.query(
      `SELECT p.id, p.shortcode, p.caption, p.view_count, p.like_count, p.comment_count,
              p.er_percent, p.account_handle, p.post_url, COALESCE(p.content_type, ct.content_type) as niche
       FROM posts p
       LEFT JOIN creator_types ct ON p.account_handle = ct.account_handle
       WHERE COALESCE(p.content_type, ct.content_type) = $1
         AND posted_at >= $2
         AND (soft_deleted = 0 OR soft_deleted IS NULL)
         AND (archived = 0 OR archived IS NULL)
       ORDER BY (COALESCE(p.view_count, 0) * 0.4 + COALESCE(p.like_count, 0) * 0.3 + COALESCE(p.er_percent, 0) * 30) DESC
       LIMIT $3`,
      [primaryNiche, thirtyDaysAgo, primaryLimit]
    );

    // Check if primary niche is stale
    const primaryFreshCount = await pool.query(
      `SELECT COUNT(*) as cnt FROM posts p
       LEFT JOIN creator_types ct ON p.account_handle = ct.account_handle
       WHERE COALESCE(p.content_type, ct.content_type) = $1
         AND posted_at >= $2
         AND (soft_deleted = 0 OR soft_deleted IS NULL)`,
      [primaryNiche, new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()]
    );
    if (parseInt(primaryFreshCount.rows[0].cnt) < 3) staleNiches.push(primaryNiche);

    // Query secondary niches
    let secondaryPosts = [];
    if (secondaryNiches.length > 0) {
      const perNiche = Math.ceil(9 / secondaryNiches.length);
      for (const niche of secondaryNiches) {
        const result = await pool.query(
          `SELECT p.id, p.shortcode, p.caption, p.view_count, p.like_count, p.comment_count,
                  p.er_percent, p.account_handle, p.post_url, COALESCE(p.content_type, ct.content_type) as niche
           FROM posts p
           LEFT JOIN creator_types ct ON p.account_handle = ct.account_handle
           WHERE COALESCE(p.content_type, ct.content_type) = $1
             AND posted_at >= $2
             AND (soft_deleted = 0 OR soft_deleted IS NULL)
             AND (archived = 0 OR archived IS NULL)
           ORDER BY (COALESCE(p.view_count, 0) * 0.4 + COALESCE(p.like_count, 0) * 0.3 + COALESCE(p.er_percent, 0) * 30) DESC
           LIMIT $3`,
          [niche, thirtyDaysAgo, perNiche]
        );
        secondaryPosts.push(...result.rows);

        // Check stale
        const freshCount = await pool.query(
          `SELECT COUNT(*) as cnt FROM posts p
           LEFT JOIN creator_types ct ON p.account_handle = ct.account_handle
           WHERE COALESCE(p.content_type, ct.content_type) = $1
             AND posted_at >= $2
             AND (soft_deleted = 0 OR soft_deleted IS NULL)`,
          [niche, new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()]
        );
        if (parseInt(freshCount.rows[0].cnt) < 3) staleNiches.push(niche);
      }
    }

    return { primaryPosts: primaryResult.rows, secondaryPosts, staleNiches };
  }

  async _callClaude(posts, model, staleNiches) {
    const secondaryText = model.secondary_niches
      ? ` (secondary niches: ${model.secondary_niches})`
      : '';

    const postList = posts.slice(0, 25).map((p, i) =>
      `${i + 1}. @${p.account_handle} [${p.niche || 'unknown'}] — ${(p.caption || '').slice(0, 120).replace(/\n/g, ' ')}... | Views: ${(p.view_count || 0).toLocaleString()} | Likes: ${(p.like_count || 0).toLocaleString()} | ER: ${p.er_percent || 0}% | URL: ${p.post_url || `https://www.instagram.com/reel/${p.shortcode}/`}`
    ).join('\n');

    const system = `You are a content strategist for Instagram Reels creators. You analyze trending content performance data and generate specific, producible content ideas — never generic advice. Ground every idea in observable patterns from the data you are given (recurring hooks, formats, or topics driving high views and engagement), and cite the specific source posts that inspired each idea. Each hook line must be a literal, scroll-stopping opening for the first 3 seconds — not a topic label.`;

    const userPrompt = `Generate 3-5 content ideas for ${model.name}, who creates "${model.primary_niche}" content${secondaryText}.

Here are the top-performing posts in their niche from the last 30 days:

${postList}

For each idea provide:
- concept: a specific, producible-this-week idea in 2-3 sentences (not generic advice).
- format: the production format (POV reel, talking head, trend audio, skit, duet, etc.).
- why_working: the observable pattern in the data above that makes this work right now, and why now (1-2 sentences).
- hook_line: the literal opening line for the first 3 seconds.
- source_niche: the niche this idea comes from ("${model.primary_niche}"${model.secondary_niches ? ` or one of: ${model.secondary_niches}` : ''}).
- source_posts: 1-3 post URLs from the list above that most directly inspired this idea.

Weight "${model.primary_niche}" content (70%) over secondary niches (30%). Focus on recurring themes, hooks, formats, and topics driving high engagement in the data.`;

    let response;
    try {
      response = await this.client.messages.create({
        model: 'claude-opus-4-8',
        max_tokens: 6000,
        thinking: { type: 'adaptive' },
        output_config: {
          effort: 'high',
          format: { type: 'json_schema', schema: IDEAS_SCHEMA },
        },
        system,
        messages: [{ role: 'user', content: userPrompt }],
      });
    } catch (e) {
      console.error('[AI Agent] Claude request failed:', e.message);
      return { ideas: [], warning: `Idea generation request failed: ${e.message}` };
    }

    // Refusal: stop_reason is the source of truth; content may be empty.
    if (response.stop_reason === 'refusal') {
      console.warn('[AI Agent] Claude refused idea generation:', response.stop_details?.explanation);
      return { ideas: [], warning: 'Idea generation was declined by the safety system this run. No ideas were generated — try again or adjust the niche.' };
    }

    // With adaptive thinking, content[0] may be a thinking block — find the text block.
    const textBlock = (response.content || []).find(b => b.type === 'text');
    if (!textBlock || !textBlock.text) {
      const why = response.stop_reason === 'max_tokens' ? ' (response was cut off — too long)' : '';
      return { ideas: [], warning: `Idea generation returned no usable content${why}. Try again.` };
    }

    try {
      const parsed = JSON.parse(textBlock.text);
      const ideas = Array.isArray(parsed.ideas) ? parsed.ideas.slice(0, 5) : [];
      if (ideas.length === 0) {
        return { ideas: [], warning: 'Idea generation produced no ideas this run. Try again.' };
      }
      return { ideas, warning: null };
    } catch (e) {
      console.error('[AI Agent] Failed to parse structured response:', textBlock.text.slice(0, 200));
      const why = response.stop_reason === 'max_tokens' ? ' (response was cut off — too long)' : '';
      return { ideas: [], warning: `Idea generation returned malformed data${why}. Try again.` };
    }
  }

  async _deduplicateIdeas(modelId, newIdeas) {
    // Fetch previous ideas from last 30 days
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const prevResult = await pool.query(
      'SELECT concept FROM idea_cards WHERE model_id = $1 AND created_at >= $2',
      [modelId, thirtyDaysAgo]
    );
    const prevConcepts = prevResult.rows.map(r => this._wordSet(r.concept));

    return newIdeas.filter(idea => {
      const newWords = this._wordSet(idea.concept);
      for (const prevWords of prevConcepts) {
        const intersection = new Set([...newWords].filter(w => prevWords.has(w)));
        const union = new Set([...newWords, ...prevWords]);
        const similarity = union.size > 0 ? intersection.size / union.size : 0;
        if (similarity > 0.6) return false;
      }
      return true;
    });
  }

  _wordSet(text) {
    return new Set((text || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2));
  }
}

module.exports = ContentIdeaAgent;
module.exports.IDEAS_SCHEMA = IDEAS_SCHEMA;
