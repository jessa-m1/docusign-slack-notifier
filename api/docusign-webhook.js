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
  completed: { emoji: "✅", label: "DocuSign Completed" },
  declined:  { emoji: "❌", label: "DocuSign Declined" },
  voided:    { emoji: "🚫", label: "DocuSign Voided" },
};

// Used for intermediate signers who just signed
const SIGNED_CONFIG = { emoji: "✍️", label: "DocuSign Signed" };

// ─── Helpers ──────────────────────────────────────────────────────────────────
function cleanSubject(subject) {
  return (subject || "Unknown Document")
    .replace(/^(complete with docusign|please docusign|please sign|sign now|docusign):\s*/i, "")
    .trim();
}

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

// ─── Build notification lines ─────────────────────────────────────────────────
/**
 * Returns an array of mrkdwn strings — one per notification line.
 *
 * For 'sent' events we filter signers by their individual status:
 *   - status 'completed' → they just signed, triggering this send (emit Signed)
 *   - status 'sent'      → they just received the doc (emit Sent)
 *
 * For 'completed' / 'voided' → single envelope-level line.
 * For 'declined'             → only the signer(s) who declined.
 */
function buildLines(status, config, subject, allSigners) {
  const signerStatus = (s) => (s.status || "").toLowerCase();

  if (status === "sent") {
    const sentSigners   = allSigners.filter((s) => signerStatus(s) === "sent");
    const signedSigners = allSigners.filter((s) => signerStatus(s) === "completed");

    // If anyone is currently in "sent" state, this is a routing event — show who received the doc.
    // Ignore completed signers here to avoid duplicating the "Signed" notification.
    if (sentSigners.length > 0) {
      return sentSigners.map(
        (s) => `${config.emoji} *${config.label}* — ${subject} — ${s.name} (${s.email})`
      );
    }

    // No one in "sent" state — this is an intermediate signing event. Show who just signed.
    if (signedSigners.length > 0) {
      return signedSigners.map(
        (s) => `${SIGNED_CONFIG.emoji} *${SIGNED_CONFIG.label}* — ${subject} — ${s.name} (${s.email})`
      );
    }

    // Fallback
    return [`${config.emoji} *${config.label}* — ${subject}`];
  }

  if (status === "declined") {
    const declinedSigners = allSigners.filter((s) => signerStatus(s) === "declined");
    if (declinedSigners.length > 0) {
      return declinedSigners.map(
        (s) => `${config.emoji} *${config.label}* — ${subject} — ${s.name} (${s.email})`
      );
    }
    return [`${config.emoji} *${config.label}* — ${subject}`];
  }

  // 'completed' and 'voided' → single envelope-level message
  return [`${config.emoji} *${config.label}* — ${subject}`];
}

// ─── Main handler ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString("utf8");

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  const status = (body.status || "").toLowerCase();
  const config = STATUS_CONFIG[status];

  if (!config) {
    return res.status(200).json({ ok: true, skipped: true, status });
  }

  const subject   = cleanSubject(body.emailSubject);
  const timestamp = formatTimestamp(getTimestamp(body));
  const allSigners = body?.recipients?.signers || [];

  const lines = buildLines(status, config, subject, allSigners);

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
