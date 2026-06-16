/**
 * Pure cookie helpers — no Obsidian/Electron imports so they are trivially testable.
 *
 * X session auth needs exactly two cookies:
 *   - auth_token : the session bearer
 *   - ct0        : the CSRF double-submit token (must also be echoed as x-csrf-token)
 */

export interface Credentials {
  authToken: string;
  ct0: string;
}

/**
 * Parse a raw cookie string into the two credentials we care about.
 * Accepts `document.cookie`-style ("a=1; b=2; auth_token=..; ct0=..") input,
 * tolerates stray whitespace, quotes, and unrelated cookies.
 */
export function parseCookieString(raw: string): Partial<Credentials> {
  const out: Partial<Credentials> = {};
  if (!raw) return out;
  for (const part of raw.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    // strip surrounding quotes
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    // Reject values carrying control chars / separators that could break or
    // inject into the Cookie header. Real auth_token/ct0 never contain these.
    if (/[\r\n;]/.test(value)) continue;
    if (key === "auth_token" && value) out.authToken = value;
    else if (key === "ct0" && value) out.ct0 = value;
  }
  return out;
}

/** Build the `Cookie:` request header value from credentials. */
export function buildCookieHeader(creds: Credentials): string {
  return `auth_token=${creds.authToken}; ct0=${creds.ct0}`;
}

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

/** Credentials are valid only when BOTH tokens are present and non-empty. */
export function validateCredentials(creds: Partial<Credentials> | null | undefined): ValidationResult {
  if (!creds) return { valid: false, reason: "No credentials" };
  if (!creds.authToken) return { valid: false, reason: "Missing auth_token — please log in again." };
  if (!creds.ct0) return { valid: false, reason: "Missing ct0 — please log in again." };
  return { valid: true };
}
