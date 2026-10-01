import type { AppEnv } from "./env";
import { boundedText, escapeHtml, publicOrigin, randomId, sha256, validateEncryptionKey } from "./security";
import { exchangeTokens, TokenExchangeError, YOTO_SCOPES } from "./yoto";

export const CONNECTOR_SCOPE = "myo:read";
export const WRITE_SCOPE = "myo:write";
const FLOW_TTL = 10 * 60 * 1000;
const DEFAULT_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

export function safeResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: {
    "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": DEFAULT_CSP,
    ...headers
  } });
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><style>body{font:18px/1.6 system-ui;max-width:38rem;margin:12vh auto;padding:24px;color:#172b27;background:#f5f5ef}button,.primary-action{display:inline-block;text-decoration:none;font:inherit;padding:12px 22px;background:#205949;color:white;border:0;border-radius:9px;cursor:pointer}button:hover,.primary-action:hover{background:#17463e}button:focus-visible,a:focus-visible{outline:3px solid #205949;outline-offset:4px}small{color:#596761}h1{line-height:1.15}</style><main><h1>${escapeHtml(title)}</h1>${body}</main></html>`;
}

function cookieName(origin: string): string { return origin.startsWith("https:") ? "__Host-yoto-flow" : "yoto-dev-flow"; }
function cookieHeader(origin: string, secret: string, maxAge: number): string {
  return `${cookieName(origin)}=${secret}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${origin.startsWith("https:") ? "; Secure" : ""}`;
}
function browserSecret(request: Request, origin: string): string | null {
  const parts = (request.headers.get("Cookie") ?? "").split(";").map(v => v.trim());
  const value = parts.find(v => v.startsWith(`${cookieName(origin)}=`))?.split("=")[1];
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
function validFlow(value: string | null): value is string { return !!value && /^[A-Za-z0-9_-]{43}$/.test(value); }

export async function authRoutes(request: Request, env: AppEnv): Promise<Response> {
  const origin = publicOrigin(env.PUBLIC_ORIGIN);
  const url = new URL(request.url);
  if (url.pathname === "/" && request.method === "GET") {
    return safeResponse(page("Yoto connector", `<p>Connect from your MCP-compatible assistant to browse your own Yoto Make Your Own playlists.</p><p>Connector address: <code>${escapeHtml(origin)}/mcp</code></p><p>You will sign in with Yoto and approve access before any playlists are shared.</p><p><a href="/privacy">Privacy and disconnecting</a></p>`));
  }
  if (url.pathname === "/privacy" && request.method === "GET") {
    return safeResponse(page("Your Yoto connection", "<p>This independent connector stores encrypted Yoto access and refresh tokens on Cloudflare. It can read your own MYO playlist titles and chapter details. If you explicitly grant management permission, it can also create playlists and apply previewed changes. Encrypted change previews expire after 10 minutes; minimal write receipts expire after 24 hours. Those details are sent to the assistant you connect.</p><p>It does not store audio, your Yoto password, or a copy of your playlists. Private upload links expire after 30 minutes. Audio is sent directly to Yoto; small PNG icons pass through the connector without being saved. Encrypted upload-job metadata is deleted on expiry or disconnect. Cancelling a job prevents attachment but cannot revoke a signed Yoto upload URL already issued. Credentials expire from storage after 30 days without a successful playlist read. Ask your assistant to disconnect Yoto to delete this connection’s saved credentials immediately, then remove the connector from the assistant’s settings.</p><p>Each connection is separate. Disconnect other assistants separately. Removing the connector or revoking its assistant token does not immediately delete saved Yoto credentials; without a successful read they expire after 30 days. Disconnect deletes saved credentials but does not revoke the app’s authorization at Yoto. You may also revoke that authorization through Yoto where available. Operations already in progress may finish before disconnect completes.</p>"));
  }
  if (!env.YOTO_CLIENT_ID || !env.TOKEN_ENCRYPTION_KEY) return safeResponse("Connector setup is incomplete.", 503);

  if (url.pathname === "/authorize" && request.method === "GET") {
    const auth = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    if (!auth.codeChallenge || auth.codeChallengeMethod !== "S256" ||
        auth.scope.some(s => s !== CONNECTOR_SCOPE && !(env.WRITES_ENABLED === "true" && s === WRITE_SCOPE))) return safeResponse("This connector requires PKCE S256 and the myo:read scope.", 400);
    const manage = auth.scope.includes(WRITE_SCOPE);
    const client = await env.OAUTH_PROVIDER.lookupClient(auth.clientId);
    if (!client) return safeResponse("Unknown client.", 400);
    const state = randomId();
    const secret = randomId();
    await env.AUTH_FLOWS.getByName(state).create({
      request: auth, browserHash: await sha256(secret), verifier: randomId(),
      expiresAt: Date.now() + FLOW_TTL, stage: "consent"
    });
    return safeResponse(page("Connect to Yoto", `<p><strong>${escapeHtml(client.clientName ?? "This assistant")}</strong> is asking to ${manage ? "read and manage" : "read"} your MYO playlists and chapter details.</p><p>It can also disconnect this connection. ${manage ? "It can create playlists and apply previewed edits, including track removal. Whole-playlist deletion is not exposed." : "It cannot edit or delete playlists."}</p><p>After sign-in you will return to <strong>${escapeHtml(new URL(auth.redirectUri).host)}</strong>.</p><form method="post" action="/consent"><input type="hidden" name="state" value="${state}"><input type="hidden" name="csrf" value="${secret}"><button type="submit">Continue to Yoto</button></form><p><small>Only continue if you started this connection. <a href="/privacy">Privacy</a></small></p>`), 200, {
      "Set-Cookie": cookieHeader(origin, secret, FLOW_TTL / 1000),
      // no-referrer makes browser form POSTs send Origin: null (Fetch append-Origin).
      // Preserve same-origin CSRF validation; external redirects still use no-referrer.
      "Referrer-Policy": "same-origin"
    });
  }

  if (url.pathname === "/consent" && request.method === "POST") {
    if (request.headers.get("Origin") !== origin) return safeResponse("Invalid consent request.", 403);
    const secret = browserSecret(request, origin);
    if (!secret || !request.headers.get("Content-Type")?.startsWith("application/x-www-form-urlencoded")) return safeResponse("Invalid consent request.", 403);
    if (!request.body) return safeResponse("Invalid consent request.", 400);
    const text = await boundedText(request.body, 2048);
    const form = new URLSearchParams(text);
    const state = form.get("state");
    if (!validFlow(state) || form.get("csrf") !== secret) return safeResponse("Invalid consent request.", 403);
    const flow = await env.AUTH_FLOWS.getByName(state).approve(await sha256(secret));
    if (!flow) return safeResponse("This connection attempt expired. Start again from your assistant.", 400);
    const upstream = new URL("https://login.yotoplay.com/authorize");
    upstream.search = new URLSearchParams({
      client_id: env.YOTO_CLIENT_ID, response_type: "code", audience: "https://api.yotoplay.com",
      redirect_uri: `${origin}/oauth/yoto/callback`, scope: flow.request.scope.includes(WRITE_SCOPE) ? "user:content:view user:content:manage offline_access" : YOTO_SCOPES,
      state, code_challenge: await sha256(flow.verifier), code_challenge_method: "S256"
    }).toString();
    // Commit a new document before navigation: the original POST's form-action
    // must not follow Yoto's redirect chain into the assistant callback.
    const nonce = randomId();
    const manage = flow.request.scope.includes(WRITE_SCOPE);
    return safeResponse(page("Opening Yoto", `<p>Continue on Yoto to authorize ${manage ? "reading and managing" : "reading"} your MYO playlists. Your connection is not complete yet.</p><p>If Yoto does not open automatically, use the button below.</p><p><a id="yoto-continue" rel="noreferrer" href="${escapeHtml(upstream.href)}" class="primary-action">Continue to Yoto</a></p><p><small>After authorization, Yoto will return you to your assistant. <a href="/privacy">Privacy</a></small></p><script nonce="${nonce}">window.location.replace(document.getElementById("yoto-continue").href);</script>`), 200, {
      "Content-Security-Policy": `${DEFAULT_CSP}; script-src 'nonce-${nonce}'`
    });
  }

  if (url.pathname === "/oauth/yoto/callback" && request.method === "GET") {
    const state = url.searchParams.get("state");
    const secret = browserSecret(request, origin);
    if (!validFlow(state) || !secret) return safeResponse("Invalid connection callback. Start again from your assistant.", 400);
    const flow = await env.AUTH_FLOWS.getByName(state).consume(await sha256(secret));
    const clearCookie = { "Set-Cookie": cookieHeader(origin, "", 0) };
    if (!flow) return safeResponse("This connection attempt expired or was already used.", 400, clearCookie);
    const code = url.searchParams.get("code");
    if (!code || code.length > 4096 || url.searchParams.has("error")) return safeResponse("Yoto connection was not approved. Start again from your assistant.", 400, clearCookie);
    const connectionId = randomId();
    const connection = env.YOTO_CONNECTIONS.getByName(connectionId);
    let stage: "configuration" | "yoto-token" | "credential-storage" | "assistant-grant" = "configuration";
    try {
      // Validate locally before consuming the single-use upstream authorization code.
      await validateEncryptionKey(env.TOKEN_ENCRYPTION_KEY);
      stage = "yoto-token";
      const tokens = await exchangeTokens({
        grant_type: "authorization_code", client_id: env.YOTO_CLIENT_ID, code,
        redirect_uri: `${origin}/oauth/yoto/callback`, code_verifier: flow.verifier
      });
      if (flow.request.scope.includes(WRITE_SCOPE) && !tokens.scopes?.includes("user:content:manage")) throw new Error("Yoto did not confirm management scope");
      stage = "credential-storage";
      await connection.initialize(tokens);
      const granted = [CONNECTOR_SCOPE, ...(flow.request.scope.includes(WRITE_SCOPE) ? [WRITE_SCOPE] : [])];
      stage = "assistant-grant";
      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: flow.request, userId: connectionId, metadata: {}, scope: granted,
        props: { connectionId, scopes: granted }
      });
      return safeResponse("", 303, { Location: redirectTo, ...clearCookie });
    } catch (error) {
      await connection.disconnect();
      const detail = stage === "yoto-token" && error instanceof TokenExchangeError ? ` Token check: ${error.diagnostic}.` : "";
      // Fixed stage labels only: never render exception text, codes, tokens or upstream bodies.
      return safeResponse(`Could not complete the Yoto connection. Support stage: ${stage}.${detail} Start again from your assistant.`, 400, clearCookie);
    }
  }
  return safeResponse("Not found.", 404);
}
