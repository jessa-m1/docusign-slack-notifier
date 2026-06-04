/**
 * DocuSign → Slack Notification Webhook
 *
 * Serverless function that receives DocuSign Connect events and posts
 * formatted messages to a private Slack channel.
 *
 * Compatible with: Vercel, AWS Lambda (via adapter), Netlify Functions
 *
 * ENV VARS REQUIRED:
 *   SLACK_WEBHOOK_URL     — Slack Incoming Webhook URL
 *   DOCUSIGN_HMAC_KEY     — (optional) HMAC secret for request verification
 */

const crypto = require("crypto");

// ─── Event config ─────────────────────────────────────────────────────────────

const EVENT_CONFIG = {
  "envelope-sent": { emoji: "📤", label: "DocuSign Sent" },
  "envelope-completed": { emoji: "✅", label: "DocuSign Signed" },
  "envelope-declined": { emoji: "❌", label: "DocuSign Declined" },
  "envelope-voided": { emoji: "🚫", label: "DocuSign Voided" },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Verify DocuSign HMAC signature (recommended in production).
 * DocuSign sends the signature in the X-DocuSign-Signature-1 header.
 */
function verifyHmac(rawBody, signatureHeader, hmacKey) {
  const computed = crypto
    .createHmac("sha256", hmacKey)
    .update(rawBody)
    .digest("base64");
  return crypto.timingSafeEqual(
    Buffer.from(computed),
    Buffer.from(signatureHeader)
  );
}

/**
 * Extract envelope details from DocuSign Connect JSON payload.
 * Handles both v1 (envelopeSummary) and v2 (data.envelopeSummary) shapes.
 */
function parseEnvelope(body) {
  const summary =
    body?.data?.envelopeSummary || body?.envelopeSummary || {};

  const subject = summary.emailSubject || "Unknown Document";
  const sentAt =
    summary.sentDateTime ||
    summary.createdDateTime ||
    new Date().toISOString();

  // Collect all signer recipients
  const signers = summary?.recipients?.signers || [];
  const recipients = signers.map((s) => ({
    name: s.name || "Unknown",
    email: s.email || "",
  }));

  return { subject, sentAt, recipients };
}

/**
 * Format a timestamp to something readable: "Jun 4, 2026 at 2:30 PM UTC"
 */
function formatTimestamp(isoString) {
  try {
    return new Date(isoString).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "UTC",
      timeZoneName: "short",
    });
  } catch {
    return isoString;
  }
}

/**
 * Build the Slack message payload.
 * One message block per recipient (if multiple signers on one envelope).
 */
function buildSlackPayload(eventType, envelope) {
  const config = EVENT_CONFIG[eventType];
  const timestamp = formatTimestamp(envelope.sentAt);

  const lines = envelope.recipients.map(
    (r) =>
      `${config.emoji} *${config.label}* — ${envelope.subject} — ${r.name} (${r.email})`
  );

  // Fallback if no recipients parsed
  if (lines.length === 0) {
    lines.push(
      `${config.emoji} *${config.label}* — ${envelope.subject}`
    );
  }

  return {
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: lines.join("\n"),
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `🕐 ${timestamp}`,
          },
        ],
      },
      { type: "divider" },
    ],
  };
}

/**
 * POST the payload to Slack.
 */
async function postToSlack(payload) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) throw new Error("SLACK_WEBHOOK_URL is not set");

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Slack responded ${res.status}: ${text}`);
  }
}

// ─── Main handler (Vercel / Node HTTP) ───────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  // Collect raw body for HMAC verification
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString("utf8");

  // Optional HMAC verification
  const hmacKey = process.env.DOCUSIGN_HMAC_KEY;
  if (hmacKey) {
    const sig = req.headers["x-docusign-signature-1"];
    if (!sig || !verifyHmac(rawBody, sig, hmacKey)) {
      return res.status(401).json({ error: "Invalid signature" });
    }
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  // DocuSign event name (e.g. "envelope-sent")
  const eventType = body?.event || body?.data?.event;
  if (!EVENT_CONFIG[eventType]) {
    // Unknown or unmonitored event — acknowledge and ignore
    return res.status(200).json({ ok: true, skipped: true });
  }

  const envelope = parseEnvelope(body);
  const slackPayload = buildSlackPayload(eventType, envelope);

  try {
    await postToSlack(slackPayload);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Slack post failed:", err.message);
    return res.status(500).json({ error: err.message });
  }
};

// ─── AWS Lambda adapter (uncomment if deploying to Lambda) ───────────────────
//
// const http = require("http");
// exports.handler = async (event) => {
//   const req = Object.assign(new http.IncomingMessage(null), {
//     method: event.httpMethod,
//     headers: event.headers || {},
//     [Symbol.asyncIterator]: async function* () { yield Buffer.from(event.body || ""); },
//   });
//   const results = [];
//   const res = {
//     status: (code) => ({ json: (body) => results.push({ statusCode: code, body: JSON.stringify(body) }) }),
//   };
//   await module.exports(req, res);
//   return results[0] || { statusCode: 200, body: '{"ok":true}' };
// };
