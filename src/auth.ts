import { eq } from "drizzle-orm";
import type { DB } from "./db/client";
import { apiKeys } from "./db/schema";

export type AuthEnv = {
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  ALLOWED_EMAILS?: string;
};

export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;

// Allowlist-gated signup. Empty/unset ALLOWED_EMAILS => deny everyone (fail closed).
export function isAllowedEmail(env: AuthEnv, email: string): boolean {
  const list = (env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(email.toLowerCase());
}

export function generateOtp(): string {
  const n = (crypto.getRandomValues(new Uint32Array(1))[0] % 900000) + 100000;
  return String(n);
}

export function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `at_${b64}`;
}

export async function sha256Hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sendOtpEmail(env: AuthEnv, email: string, code: string): Promise<void> {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY not set");
  const from = env.RESEND_FROM ?? "Fleet <fleet@copaciu.com>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: email,
      subject: `Your Fleet sign-in code: ${code}`,
      text: `Your Fleet verification code is ${code}. It expires in 10 minutes.`,
      html: `<div style="font-family:system-ui,sans-serif">
        <p>Your Fleet verification code is:</p>
        <p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p>
        <p style="color:#666">It expires in 10 minutes.</p>
      </div>`,
    }),
  });
  if (!res.ok) throw new Error(`resend ${res.status} ${await res.text()}`);
}

// Resolve a bearer API key to its account email, or null.
export async function resolveApiKey(db: DB, key: string): Promise<string | null> {
  if (!key) return null;
  const hash = await sha256Hex(key);
  const rows = await db.select({ email: apiKeys.email }).from(apiKeys).where(eq(apiKeys.keyHash, hash)).limit(1);
  return rows[0]?.email ?? null;
}
