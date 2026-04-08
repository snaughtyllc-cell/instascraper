const Anthropic = require('@anthropic-ai/sdk');
const pool = require('./db');

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
    const ideas = await this._callClaude(allPosts, model, staleNiches);

    // Deduplicate against previous ideas
    const freshIdeas = await this._deduplicateIdeas(modelId, ideas);

    // Store idea cards
    for (const idea of freshIdeas) {
      await pool.query(
        `INSERT INTO idea_cards (model_id, batch_id, concept, format, why_working, hook_line, source_niche, source_post_ids, stale_warning)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [modelId, batchId, idea.concept, idea.format || '', idea.why_working || '',
         idea.hook_line || '', idea.source_niche || model.primary_niche,
         idea.source_post_ids || '', idea.stale_warning || null]
      );
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
    return { batchId, ideaCount: freshIdeas.length, staleNiches };
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
      `${i + 1}. @${p.account_handle} [${p.niche || 'unknown'}] — ${(p.caption || '').slice(0, 120).replace(/\n/g, ' ')}... | Views: ${(p.view_count || 0).toLocaleString()} | Likes: ${(p.like_count || 0).toLocaleString()} | ER: ${p.er_percent || 0}%`
    ).join('\n');

    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      temperature: 0.8,
      system: `You are a content strategist for Instagram Reels creators. You analyze trending content data and generate actionable content ideas. Always respond with ONLY a JSON array of idea objects — no other text, no markdown fences. Each idea must be specific and actionable, not generic advice. Reference specific trends you see in the data.`,
      messages: [{
        role: 'user',
        content: `Generate 3-5 content ideas for ${model.name}, who creates "${model.primary_niche}" content${secondaryText}.

Here are the top-performing posts in their niche from the last 30 days:

${postList}

Respond with a JSON array where each object has:
- "concept": specific idea description (2-3 sentences)
- "format": suggested format (POV reel, talking head, trend audio, skit, duet, etc.)
- "why_working": why this type of content is performing well right now based on the data above (1-2 sentences)
- "hook_line": suggested opening hook line for the first 3 seconds
- "source_niche": which niche this idea comes from ("${model.primary_niche}"${model.secondary_niches ? ` or one of: ${model.secondary_niches}` : ''})

Weight "${model.primary_niche}" content (70%) more than secondary niches (30%). Focus on patterns: recurring themes, hooks, formats, or topics driving high engagement.`
      }],
    });

    const text = response.content[0].text.trim();
    try {
      // Try to parse JSON, handling potential markdown fences
      const cleaned = text.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();
      const ideas = JSON.parse(cleaned);
      return Array.isArray(ideas) ? ideas.slice(0, 5) : [];
    } catch (e) {
      console.error('[AI Agent] Failed to parse Claude response:', text.slice(0, 200));
      return [];
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
