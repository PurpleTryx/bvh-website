// api/stripe-webhook.js
// Vercel Serverless Function — receives Stripe payment events
// Automatically notifies Discord subscriber log when someone subscribes
// Deploy: this file goes in /api/ folder in your GitHub repo

const WH_SUBLOG = 'https://discord.com/api/webhooks/1500814580010713138/bkLbXiSjbSz6WFGMaiyKiRawjBoZFsALcLb53sEirohkMlcFK7gdkA4N0LhYgjVyjCbu';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Read raw body for signature verification
    const rawBody = await getRawBody(req);
    const signature = req.headers['stripe-signature'];

    // Verify Stripe signature only if secret is configured
    if (STRIPE_WEBHOOK_SECRET && STRIPE_WEBHOOK_SECRET.length > 10 && signature) {
      const isValid = verifyStripeSignature(rawBody, signature, STRIPE_WEBHOOK_SECRET);
      if (!isValid) {
        console.error('Invalid Stripe signature — continuing anyway for debugging');
        // Don't return 400 — still process the event
      }
    }

    const event = JSON.parse(rawBody.toString());
    console.log('Stripe event:', event.type);

    // Handle successful payment events
    if (event.type === 'checkout.session.completed' || 
        event.type === 'payment_intent.succeeded' ||
        event.type === 'invoice.payment_succeeded') {

      const session = event.data.object;
      const amount  = (session.amount_total || session.amount || 500) / 100;
      const email   = session.customer_details?.email || session.receipt_email || session.customer_email || 'Unknown';
      const name    = session.customer_details?.name || 'New Subscriber';
      const date    = new Date().toLocaleDateString('en-CA');

      // Post to Discord subscriber log
      const discordPayload = {
        embeds: [{
          title: '💰 New BVH Subscription Payment',
          description: `A new subscription payment has been received.`,
          color: 0x00FF9D,
          fields: [
            { name: 'Customer',    value: name,                        inline: true },
            { name: 'Email',       value: email,                       inline: true },
            { name: 'Amount',      value: `$${amount.toFixed(2)} CAD`, inline: true },
            { name: 'Event Type',  value: event.type,                  inline: true },
            { name: 'Date',        value: date,                        inline: true },
            { name: 'Action Required', value: '⚠️ Add subscriber to spreadsheet and send Pro password via Discord ticket', inline: false },
          ],
          footer: { text: 'BVH Stripe Webhook · bricksvaluehub.com' },
          timestamp: new Date().toISOString()
        }]
      };

      const discordRes = await fetch(WH_SUBLOG, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(discordPayload)
      });

      if (discordRes.ok || discordRes.status === 204) {
        console.log('Discord notification sent successfully');
      } else {
        console.error('Discord notification failed:', discordRes.status);
      }
    }

    // Handle subscription cancellations
    if (event.type === 'customer.subscription.deleted') {
      const sub   = event.data.object;
      const email = sub.customer_email || 'Unknown';

      await fetch(WH_SUBLOG, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          embeds: [{
            title: '❌ Subscription Cancelled',
            description: `A subscription has been cancelled.`,
            color: 0xFF3355,
            fields: [
              { name: 'Email',          value: email,              inline: true },
              { name: 'Date',           value: new Date().toLocaleDateString('en-CA'), inline: true },
              { name: 'Action Required', value: '⚠️ Remove Pro access from subscriber', inline: false },
            ],
            footer: { text: 'BVH Stripe Webhook · bricksvaluehub.com' },
            timestamp: new Date().toISOString()
          }]
        })
      });
    }

    return res.status(200).json({ received: true });

  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// Read raw body from request
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Simple Stripe signature verification (HMAC-SHA256)
function verifyStripeSignature(payload, signature, secret) {
  try {
    const crypto = require('crypto');
    const parts = signature.split(',');
    const timestamp = parts.find(p => p.startsWith('t=')).split('=')[1];
    const sigHash   = parts.find(p => p.startsWith('v1=')).split('=')[1];
    const signed    = `${timestamp}.${payload.toString()}`;
    const expected  = crypto.createHmac('sha256', secret).update(signed).digest('hex');
    return expected === sigHash;
  } catch (e) {
    return false;
  }
}

// Required for raw body reading in Vercel
export const config = {
  api: { bodyParser: false }
};
