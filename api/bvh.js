// ============================================================
// BricksValueHub — Unified API  (api/bvh.js)
// ============================================================
// ONE file replaces: stripe-webhook.js + trade-engine.js + intelligence-push.js
//
// Endpoints (all via /api/bvh):
//   GET  /api/bvh                     → health check + action list
//   POST /api/bvh?action=stripe       → Stripe webhook receiver
//   POST /api/bvh?action=collect      → fetch + deduplicate + push trade data
//   POST /api/bvh?action=push         → rebuild analytics + push db.json + Discord value list
//   GET  /api/bvh?action=stats        → analytics snapshot
//
// Required env vars (just 3):
//   STRIPE_WEBHOOK_SECRET   → from Stripe Dashboard → Webhooks → Signing secret
//   GITHUB_TOKEN            → your GitHub personal access token (repo scope)
//   DISCORD_WH_SUBLOG       → subscriber log Discord webhook URL
//
// Optional env vars:
//   ANTHROPIC_API_KEY       → enables AI-powered trade analysis
//   DISCORD_WH_VALUES       → value list channel webhook (falls back to SUBLOG if missing)
// ============================================================

// ── HARDCODED CONFIG (your repo never changes) ────────────────
const GH_OWNER  = 'PurpleTryx';
const GH_REPO   = 'bvh-website';
const GH_BRANCH = 'main';

// ── SECRETS FROM ENV ──────────────────────────────────────────
const STRIPE_SECRET  = process.env.STRIPE_WEBHOOK_SECRET || '';
const GH_TOKEN       = process.env.GITHUB_TOKEN          || '';
const WH_SUBLOG      = process.env.DISCORD_WH_SUBLOG     || 'https://discord.com/api/webhooks/1500814580010713138/bkLbXiSjbSz6WFGMaiyKiRawjBoZFsALcLb53sEirohkMlcFK7gdkA4N0LhYgjVyjCbu';
const WH_VALUES      = process.env.DISCORD_WH_VALUES     || WH_SUBLOG;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY     || '';

// ── TRADE SOURCE ──────────────────────────────────────────────
const TRADE_URL = 'https://sailor-piece.vaultedvaluesx.com/trade-ads';
const PROXIES   = [
  'https://api.allorigins.win/raw?url=',
  'https://api.codetabs.com/v1/proxy?quest='
];

// ── CATEGORY EMOJI MAP ────────────────────────────────────────
const CAT_EMOJI = { Sets:'👘', Relic:'🗿', Misc:'🎲', Crafting:'⚒️', Value:'💎', Ascension:'⭐', Gamepass:'🎮', Chests:'📦', Boss:'👹' };

// ══════════════════════════════════════════════════════════════
// MAIN HANDLER
// ══════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  const id     = `bvh-${Date.now().toString(36)}`;
  const action = req.query.action || (req.method === 'POST' && !req.query.action ? 'stripe' : 'health');

  log(id, `${req.method} action=${action}`);

  // Health check / docs
  if (req.method === 'GET' && action === 'health') {
    return res.status(200).json({
      service: 'BVH Unified API v2',
      status: 'online',
      config: { github: !!GH_TOKEN, stripe: !!STRIPE_SECRET, anthropic: !!ANTHROPIC_KEY },
      actions: {
        'POST ?action=stripe':  'Stripe webhook receiver',
        'POST ?action=collect': 'Collect + push trade data',
        'POST ?action=push':    'Intelligence push (analytics + Discord value list)',
        'GET  ?action=stats':   'Analytics snapshot'
      }
    });
  }

  try {
    if (action === 'stripe')  return await handleStripe(req, res, id);
    if (action === 'collect') return await handleCollect(req, res, id);
    if (action === 'push')    return await handlePush(req, res, id);
    if (action === 'stats')   return await handleStats(req, res, id);
    if (action === 'analyze') return await handleAnalyze(req, res, id);
    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    log(id, `CRASH: ${err.message}`, 'error');
    await discord(WH_SUBLOG, errorEmbed(`BVH API crashed on action=${action}`, err.message, id));
    return res.status(500).json({ error: err.message, id });
  }
}

// ══════════════════════════════════════════════════════════════
// ACTION 1 — STRIPE WEBHOOK
// ══════════════════════════════════════════════════════════════
async function handleStripe(req, res, id) {
  if (req.method !== 'POST') return res.status(405).end();

  const raw = await readBody(req);
  const sig = req.headers['stripe-signature'];

  // Signature verification
  if (STRIPE_SECRET && sig) {
    if (!verifySig(raw, sig, STRIPE_SECRET)) {
      log(id, 'Signature mismatch — rejecting', 'warn');
      return res.status(400).json({ error: 'Bad signature' });
    }
  } else {
    log(id, 'Sig check skipped — set STRIPE_WEBHOOK_SECRET in Vercel', 'warn');
  }

  let event;
  try { event = JSON.parse(raw.toString()); }
  catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  const obj  = event.data?.object || {};
  const date = new Date().toLocaleDateString('en-CA');

  log(id, `Stripe event: ${event.type}`);

  switch (event.type) {
    case 'checkout.session.completed':
    case 'invoice.payment_succeeded':
    case 'payment_intent.succeeded': {
      const renewal = event.type === 'invoice.payment_succeeded'
        && (obj.billing_reason === 'subscription_cycle' || obj.billing_reason === 'subscription_update');
      const amount  = ((obj.amount_total ?? obj.amount_paid ?? obj.amount ?? 500) / 100).toFixed(2);
      const email   = obj.customer_details?.email ?? obj.customer_email ?? 'Unknown';
      const name    = obj.customer_details?.name  ?? 'New Subscriber';
      const subId   = obj.subscription ?? obj.id ?? 'N/A';

      await discord(WH_SUBLOG, {
        embeds: [{
          title:       renewal ? '🔄 Subscription Renewed' : '💰 New BVH Pro Subscriber!',
          description: renewal
            ? 'Monthly renewal processed — update expiry date in spreadsheet.'
            : 'New subscriber! Add to spreadsheet and send Pro password via Discord ticket.',
          color: renewal ? 0x3D8BFF : 0x00D4AA,
          fields: [
            { name: '👤 Name',    value: name,                    inline: true },
            { name: '📧 Email',   value: email,                   inline: true },
            { name: '💵 Amount',  value: `$${amount} CAD`,        inline: true },
            { name: '🆔 Sub ID',  value: subId,                   inline: true },
            { name: '📅 Date',    value: date,                    inline: true },
            ...(!renewal ? [{ name: '✅ Action', value: '1. Add to spreadsheet\n2. Send Pro password via Discord\n3. Grant Pro role', inline: false }] : [])
          ],
          footer:    { text: `BVH Stripe · ${id}` },
          timestamp: new Date().toISOString()
        }]
      });
      break;
    }

    case 'customer.subscription.deleted': {
      const email  = obj.customer_email ?? 'Unknown';
      const reason = obj.cancellation_details?.reason ?? 'Not specified';
      await discord(WH_SUBLOG, {
        embeds: [{
          title:       '❌ Subscription Cancelled',
          description: 'Remove Pro access from this subscriber.',
          color:       0xFF3355,
          fields: [
            { name: '📧 Email',   value: email,   inline: true },
            { name: '📋 Reason', value: reason,  inline: true },
            { name: '📅 Date',   value: date,    inline: true },
            { name: '⚠️ Action', value: '1. Mark EXPIRED in spreadsheet\n2. Remove Pro Discord role', inline: false }
          ],
          footer: { text: `BVH Stripe · ${id}` }, timestamp: new Date().toISOString()
        }]
      });
      break;
    }

    case 'invoice.payment_failed': {
      const email   = obj.customer_email ?? 'Unknown';
      const amount  = ((obj.amount_due ?? 500) / 100).toFixed(2);
      const attempt = obj.attempt_count ?? 1;
      await discord(WH_SUBLOG, {
        embeds: [{
          title: '💳 Payment Failed',
          color: 0xF0B429,
          fields: [
            { name: '📧 Email',    value: email,           inline: true },
            { name: '💵 Amount',   value: `$${amount}`,    inline: true },
            { name: '🔁 Attempt', value: `#${attempt}`,   inline: true },
            { name: '📅 Date',    value: date,             inline: true },
            { name: 'ℹ️ Note',   value: attempt >= 3 ? '⚠️ 3+ failures — check in with this subscriber' : 'Stripe will retry automatically', inline: false }
          ],
          footer: { text: `BVH Stripe · ${id}` }, timestamp: new Date().toISOString()
        }]
      });
      break;
    }

    case 'charge.dispute.created': {
      await discord(WH_SUBLOG, {
        embeds: [{
          title: '🚨 CHARGEBACK — Respond in Stripe within 7 days',
          color: 0xFF0000,
          fields: [
            { name: '💵 Amount', value: `$${((obj.amount ?? 500)/100).toFixed(2)}`, inline: true },
            { name: '📋 Reason', value: obj.reason ?? 'Unknown', inline: true }
          ],
          footer: { text: `BVH Stripe · ${id}` }, timestamp: new Date().toISOString()
        }]
      });
      break;
    }

    default:
      log(id, `Unhandled event: ${event.type}`);
  }

  return res.status(200).json({ received: true, id, type: event.type });
}

// ══════════════════════════════════════════════════════════════
// ACTION 2 — TRADE COLLECT
// ══════════════════════════════════════════════════════════════
async function handleCollect(req, res, id) {
  log(id, 'Starting trade collection');

  // 1. Fetch trade ads
  const rawTrades = await fetchTrades(id);
  if (!rawTrades.length) {
    return res.status(200).json({ success: true, message: 'No trades fetched — source may be down', collected: 0 });
  }
  log(id, `Fetched ${rawTrades.length} raw trades`);

  // 2. Deduplicate (per-user: same user + same trade = skip)
  const { unique, dupeCount } = dedupe(rawTrades);
  log(id, `Unique: ${unique.length}, Dupes skipped: ${dupeCount}`);

  // 3. Filter low-quality trades
  const clean = unique.filter(t => scoreOk(t));
  log(id, `Clean trades after scoring: ${clean.length}`);

  // 4. If we have Anthropic key, run AI analysis + push
  if (ANTHROPIC_KEY && clean.length > 0) {
    log(id, 'Running AI analysis...');
    const { updated, error } = await analyzeAndPush(clean.map(t => t.text).join('\n'), id);
    if (error) {
      await discord(WH_SUBLOG, errorEmbed('Trade collection: AI analysis failed', error, id));
      return res.status(200).json({ success: true, collected: clean.length, aiError: error });
    }
    return res.status(200).json({ success: true, collected: clean.length, dupes: dupeCount, itemsUpdated: updated });
  }

  // 5. No AI key — just report what we collected
  return res.status(200).json({ success: true, collected: clean.length, dupes: dupeCount, note: 'Set ANTHROPIC_API_KEY to enable auto-push' });
}

// ── Fetch from trade source via proxies ───────────────────────
async function fetchTrades(id) {
  for (const proxy of PROXIES) {
    try {
      const res = await fetch(proxy + encodeURIComponent(TRADE_URL), {
        signal: AbortSignal.timeout(12000),
        headers: { 'User-Agent': 'BVH/2.0' }
      });
      if (!res.ok) continue;
      const html   = await res.text();
      const trades = parseTrades(html);
      if (trades.length) { log(id, `Fetched via ${proxy.slice(0,30)}...`); return trades; }
    } catch (e) { log(id, `Proxy error: ${e.message}`, 'warn'); }
  }
  return [];
}

// ── Parse HTML into trade objects ─────────────────────────────
function parseTrades(html) {
  const trades = [];
  // Try structured blocks first
  const blockRe = /<div[^>]*class="[^"]*trade[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  let m;
  while ((m = blockRe.exec(html)) !== null) {
    const userM = /data-user[^=]*="([^"]+)"/i.exec(m[1]);
    const text  = m[1].replace(/<[^>]+>/g, ' ').trim();
    if (text.length > 8) trades.push({ userId: userM?.[1] ?? 'anon', text });
  }
  // Fallback: line-by-line
  if (!trades.length) {
    html.split('\n').forEach((line, i) => {
      const t = line.replace(/<[^>]+>/g, '').trim();
      if (t.length > 8 && (t.includes('->') || t.includes(' for ') || t.includes(':')))
        trades.push({ userId: `line${i}`, text: t });
    });
  }
  return trades;
}

// ── Per-user deduplication ────────────────────────────────────
// Rule: same user + same trade text = skip. Different users = keep both.
function dedupe(trades) {
  const seen = new Set();
  const unique = [];
  let dupeCount = 0;
  for (const t of trades) {
    const norm = t.text.toLowerCase().replace(/\s+/g, ' ').trim();
    const key  = `${t.userId}::${norm}`;
    if (seen.has(key)) { dupeCount++; continue; }
    seen.add(key);
    unique.push({ ...t, norm });
  }
  return { unique, dupeCount };
}

// ── Simple quality score — reject obvious spam ────────────────
function scoreOk(t) {
  const n = t.norm || t.text.toLowerCase();
  if (n.length < 10) return false;
  if (/1\s*crr|make.?an.?offer|mao|obo|free|giveaway|scam/.test(n)) return false;
  if (!n.match(/->|for |trading/)) return false;
  return true;
}

// ── AI analysis + GitHub push ─────────────────────────────────
async function analyzeAndPush(tradeText, id) {
  // Fetch current db
  const { data: db, sha } = await ghGet('db.json');
  if (!db) return { error: 'Could not fetch db.json' };

  const itemNames = db.items.map(i => i.name).join(', ');
  const prompt = `You are a Sailor Piece (Roblox) trading market analyst.
Extract REAL CRR prices from these Discord trade messages.
Known items: ${itemNames}
Skip placeholder prices (1 CRR, "make offer", MAO, OBO).
Only include prices with confidence >= 0.6.
Return ONLY JSON: {"updates":[{"name":"Item Name","crr":12345}]}

Trades:
${tradeText}`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 800, messages: [{ role: 'user', content: prompt }] })
    });
    const aiData  = await r.json();
    const text    = aiData.content?.[0]?.text || '{}';
    const updates = JSON.parse(text.replace(/```json|```/g, '').trim()).updates || [];

    let count = 0;
    for (const u of updates) {
      const item = db.items.find(i => i.name.toLowerCase().includes(u.name.toLowerCase()) || u.name.toLowerCase().includes(i.name.toLowerCase().split(' ')[0]));
      if (item && u.crr > 0) { item.crr = Math.round(u.crr); count++; }
    }
    if (!count) return { updated: 0 };

    db.updated = new Date().toISOString().split('T')[0];
    db.version = Math.round(((parseFloat(db.version) || 1) + 0.001) * 1000) / 1000;
    await ghPut('db.json', db, sha, `[BVH Auto] Trade update ${db.updated}`);
    log(id, `AI updated ${count} items`);
    return { updated: count };
  } catch (err) {
    return { error: err.message };
  }
}

// ══════════════════════════════════════════════════════════════
// ACTION 3 — INTELLIGENCE PUSH
// ══════════════════════════════════════════════════════════════
async function handlePush(req, res, id) {
  log(id, 'Starting intelligence push');

  // Fetch db
  const { data: db, sha } = await ghGet('db.json');
  if (!db) throw new Error('Could not fetch db.json');

  const snapshot = JSON.stringify(db); // rollback snapshot

  // Compute analytics
  const analytics = computeAnalytics(db.items);

  // Add refresh timestamp + analytics to db
  db.version  = Math.round(((parseFloat(db.version) || 1) + 0.1) * 10) / 10;
  db.updated  = new Date().toISOString().split('T')[0];
  db.lastPush = new Date().toISOString();
  db.analytics = analytics;

  // Integrity check
  if (!db.items?.length || db.items.length < JSON.parse(snapshot).items.length * 0.9)
    throw new Error(`Integrity fail: item count suspicious`);

  // Push to GitHub
  const pushed = await ghPut('db.json', db, sha, `[BVH Auto] Intelligence push ${db.updated}`);
  if (!pushed) {
    // Rollback
    const { sha: freshSha } = await ghGet('db.json');
    await ghPut('db.json', JSON.parse(snapshot), freshSha, '[BVH ROLLBACK] Reverting failed push');
    throw new Error('GitHub push failed — rolled back');
  }

  // Send Discord value list
  await sendValueList(db, analytics);

  // Notify success
  await discord(WH_SUBLOG, {
    embeds: [{
      title: '✅ Intelligence Push Complete',
      color: 0x00D4AA,
      fields: [
        { name: '📊 Items', value: String(db.items.length), inline: true },
        { name: '🔢 Version', value: String(db.version), inline: true },
        { name: '📈 Trend', value: analytics.trend, inline: true },
        { name: '📅 Date', value: db.updated, inline: true }
      ],
      footer: { text: `BVH · ${id}` }, timestamp: new Date().toISOString()
    }]
  });

  log(id, `Push complete — ${db.items.length} items`);
  return res.status(200).json({ success: true, items: db.items.length, version: db.version, analytics });
}

// ── Analytics computation ─────────────────────────────────────
function computeAnalytics(items) {
  const byDemand   = {}, byCategory = {};
  let totalVal = 0;
  for (const i of items) {
    const d = (i.demand || 'Unknown').split(' ')[0];
    byDemand[d]         = (byDemand[d]   || 0) + 1;
    byCategory[i.category] = (byCategory[i.category] || 0) + 1;
    totalVal += i.crr || 0;
  }
  const high = (byDemand.High || 0) + (byDemand.Very || 0);
  const low  = (byDemand.Low  || 0) + (byDemand.Dead || 0);
  return {
    totalItems: items.length,
    avgCrr: items.length ? Math.round(totalVal / items.length) : 0,
    trend: high > low * 2 ? 'Bullish 📈' : low > high * 2 ? 'Bearish 📉' : 'Stable ➡️',
    byDemand, byCategory,
    topItems: [...items].sort((a, b) => b.crr - a.crr).slice(0, 5).map(i => ({ name: i.name, crr: i.crr }))
  };
}

// ── Discord value list sender ─────────────────────────────────
async function sendValueList(db, analytics) {
  const date  = db.updated;
  const items = db.items;

  await discord(WH_VALUES, {
    content: `## 🧱 Bricks Value Hub — Value List\n**${date}** · **${items.length} items** · v${db.version}\n🟢 High  🟡 Mid  🔴 Low  ⚫ Dead  ⚡ Unstable\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
  });
  await sleep(700);

  // Group by category
  const cats = {};
  for (const i of items) { (cats[i.category] = cats[i.category] || []).push(i); }

  for (const [cat, catItems] of Object.entries(cats)) {
    const lines = catItems.sort((a, b) => b.crr - a.crr).map(item => {
      const d   = item.demand || '';
      const dot = d.startsWith('High') ? '🟢' : d.startsWith('Mod') || d.startsWith('Med') ? '🟡' : d.startsWith('Low') ? '🔴' : '⚫';
      return `${dot} **${item.name}** — ${fmtCrr(item.crr)}${item.stability === 'Unstable' ? ' ⚡' : ''}`;
    }).join('\n');

    await discord(WH_VALUES, {
      embeds: [{ color: 0x4F9EFF, fields: [{ name: `${CAT_EMOJI[cat] || '📌'} ${cat} (${catItems.length})`, value: lines.slice(0, 1024) || '—', inline: false }] }]
    });
    await sleep(700);
  }

  await discord(WH_VALUES, {
    content: `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📈 Trend: ${analytics.trend}  ·  Full list: **bricksvaluehub.com/values.html**`
  });
}

// ══════════════════════════════════════════════════════════════
// ACTION 4 — STATS
// ══════════════════════════════════════════════════════════════
async function handleStats(req, res, id) {
  const { data: db } = await ghGet('db.json');
  if (!db) return res.status(500).json({ error: 'Could not fetch db.json' });
  const analytics = computeAnalytics(db.items);
  return res.status(200).json({ ...analytics, lastUpdated: db.updated, version: db.version });
}

// ══════════════════════════════════════════════════════════════
// ACTION 5 — AI ANALYZE PROXY
// Receives trade text from Trade Intelligence browser tool,
// calls Anthropic server-side (bypasses CORS), returns suggestions.
// ══════════════════════════════════════════════════════════════
async function handleAnalyze(req, res, id) {
  // CORS headers — allow the browser tool to call this endpoint
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  if (!ANTHROPIC_KEY) {
    return res.status(400).json({ error: 'ANTHROPIC_API_KEY not set in Vercel env vars. Add it in Vercel → Settings → Environment Variables.' });
  }

  let body;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw.toString());
  } catch { return res.status(400).json({ error: 'Invalid JSON body' }); }

  const tradeText = (body.trades || '').trim();
  const itemNames = body.itemNames || '';
  const pushAfter = body.push === true;

  if (!tradeText) return res.status(400).json({ error: 'No trade text provided' });

  log(id, `Analyze: ${tradeText.split('\n').length} lines, push=${pushAfter}`);

  const prompt = `You are a Sailor Piece (Roblox) trading market analyst.
Extract REAL CRR prices from these Discord trade messages.
Known items: ${itemNames}
Rules:
- Skip placeholder prices: "1 CRR", "make offer", MAO, OBO, free, giveaway
- Only include prices you are confident about (confidence >= 0.6)
- Match item names to the known items list (fuzzy match OK)
Return ONLY valid JSON, no explanation:
{"updates":[{"name":"Item Name","crr":12345,"confidence":0.85}]}

Trade messages:
${tradeText}`;

  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1000, messages: [{ role: 'user', content: prompt }] })
    });

    const aiData = await aiRes.json();
    if (aiData.error) return res.status(500).json({ error: `AI error: ${aiData.error.message}` });

    const text    = aiData.content?.[0]?.text || '{}';
    const updates = JSON.parse(text.replace(/```json|```/g,'').trim()).updates || [];
    log(id, `AI returned ${updates.length} updates`);

    // Optional: push to GitHub immediately
    if (pushAfter && updates.length > 0 && GH_TOKEN) {
      const { data: db, sha } = await ghGet('db.json');
      if (db) {
        let count = 0;
        for (const u of updates) {
          const item = db.items.find(i => i.name.toLowerCase() === u.name.toLowerCase() || i.name.toLowerCase().includes(u.name.toLowerCase()));
          if (item && u.crr > 0) { item.crr = Math.round(u.crr); count++; }
        }
        if (count > 0) {
          db.updated = new Date().toISOString().split('T')[0];
          db.version = Math.round(((parseFloat(db.version)||1)+0.001)*1000)/1000;
          await ghPut('db.json', db, sha, `[BVH] Trade update ${db.updated}`);
          log(id, `Pushed ${count} items to GitHub`);
        }
      }
    }

    return res.status(200).json({ success: true, updates, count: updates.length });

  } catch (err) {
    log(id, `Analyze error: ${err.message}`, 'error');
    return res.status(500).json({ error: err.message });
  }
}

// ══════════════════════════════════════════════════════════════
// SHARED UTILITIES
// ══════════════════════════════════════════════════════════════

// GitHub GET ──────────────────────────────────────────────────
async function ghGet(path) {
  try {
    const r = await fetch(
      `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${path}?ref=${GH_BRANCH}&t=${Date.now()}`,
      { headers: { Authorization: `token ${GH_TOKEN}`, Accept: 'application/vnd.github.v3+json' } }
    );
    if (!r.ok) return { data: null, sha: null };
    const meta = await r.json();
    return { data: JSON.parse(Buffer.from(meta.content, 'base64').toString()), sha: meta.sha };
  } catch { return { data: null, sha: null }; }
}

// GitHub PUT ──────────────────────────────────────────────────
async function ghPut(path, data, sha, message) {
  try {
    // Always fetch latest SHA to prevent conflicts
    const { sha: latestSha } = await ghGet(path);
    const r = await fetch(
      `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${path}`,
      {
        method: 'PUT',
        headers: { Authorization: `token ${GH_TOKEN}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, content: Buffer.from(JSON.stringify(data, null, 2)).toString('base64'), sha: latestSha || sha, branch: GH_BRANCH })
      }
    );
    return r.ok;
  } catch { return false; }
}

// Discord notify with retry ───────────────────────────────────
async function discord(url, payload, retries = 3) {
  for (let i = 1; i <= retries; i++) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (r.ok || r.status === 204) return true;
      if (r.status === 429) { const d = await r.json().catch(() => ({})); await sleep((d.retry_after || 1) * 1000); continue; }
    } catch (e) { if (i === retries) console.error(`[discord] ${e.message}`); }
    if (i < retries) await sleep(1500 * i);
  }
  return false;
}

// Stripe signature verification ───────────────────────────────
function verifySig(raw, header, secret) {
  try {
    const crypto = require('crypto');
    const parts  = Object.fromEntries(header.split(',').map(p => p.split('=')));
    if (!parts.t || !parts.v1) return false;
    const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${raw}`).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(parts.v1, 'hex'));
  } catch { return false; }
}

// Raw body reader ─────────────────────────────────────────────
function readBody(req) {
  return new Promise((res, rej) => {
    const chunks = [];
    req.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end',  () => res(Buffer.concat(chunks)));
    req.on('error', rej);
  });
}

// Error embed helper ──────────────────────────────────────────
function errorEmbed(title, msg, id) {
  return { embeds: [{ title: `🔴 ${title}`, description: `\`${msg}\``, color: 0xFF3355, footer: { text: `BVH · ${id}` }, timestamp: new Date().toISOString() }] };
}

// Format CRR ──────────────────────────────────────────────────
function fmtCrr(n) {
  if (!n) return '—';
  if (n >= 1e6)  return (n/1e6).toFixed(1)  + 'M';
  if (n >= 1000) return (n/1000).toFixed(0) + 'K';
  if (n < 1)     return n.toFixed(3);
  return String(n);
}

// Logger ──────────────────────────────────────────────────────
function log(id, msg, level = 'info') {
  console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](`[${id}] ${msg}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Required for Stripe raw body access in Vercel
export const config = { api: { bodyParser: false } };
