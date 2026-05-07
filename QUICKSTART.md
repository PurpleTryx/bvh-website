# 🧱 BVH v2 — Quickstart (Simplified)

## What changed from the previous build
- **3 files → 1 file**: `api/bvh.js` replaces `stripe-webhook.js` + `trade-engine.js` + `intelligence-push.js`
- **10 env vars → 3 required**: only the three secrets you actually need
- **No paid Vercel Cron**: use free cron-job.org instead
- **Stripe URL compatibility**: old `/api/stripe-webhook` URL still works via redirect in vercel.json

---

## Step 1 — Upload to GitHub (2 minutes)

Upload everything in this folder to `PurpleTryx/bvh-website` (branch: `main`).

**New/changed files:**
- `api/bvh.js` ← the only new API file
- `vercel.json` ← updated (replace the old one)

Everything else (index.html, values.html, pro.html, db.json, etc.) stays the same.

---

## Step 2 — Add 3 environment variables to Vercel (3 minutes)

Vercel → your project → Settings → Environment Variables

| Name | Value | Where to find it |
|------|-------|-----------------|
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` | Stripe Dashboard → Developers → Webhooks → your endpoint → Signing secret |
| `GITHUB_TOKEN` | `ghp_...` | Already have it — paste your token |
| `DISCORD_WH_SUBLOG` | `https://discord.com/api/webhooks/...` | Already in your files as the subscriber log webhook |

**Optional (enables AI trade analysis):**

| Name | Value |
|------|-------|
| `ANTHROPIC_API_KEY` | `sk-ant-api03-...` |
| `DISCORD_WH_VALUES` | Your value list webhook (if different from SUBLOG) |

After saving, **redeploy**: Vercel → Deployments → ⋯ → Redeploy.

---

## Step 3 — Update Stripe webhook URL (1 minute)

In Stripe Dashboard → Developers → Webhooks:
- If your endpoint is still set to `/api/stripe-webhook` → **leave it** (vercel.json redirects it automatically)
- Or update it to: `https://bricksvaluehub.com/api/bvh?action=stripe`

Either works.

---

## Step 4 — Set up free automatic scheduling (5 minutes)

Go to **cron-job.org** → create free account → Add two jobs:

| Job | URL | Method | Schedule |
|-----|-----|--------|----------|
| Trade Collection | `https://bricksvaluehub.com/api/bvh?action=collect` | POST | Every 3 hours |
| Intelligence Push | `https://bricksvaluehub.com/api/bvh?action=push` | POST | Daily at 6:00 UTC |

---

## Step 5 — Verify (30 seconds)

Open in your browser:
```
https://bricksvaluehub.com/api/bvh
```

You should see:
```json
{
  "service": "BVH Unified API v2",
  "status": "online",
  "config": { "github": true, "stripe": true, "anthropic": false },
  "actions": { ... }
}
```

If `github: false` or `stripe: false`, the env var for that one isn't set yet.

---

## API Reference

| Action | Method | What it does |
|--------|--------|-------------|
| (none) | GET | Health check + config status |
| `?action=stripe` | POST | Receives Stripe payments, sends Discord embed |
| `?action=collect` | POST | Fetches trade ads, deduplicates, pushes AI updates |
| `?action=push` | POST | Rebuilds analytics, pushes db.json, sends Discord value list |
| `?action=stats` | GET | Returns analytics snapshot from current db.json |

---

## Troubleshooting

**Discord not firing after a payment?**
1. Check `https://bricksvaluehub.com/api/bvh` → is `stripe: true`?
2. If no: `STRIPE_WEBHOOK_SECRET` isn't set in Vercel, or you forgot to redeploy
3. In Stripe Dashboard → Webhooks → click your endpoint → Send test webhook → check Discord

**GitHub push failing?**
1. Check `https://bricksvaluehub.com/api/bvh` → is `github: true`?
2. If no: `GITHUB_TOKEN` isn't set in Vercel env vars
3. If yes but still failing: your token may have expired — generate a new one at github.com/settings/tokens (repo scope)

**4242 card rejected on payment link?**
Your link is live mode. Use Stripe's "Send test webhook" button instead — no real payment needed to test Discord.

---

*BVH v2 Simplified · bricksvaluehub.com*
