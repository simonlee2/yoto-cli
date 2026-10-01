import { z } from "zod";
import { boundedText } from "./security";

export const YOTO_SCOPES = "user:content:view offline_access";
export const tokenSchema = z.object({
  access_token: z.string().min(1), refresh_token: z.string().min(1),
  expires_in: z.number().positive().max(31_536_000).optional(),
  token_type: z.string().refine(v => v.toLowerCase() === "bearer").optional(),
  scope: z.string().optional()
});
export type Tokens = { accessToken: string; refreshToken: string; expiresAt: number; scopes?: string[] };

type TokenFailure = "network" | "http" | "body" | "json" | "schema" | "permission" | "expiry";
const OAUTH_ERRORS = ["invalid_request", "invalid_client", "invalid_grant", "unauthorized_client", "unsupported_grant_type", "invalid_scope", "access_denied", "server_error", "temporarily_unavailable"] as const;
const TOKEN_FIELDS = ["access_token", "refresh_token", "expires_in", "token_type", "scope"] as const;

/** Contains only bounded categories, never upstream text or token values. */
export class TokenExchangeError extends Error {
  readonly diagnostic: string;
  constructor(kind: TokenFailure, status?: number, detail?: string) {
    const safeStatus = status && Number.isInteger(status) && status >= 100 && status <= 599 ? ` http-${status}` : "";
    const safeDetail = detail && ([...OAUTH_ERRORS, ...TOKEN_FIELDS] as readonly string[]).includes(detail) ? ` ${detail}` : "";
    const diagnostic = `${kind}${safeStatus}${safeDetail}`;
    super(`Yoto token exchange: ${diagnostic}`);
    this.diagnostic = diagnostic;
  }
}

export async function exchangeTokens(body: Record<string, string>): Promise<Tokens> {
  // Workers rejects redirect:"error" before I/O. Never follow token-bearing redirects.
  // Manual mode exposes 3xx responses, which the non-OK check below rejects.
  let response: Response;
  try {
    response = await fetch("https://login.yotoplay.com/oauth/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body), signal: AbortSignal.timeout(15_000), redirect: "manual"
    });
  } catch { throw new TokenExchangeError("network"); }
  let raw: unknown;
  let text: string;
  try {
    if (!response.body) throw new Error();
    text = await boundedText(response.body, 64_000);
  } catch { throw new TokenExchangeError(response.ok ? "body" : "http", response.status); }
  try { raw = JSON.parse(text); }
  catch { throw new TokenExchangeError(response.ok ? "json" : "http", response.status); }
  if (!response.ok) {
    const code = typeof raw === "object" && raw !== null && "error" in raw && typeof raw.error === "string" ? raw.error : undefined;
    throw new TokenExchangeError("http", response.status, code);
  }
  const parsed = tokenSchema.safeParse(raw);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    throw new TokenExchangeError("schema", response.status, typeof field === "string" && (TOKEN_FIELDS as readonly string[]).includes(field) ? field : undefined);
  }
  const token = parsed.data;
  if (token.scope && !token.scope.split(" ").some(scope => ["user:content:view", "user:content:manage"].includes(scope))) throw new TokenExchangeError("permission", response.status);
  const now = Date.now();
  let expiresAt: number;
  if (token.expires_in !== undefined) expiresAt = now + token.expires_in * 1000;
  else {
    // Yoto documents a two-token response and JWT exp for lifetime tracking.
    // This token came directly from Yoto over HTTPS; decoding is not signature validation
    // and these claims are never used to authorize users, scopes or playlist ownership.
    try {
      const parts = token.access_token.split(".");
      if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1])) throw new Error();
      const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      const claims = JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, "=")));
      if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) throw new Error();
      expiresAt = claims.exp * 1000;
      if (expiresAt <= now || expiresAt > now + 31_536_000_000) throw new Error();
    } catch { throw new TokenExchangeError("expiry", response.status); }
  }
  return { accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt, scopes: token.scope?.split(" ") };
}

const safeDisplay = z.unknown().transform(value => {
  const icon = (value as { icon16x16?: unknown } | null)?.icon16x16;
  return typeof icon === "string" && /^yoto:#[A-Za-z0-9_-]{1,128}$/.test(icon) ? { icon16x16: icon } : undefined;
});
const trackSchema = z.object({
  key: z.string().optional(), title: z.string().optional(), duration: z.number().optional(),
  display: safeDisplay.optional()
});
const chapterSchema = z.object({
  key: z.string().optional(), title: z.string().optional(), tracks: z.array(trackSchema).optional(),
  display: safeDisplay.optional()
});
export const cardSchema = z.object({
  cardId: z.string(), title: z.string().optional(),
  createdAt: z.string().optional(), updatedAt: z.string().optional(),
  content: z.object({ chapters: z.array(chapterSchema).optional() }).optional(),
  metadata: z.object({
    description: z.string().optional(),
    media: z.object({ duration: z.number().optional() }).optional()
  }).optional()
});
export const cardsSchema = z.object({ cards: z.array(cardSchema) });
// Zod strips all fields not explicitly allowed: user IDs, signed media URLs,
// sharing URLs and other Yoto account metadata never become MCP output.
