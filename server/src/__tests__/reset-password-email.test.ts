import { afterEach, describe, expect, it, vi } from "vitest";
import { createSendResetPasswordEmail, renderResetPasswordEmail } from "../auth/reset-password-email.js";

const ORIGINAL_RESEND_API_KEY = process.env.RESEND_API_KEY;
const ORIGINAL_FROM = process.env.PAPERCLIP_RESET_EMAIL_FROM;

afterEach(() => {
  if (ORIGINAL_RESEND_API_KEY === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = ORIGINAL_RESEND_API_KEY;
  if (ORIGINAL_FROM === undefined) delete process.env.PAPERCLIP_RESET_EMAIL_FROM;
  else process.env.PAPERCLIP_RESET_EMAIL_FROM = ORIGINAL_FROM;
  vi.unstubAllGlobals();
});

describe("renderResetPasswordEmail", () => {
  it("includes the reset URL in both text and html bodies", () => {
    const content = renderResetPasswordEmail("https://paperclip.example.test/reset-password?token=abc");

    expect(content.text).toContain("https://paperclip.example.test/reset-password?token=abc");
    expect(content.html).toContain("https://paperclip.example.test/reset-password?token=abc");
    expect(content.subject).toBe("Reset your Paperclip password");
  });
});

describe("createSendResetPasswordEmail", () => {
  it("logs the reset link and does not throw when no provider is configured", async () => {
    delete process.env.RESEND_API_KEY;
    const warn = vi.fn();
    const error = vi.fn();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const sendResetPassword = createSendResetPasswordEmail({ warn, error });
    await expect(
      sendResetPassword({ user: { email: "user@example.test" }, url: "https://paperclip.test/reset-password?token=t", token: "t" }),
    ).resolves.toBeUndefined();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("user@example.test"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("https://paperclip.test/reset-password?token=t"));
    expect(error).not.toHaveBeenCalled();
  });

  it("sends via the Resend API when RESEND_API_KEY is configured", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.PAPERCLIP_RESET_EMAIL_FROM = "Paperclip <alerts@paperclip.test>";
    const warn = vi.fn();
    const error = vi.fn();
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" });
    vi.stubGlobal("fetch", fetchSpy);

    const sendResetPassword = createSendResetPasswordEmail({ warn, error });
    await sendResetPassword({
      user: { email: "user@example.test" },
      url: "https://paperclip.test/reset-password?token=t",
      token: "t",
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.resend.com/emails",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer re_test_key" }),
      }),
    );
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(init.body as string);
    expect(payload).toMatchObject({
      from: "Paperclip <alerts@paperclip.test>",
      to: "user@example.test",
      subject: "Reset your Paperclip password",
    });
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("logs an error (without throwing) when the Resend API rejects the send", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    const warn = vi.fn();
    const error = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 422, text: async () => "invalid from address" }));

    const sendResetPassword = createSendResetPasswordEmail({ warn, error });
    await expect(
      sendResetPassword({ user: { email: "user@example.test" }, url: "https://paperclip.test/reset-password?token=t", token: "t" }),
    ).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith(expect.stringContaining("422"));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("invalid from address"));
  });
});
