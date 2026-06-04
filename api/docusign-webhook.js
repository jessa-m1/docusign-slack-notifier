/**
 * DocuSign → Slack Notification Webhook
 * Receives DocuSign Connect (REST v2.1) events and posts to Slack.
 *
 * ENV VARS REQUIRED:
 *   SLACK_WEBHOOK_URL  — Slack Incoming Webhook URL
 */

// ─── Event config ─────────────────────────────────────────────────────────────

const STATUS_CONFIG = {
  sent:      { emoji: "📤", label: "DocuSign Sent" },
  completed: { emoji: "✅", label: "DocuSign Signed" },
  declined:  { emoji: "❌", label: "DocuSign Declined" },
  voided:    { emoji: "🚫", label: "DocuSign Voided" },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Clean up the emailSubject — strip DocuSign's auto-added prefixes like
 * "Complete with Docusign: " or "Please DocuSign: "
 */
function cleanSubject(subject) {
  return (subject || "Unknown Document")
    .replace(/^(complete with docusign|please docusign|please sign|sign now|docusign):\s*/i, "")
    .trim();
}

/**
 * Pick the most relevant timestamp for the event.
 */
function getTimestamp(body) {
  return (
    body.completedDateTime ||
    body.declinedDateTime  ||
    body.voidedDateTime    ||
    body.sentDateTime      ||
    body.statusChangedDateTime ||
    new Date().toISOString()
  );
}

/**
 * Format a timestamp: "Jun 4, 2026 at 2:30 PM UTC"
 */
function formatTimestamp(isoString) {
  try {
    return new Date(isoString).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/New_York",
      timeZoneName: "short",
    });
  } catch {
    return isoString;
  }
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

// ─── Main handler ─────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  // Read body
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString("utf8");

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  // DocuSign REST v2.1 sends status at the root level
  const status = (body.status || "").toLowerCase();
  const config = STATUS_CONFIG[status];

  if (!config) {
    // Not an event we care about — acknowledge and ignore
    return res.status(200).json({ ok: true, skipped: true, status });
  }

  // Parse envelope details (data is at root level in REST v2.1)
  const subject    = cleanSubject(body.emailSubject);
  const timestamp  = formatTimestamp(getTimestamp(body));
  const signers    = body?.recipients?.signers || [];

  // Build one line per recipient
  const lines = signers.map(
    (s) => `${config.emoji} *${config.label}* — ${subject} — ${s.name} (${s.email})`
  );

  if (lines.length === 0) {
    lines.push(`${config.emoji} *${config.label}* — ${subject}`);
  }

  const slackPayload = {
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: lines.join("\n") },
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `🕐 ${timestamp}` }],
      },
      { type: "divider" },
    ],
  };

  try {
    await postToSlack(slackPayload);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Slack post failed:", err.message);
    return res.status(500).json({ error: err.message });
  }
};
