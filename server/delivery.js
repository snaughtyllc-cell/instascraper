const fetch = require('node-fetch');
const pool = require('./db');

// ─── WhatsApp Cloud API ─────────────────────────────────────────
async function deliverWhatsApp(phone, message) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  if (!token || !phoneId) throw new Error('WHATSAPP_TOKEN and WHATSAPP_PHONE_ID not configured');

  // Clean phone number (remove spaces, dashes, ensure country code)
  const cleanPhone = phone.replace(/[\s\-()]/g, '');

  const res = await fetch(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: cleanPhone,
      type: 'text',
      text: { body: message },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`WhatsApp API error: ${res.status} — ${text}`);
  }
  return await res.json();
}

// ─── Format ideas as WhatsApp message ───────────────────────────
function formatWhatsAppMessage(modelName, ideas) {
  let msg = `🎬 *Weekly Content Ideas for ${modelName}*\n\n`;

  ideas.forEach((idea, i) => {
    msg += `*${i + 1}. ${idea.format || 'Reel'}*\n`;
    msg += `${idea.concept}\n`;
    if (idea.hook_line) msg += `🎣 Hook: _"${idea.hook_line}"_\n`;
    if (idea.why_working) msg += `📊 ${idea.why_working}\n`;
    if (idea.source_niche) msg += `🏷 Niche: ${idea.source_niche}\n`;
    if (idea.stale_warning) msg += `⚠️ ${idea.stale_warning}\n`;
    msg += '\n';
  });

  msg += `_Generated ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}_`;
  return msg;
}

// ─── Format ideas as plain text (for Sheet/Notion) ──────────────
function formatPlainIdeas(ideas) {
  return ideas.map(idea => ({
    concept: idea.concept,
    format: idea.format || '',
    why_working: idea.why_working || '',
    hook_line: idea.hook_line || '',
    niche: idea.source_niche || '',
    warning: idea.stale_warning || '',
  }));
}

// ─── Google Sheet append (via Sheets API) ───────────────────────
async function deliverGoogleSheet(sheetUrl, modelName, ideas) {
  // Extract sheet ID from URL
  const match = sheetUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (!match) throw new Error('Invalid Google Sheet URL');
  const sheetId = match[1];
  const serviceKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!serviceKey) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY not configured');

  // Get access token from service account
  const key = JSON.parse(serviceKey);
  const jwt = await getGoogleJWT(key);

  const date = new Date().toISOString().split('T')[0];
  const rows = ideas.map(idea => [
    date, modelName, idea.concept, idea.format || '', idea.why_working || '',
    idea.hook_line || '', idea.source_niche || '', idea.stale_warning || ''
  ]);

  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/A:H:append?valueInputOption=RAW`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: rows }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Sheets API error: ${res.status} — ${text}`);
  }
  return await res.json();
}

// Minimal JWT for Google service account (avoids googleapis dependency)
async function getGoogleJWT(key) {
  const crypto = require('crypto');
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  })).toString('base64url');
  const signature = crypto.createSign('RSA-SHA256').update(`${header}.${payload}`).sign(key.private_key, 'base64url');
  const jwt = `${header}.${payload}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  return data.access_token;
}

// ─── Notion page append ─────────────────────────────────────────
async function deliverNotion(pageId, modelName, ideas) {
  const notionKey = process.env.NOTION_API_KEY;
  if (!notionKey) throw new Error('NOTION_API_KEY not configured');

  const children = [
    { object: 'block', type: 'heading_2', heading_2: { rich_text: [{ text: { content: `Content Ideas — ${modelName} — ${new Date().toLocaleDateString()}` } }] } },
  ];

  for (const idea of ideas) {
    children.push({
      object: 'block', type: 'callout',
      callout: {
        icon: { emoji: '💡' },
        rich_text: [{ text: { content: `${idea.format || 'Reel'}: ${idea.concept}` } }],
      },
    });
    if (idea.hook_line) {
      children.push({ object: 'block', type: 'quote', quote: { rich_text: [{ text: { content: `Hook: "${idea.hook_line}"` } }] } });
    }
    if (idea.why_working) {
      children.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ text: { content: `📊 ${idea.why_working}` } }] } });
    }
    children.push({ object: 'block', type: 'divider', divider: {} });
  }

  const res = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${notionKey}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ children }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion API error: ${res.status} — ${text}`);
  }
  return await res.json();
}

// ─── Orchestrator: deliver a batch ──────────────────────────────
async function deliverBatch(modelId, batchId) {
  const modelResult = await pool.query('SELECT * FROM models WHERE id = $1', [modelId]);
  const model = modelResult.rows[0];
  if (!model) throw new Error(`Model ${modelId} not found`);

  const ideasResult = await pool.query(
    'SELECT * FROM idea_cards WHERE batch_id = $1 ORDER BY id',
    [batchId]
  );
  const ideas = ideasResult.rows;
  if (ideas.length === 0) return { status: 'empty', message: 'No ideas in batch' };

  let deliveryStatus = 'sent';
  let error = null;

  try {
    switch (model.delivery_method) {
      case 'whatsapp': {
        const msg = formatWhatsAppMessage(model.name, ideas);
        await deliverWhatsApp(model.delivery_contact, msg);
        break;
      }
      case 'sheet': {
        await deliverGoogleSheet(model.delivery_contact, model.name, ideas);
        break;
      }
      case 'notion': {
        await deliverNotion(model.delivery_contact, model.name, ideas);
        break;
      }
      default:
        throw new Error(`Unknown delivery method: ${model.delivery_method}`);
    }

    // Mark ideas as delivered
    const now = new Date().toISOString();
    await pool.query("UPDATE idea_cards SET status = 'delivered', delivered_at = $1 WHERE batch_id = $2", [now, batchId]);
  } catch (err) {
    deliveryStatus = 'failed';
    error = err.message;
    console.error(`[Delivery] Failed for ${model.name}:`, err.message);
  }

  // Log delivery
  await pool.query(
    'INSERT INTO idea_delivery_log (model_id, batch_id, delivery_method, delivery_status, error) VALUES ($1, $2, $3, $4, $5)',
    [modelId, batchId, model.delivery_method, deliveryStatus, error]
  );

  return { status: deliveryStatus, error };
}

module.exports = { deliverBatch, deliverWhatsApp, formatWhatsAppMessage };
