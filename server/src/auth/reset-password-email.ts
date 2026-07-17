const RESEND_API_URL = "https://api.resend.com/emails";
const DEFAULT_FROM = "Paperclip <no-reply@paperclip.local>";

export type ResetPasswordEmailLogger = {
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export type ResetPasswordEmailContent = {
  subject: string;
  text: string;
  html: string;
};

export function renderResetPasswordEmail(url: string): ResetPasswordEmailContent {
  return {
    subject: "Reset your Paperclip password",
    text: `Reset your Paperclip password by following this link (expires in 1 hour):\n\n${url}\n\nIf you didn't request this, you can safely ignore this email.`,
    html:
      `<p>Reset your Paperclip password by following this link (expires in 1 hour):</p>` +
      `<p><a href="${url}">${url}</a></p>` +
      `<p>If you didn't request this, you can safely ignore this email.</p>`,
  };
}

export type SendResetPasswordInput = {
  user: { email: string };
  url: string;
  token: string;
};

/**
 * Returns the callback for better-auth's `emailAndPassword.sendResetPassword`.
 * Delivers via the Resend HTTP API when RESEND_API_KEY is set; otherwise logs
 * the reset link so an admin can hand it out manually, and never throws (a
 * throw here would surface as a 500 on /api/auth/request-password-reset).
 */
export function createSendResetPasswordEmail(logger: ResetPasswordEmailLogger) {
  return async function sendResetPassword(data: SendResetPasswordInput): Promise<void> {
    const apiKey = process.env.RESEND_API_KEY?.trim();
    const from = process.env.PAPERCLIP_RESET_EMAIL_FROM?.trim() || DEFAULT_FROM;
    const { subject, text, html } = renderResetPasswordEmail(data.url);

    if (!apiKey) {
      logger.warn(
        `Password reset requested for ${data.user.email} but no email provider is configured ` +
        `(set RESEND_API_KEY to enable delivery). Reset link: ${data.url}`,
      );
      return;
    }

    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: data.user.email, subject, text, html }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.error(`Failed to send password reset email via Resend (${res.status}): ${body}`);
    }
  };
}
