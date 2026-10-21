import nodemailer from "nodemailer";

export function createMagicLinkEmailSender(config = {}) {
  const fromEmail = String(config.fromEmail || "").trim();
  const replyToEmail = String(config.replyToEmail || "").trim();
  const subject = String(config.subject || "Terapixel Games Magic Link").trim();
  const smtpHost = String(config.smtpHost || "").trim();
  const smtpPort = Number.isFinite(Number(config.smtpPort))
    ? Math.max(1, Math.floor(Number(config.smtpPort)))
    : 587;
  const smtpUser = String(config.smtpUser || "").trim();
  const smtpPass = String(config.smtpPass || "").trim();
  const requireTls = normalizeBool(config.smtpRequireTls, true);
  const secure = normalizeBool(config.smtpSecure, false);
  const senderName = String(config.senderName || "Terapixel Games").trim();
  const enabled = Boolean(fromEmail && smtpHost && (smtpPass || !smtpUser));
  const transporter = enabled
    ? nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure,
        requireTLS: requireTls,
        auth: smtpUser ? { user: smtpUser, pass: smtpPass } : undefined
      })
    : null;

  return {
    enabled,
    sendMagicLink: async ({ email, linkUrl, expiresAt, requestId }) => {
      const to = String(email || "").trim().toLowerCase();
      if (!to) {
        throw new Error("email is required");
      }
      if (!linkUrl) {
        throw new Error("linkUrl is required");
      }
      if (!enabled || !transporter) {
        // Safe fallback in non-prod config.
        return {
          accepted: true,
          mocked: true,
          requestId: requestId || "",
          preview: { to, linkUrl, expiresAt }
        };
      }
      const from = senderName ? `"${senderName}" <${fromEmail}>` : fromEmail;
      const text = buildTextBody(linkUrl, expiresAt);
      const html = buildHtmlBody(linkUrl, expiresAt);
      const info = await transporter.sendMail({
        from,
        to,
        replyTo: replyToEmail || undefined,
        subject,
        text,
        html
      });
      return {
        accepted: true,
        mocked: false,
        messageId: String(info.messageId || ""),
        response: String(info.response || "")
      };
    }
  };
}

function buildTextBody(linkUrl, expiresAt) {
  const expires = expiresAt > 0 ? `This link expires at unix ${expiresAt}.` : "";
  return [
    "Your Terapixel Games sign-in link:",
    linkUrl,
    "",
    expires,
    "If you did not request this, you can ignore this email."
  ]
    .filter(Boolean)
    .join("\n");
}

function buildHtmlBody(linkUrl, expiresAt) {
  const expires = expiresAt > 0 ? `<p>This link expires at unix <strong>${expiresAt}</strong>.</p>` : "";
  return `<!doctype html>
<html>
  <body style="font-family:Arial,sans-serif;background:#f5f7fb;padding:24px;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px;border:1px solid #d9e0ef;">
      <h2 style="margin:0 0 12px;color:#1b2a4a;">Terapixel Games Magic Link</h2>
      <p style="margin:0 0 16px;color:#2c3e66;">Use this secure link to sign in:</p>
      <p style="margin:0 0 16px;"><a href="${escapeHtml(linkUrl)}" style="display:inline-block;background:#2f66ff;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;">Sign In</a></p>
      <p style="margin:0 0 16px;color:#506089;word-break:break-all;">${escapeHtml(linkUrl)}</p>
      ${expires}
      <p style="margin:16px 0 0;color:#6f7e9f;">If you did not request this, you can ignore this email.</p>
    </div>
  </body>
</html>`;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeBool(value, fallback) {
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(normalized);
}
