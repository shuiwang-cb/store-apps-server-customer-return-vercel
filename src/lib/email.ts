/**
 * Transactional email through Resend's HTTP API. Without RESEND_API_KEY the
 * message is logged instead (local development). Sending never throws: the
 * caller records the outcome, and a failed email never fails the action.
 */
import { env } from "./env";

export type EmailOutcome = "sent" | "failed" | "skipped_no_address" | "logged";

export async function sendEmail(input: {
  to: string;
  subject: string;
  text: string;
}): Promise<EmailOutcome> {
  if (!input.to) return "skipped_no_address";
  const apiKey = env.resendApiKey();
  if (!apiKey) {
    console.info(`[returns] email (not sent — no RESEND_API_KEY): ${input.subject}`);
    return "logged";
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: env.emailFrom(),
        to: [input.to],
        subject: input.subject,
        text: input.text,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`[returns] email failed: ${res.status}`);
      return "failed";
    }
    return "sent";
  } catch (error) {
    console.error("[returns] email failed", error);
    return "failed";
  }
}
