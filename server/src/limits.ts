import type { AppEnv } from "./env";
import { sha256 } from "./security";

type Limiter = { limit(options: { key: string }): Promise<{ success: boolean }> };

export async function enforceLimit(limiter: Limiter | undefined, key: string): Promise<Response | null> {
  try {
    if (!limiter) throw new Error("Missing limiter");
    if ((await limiter.limit({ key })).success) return null;
    return Response.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": "60", "Cache-Control": "no-store" } });
  } catch {
    // Missing or unavailable abuse protection must not silently open enrollment.
    return Response.json({ error: "temporarily_unavailable" }, { status: 503, headers: { "Retry-After": "60", "Cache-Control": "no-store" } });
  }
}

/** Approximate per-location protection, not a global spending cap. */
export async function guardRequest(request: Request, env: AppEnv): Promise<Request | Response> {
  const path = new URL(request.url).pathname;
  if (["/register", "/authorize", "/consent"].includes(path) && env.ENROLLMENT_ENABLED !== "true") {
    return Response.json({ error: "enrollment_paused" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  const aggregate = await enforceLimit(env.EDGE_LIMITER, "yoto-pilot");
  if (aggregate) return aggregate;
  // Trust only Cloudflare's edge-supplied header, never X-Forwarded-For.
  // Missing IPs share a bucket (including local development), never bypass it.
  const clientKey = await sha256(request.headers.get("CF-Connecting-IP") ?? "unknown");
  const isMcp = path === "/mcp" || path.startsWith("/mcp/");
  const limited = await enforceLimit(isMcp ? env.MCP_LIMITER : env.AUTH_LIMITER, clientKey);
  if (limited) return limited;
  // Bound actual bytes, including chunked bodies, before SDK/provider parsing.
  if (request.body) {
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65_536) {
        await reader.cancel();
        return Response.json({ error: "request_too_large" }, { status: 413, headers: { "Cache-Control": "no-store" } });
      }
      chunks.push(value);
    }
    return new Request(request, { body: new Blob(chunks) });
  }
  return request;
}
