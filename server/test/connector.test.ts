import { env, exports } from "cloudflare:workers";
import { runInDurableObject, reset, abortAllDurableObjects, runDurableObjectAlarm, createExecutionContext } from "cloudflare:test";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { randomId, sha256, seal, unseal } from "../src/security";
import { mcp } from "../src/mcp";
import type { AppEnv } from "../src/env";

const origin = "https://connector.test";
const dispatch = (path: string, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set("Host", "connector.test");
  return exports.default.fetch(`${origin}${path}`, { redirect: "manual", ...init, headers });
};
const validTokens = () => ({ accessToken: "test-access", refreshToken: "test-refresh", expiresAt: Date.now() + 3600_000 });
let outbound: ReturnType<typeof vi.spyOn>;
beforeEach(() => { outbound = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected outbound network request")); });
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

async function expectRejected(operation: () => PromiseLike<unknown>) {
  let rejected = false;
  try { await operation(); } catch { rejected = true; }
  expect(rejected).toBe(true);
}

async function startAuth(scope = "myo:read") {
  const registration = await dispatch("/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Test assistant <script>", redirect_uris: ["https://assistant.test/callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] })
  });
  expect(registration.status).toBe(201);
  const client = await registration.json() as { client_id: string };
  const verifier = randomId();
  const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: "https://assistant.test/callback", response_type: "code", scope, state: "assistant-state", code_challenge: await sha256(verifier), code_challenge_method: "S256", resource: `${origin}/mcp` });
  const consent = await dispatch(`/authorize?${query}`);
  expect(consent.status).toBe(200);
  const html = await consent.text();
  const state = html.match(/name="state" value="([^"]+)"/)![1];
  const csrf = html.match(/name="csrf" value="([^"]+)"/)![1];
  const cookie = consent.headers.get("Set-Cookie")!.split(";")[0];
  return { client, verifier, state, csrf, cookie, html, query, headers: consent.headers };
}

async function approve(flow: Awaited<ReturnType<typeof startAuth>>) {
  return dispatch("/consent", { method: "POST", headers: { Origin: origin, Cookie: flow.cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ state: flow.state, csrf: flow.csrf }) });
}

async function yotoLink(response: Response): Promise<URL> {
  const html = await response.clone().text();
  const href = html.match(/id="yoto-continue" rel="noreferrer" href="([^"]+)"/)?.[1];
  expect(href).toBeDefined();
  return new URL(href!.replace(/&amp;/g, "&"));
}

// Real local OAuth grants with mocked Yoto; never use account credentials.
async function connectedClient(manage = false) {
  const flow = await startAuth(manage ? "myo:read myo:write" : "myo:read");
  await approve(flow);
  outbound.mockImplementationOnce(async () => Response.json({ access_token: "mock-access", refresh_token: "mock-refresh", expires_in: 3600, token_type: "Bearer", scope: manage ? "user:content:view user:content:manage" : "user:content:view" }));
  const callback = await dispatch(`/oauth/yoto/callback?state=${flow.state}&code=mock-code`, { headers: { Cookie: flow.cookie } });
  expect(callback.status).toBe(303);
  const code = new URL(callback.headers.get("Location")!).searchParams.get("code")!;
  const body = new URLSearchParams({ grant_type: "authorization_code", code, client_id: flow.client.client_id, redirect_uri: "https://assistant.test/callback", code_verifier: flow.verifier, resource: `${origin}/mcp` });
  const response = await dispatch("/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  expect(response.status).toBe(200);
  return { ...await response.json() as { access_token: string; refresh_token: string }, client_id: flow.client.client_id };
}

async function rpc(token: string, method: string, params: Record<string, unknown> = {}) {
  const response = await dispatch("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" }, body: JSON.stringify({ jsonrpc: "2.0", id: 9, method, params }) });
  const text = await response.text();
  const body = JSON.parse(text.startsWith("event:") ? text.split("\n").find(line => line.startsWith("data: "))!.slice(6) : text);
  return { response, body };
}

describe("OAuth and MCP boundary", () => {
  it("advertises an exact MCP audience and challenges anonymous requests", async () => {
    const metadata = await dispatch("/.well-known/oauth-protected-resource/mcp");
    expect(await metadata.json()).toMatchObject({ resource: `${origin}/mcp`, scopes_supported: ["myo:read", "myo:write"] });
    const response = await dispatch("/mcp");
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain("resource_metadata");
    expect((await exports.default.fetch("https://wrong.test/health")).status).toBe(421);
  });

  it("requires explicit browser-bound consent and escapes client content", async () => {
    const flow = await startAuth();
    expect(flow.html).toContain("Test assistant &lt;script&gt;");
    expect(flow.html).not.toContain("Test assistant <script>");
    const rejected = await dispatch("/consent", { method: "POST", headers: { Origin: "https://evil.test", Cookie: flow.cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ state: flow.state, csrf: flow.csrf }) });
    expect(rejected.status).toBe(403);
    expect((await dispatch(`/oauth/yoto/callback?state=${flow.state}&code=unused`, { headers: { Cookie: flow.cookie } })).status).toBe(400);
    const redirect = await approve(flow);
    expect(redirect.status).toBe(200);
    const upstream = await yotoLink(redirect);
    expect(upstream.origin).toBe("https://login.yotoplay.com");
    expect(upstream.searchParams.get("scope")).toBe("user:content:view offline_access");
    expect(upstream.searchParams.get("code_challenge_method")).toBe("S256");
    expect((await approve(flow)).status).toBe(400);
    expect(outbound).not.toHaveBeenCalled();
  });

  it("preserves browser form Origin and suppresses referrers on the Yoto redirect", async () => {
    const flow = await startAuth();
    // Fetch turns no-referrer navigation POSTs into Origin: null.
    expect(flow.headers.get("Referrer-Policy")).toBe("same-origin");
    expect(flow.html).toContain('<form method="post" action="/consent">');
    expect(flow.headers.get("Set-Cookie")).toContain("HttpOnly; SameSite=Lax");
    expect(flow.headers.get("Set-Cookie")).toContain("Secure");
    const redirect = await approve(flow);
    expect(redirect.status).toBe(200);
    expect(redirect.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(outbound).not.toHaveBeenCalled();
  });

  it("ends the form navigation before any Yoto or assistant redirects", async () => {
    const flow = await startAuth();
    const policy = flow.headers.get("Content-Security-Policy")!;
    const directives = policy.split(";").map(value => value.trim());
    expect(directives.find(value => value.startsWith("form-action "))).toBe("form-action 'self'");
    expect(directives).toContain("default-src 'none'");
    expect(directives).toContain("frame-ancestors 'none'");
    expect(directives).toContain("base-uri 'none'");
    expect(flow.html).toContain('<form method="post" action="/consent">');
    const redirect = await approve(flow);
    expect(redirect.status).toBe(200);
    expect((await yotoLink(redirect)).origin).toBe("https://login.yotoplay.com");
    expect(redirect.headers.get("Location")).toBeNull();
    expect(redirect.headers.get("Refresh")).toBeNull();
    const continuation = await redirect.clone().text();
    expect(continuation).not.toMatch(/<form|http-equiv/i);
    expect(continuation).toContain('window.location.replace(document.getElementById("yoto-continue").href)');
    expect(continuation).toContain('class="primary-action"');
    expect(continuation).toContain('Your connection is not complete yet.');
    const nonce = continuation.match(/<script nonce="([A-Za-z0-9_-]{43})">/)![1];
    expect(redirect.headers.get("Content-Security-Policy")).toContain(`script-src 'nonce-${nonce}'`);
    expect(redirect.headers.get("Content-Security-Policy")).not.toContain("script-src 'unsafe-inline'");
    expect(continuation).not.toContain(flow.csrf);
    // All documents retain the same-origin-only form policy.
    for (const response of [redirect, await dispatch("/privacy"), await dispatch("/")]) {
      expect(response.headers.get("Content-Security-Policy")!.split(";").map(value => value.trim())).toContain("form-action 'self'");
    }
    expect(outbound).not.toHaveBeenCalled();
  });

  it("rejects invalid browser consent without consuming the valid flow", async () => {
    const flow = await startAuth();
    const validHeaders = { Origin: origin, Cookie: flow.cookie, "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" };
    const body = new URLSearchParams({ state: flow.state, csrf: flow.csrf });
    for (const value of ["null", "https://evil.test", ""]) {
      const headers = new Headers(validHeaders);
      if (value) headers.set("Origin", value); else headers.delete("Origin");
      const response = await dispatch("/consent", { method: "POST", headers, body });
      expect(response.status).toBe(403);
      expect(await response.text()).toBe("Invalid consent request.");
    }
    for (const headers of [{ ...validHeaders, Cookie: "" }, { ...validHeaders, "Content-Type": "text/plain" }]) {
      expect((await dispatch("/consent", { method: "POST", headers, body })).status).toBe(403);
    }
    expect((await dispatch("/consent", { method: "POST", headers: validHeaders, body: new URLSearchParams({ state: flow.state, csrf: randomId() }) })).status).toBe(403);
    expect((await dispatch("/consent")).status).toBe(404);
    expect((await dispatch("/consent", { method: "POST", headers: validHeaders, body })).status).toBe(200);
    expect(outbound).not.toHaveBeenCalled();
  });

  it("rejects missing PKCE and extra scopes", async () => {
    const { query } = await startAuth();
    query.delete("code_challenge");
    expect((await dispatch(`/authorize?${query}`)).status).toBe(400);
    query.set("code_challenge", await sha256(randomId()));
    query.set("scope", "myo:admin");
    expect((await dispatch(`/authorize?${query}`)).status).toBe(400);
  });

  it("completes two-leg OAuth, isolates upstream tokens, and prevents callback replay", async () => {
    const flow = await startAuth();
    const consentRedirect = await approve(flow);
    const upstreamParams = (await yotoLink(consentRedirect)).searchParams;
    outbound.mockImplementation(async (input, init) => {
      expect(String(input)).toBe("https://login.yotoplay.com/oauth/token");
      const tokenParams = new URLSearchParams(init!.body as string);
      expect(await sha256(tokenParams.get("code_verifier")!)).toBe(upstreamParams.get("code_challenge"));
      expect(tokenParams.get("client_id")).toBe(upstreamParams.get("client_id"));
      expect(tokenParams.get("redirect_uri")).toBe(upstreamParams.get("redirect_uri"));
      expect(Object.fromEntries(new URLSearchParams(init!.body as string))).toMatchObject({ grant_type: "authorization_code", code: "test-code", client_id: "test-client", redirect_uri: `${origin}/oauth/yoto/callback` });
      return Response.json({ access_token: "upstream-secret-access", refresh_token: "upstream-secret-refresh", expires_in: 3600, token_type: "Bearer" });
    });
    const callback = `/oauth/yoto/callback?state=${flow.state}&code=test-code`;
    expect((await dispatch(callback)).status).toBe(400);
    const result = await dispatch(callback, { headers: { Cookie: flow.cookie } });
    expect(result.status).toBe(303);
    const redirect = new URL(result.headers.get("Location")!);
    expect(redirect.origin).toBe("https://assistant.test");
    expect(redirect.searchParams.get("state")).toBe("assistant-state");
    expect((await dispatch(callback, { headers: { Cookie: flow.cookie } })).status).toBe(400);
    expect(outbound).toHaveBeenCalledTimes(1);
    const token = await dispatch("/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: redirect.searchParams.get("code")!, client_id: flow.client.client_id, redirect_uri: "https://assistant.test/callback", code_verifier: flow.verifier, resource: `${origin}/mcp` }) });
    expect(token.status).toBe(200);
    const tokens = await token.json() as { access_token: string };
    expect(JSON.stringify(tokens)).not.toContain("upstream-secret");
    const initialized = await dispatch("/mcp", { method: "POST", headers: { Authorization: `Bearer ${tokens.access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "contract-test", version: "1.0" } } }) });
    expect(initialized.status).toBe(200);
    expect(await initialized.text()).toContain("protocolVersion");
    const tools = await dispatch("/mcp", { method: "POST", headers: { Authorization: `Bearer ${tokens.access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
    const toolBody = await tools.text();
    expect({ status: tools.status, body: tools.status === 200 ? "ok" : toolBody }).toEqual({ status: 200, body: "ok" });
    expect(toolBody).toContain("list_myo_playlists");
    const discovery = JSON.parse(toolBody.startsWith("event:") ? toolBody.split("\n").find(line => line.startsWith("data: "))!.slice(6) : toolBody);
    for (const tool of discovery.result.tools) {
      expect(tool.securitySchemes).toEqual([{ type: "oauth2", scopes: ["prepare_myo_change", "apply_myo_change", "begin_myo_upload", "get_myo_upload", "cancel_myo_upload"].includes(tool.name) ? ["myo:read", "myo:write"] : ["myo:read"] }]);
    }
    const call = async (name: string) => {
      const response = await dispatch("/mcp", { method: "POST", headers: { Authorization: `Bearer ${tokens.access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: {} } }) });
      expect(response.status).toBe(200);
      return response.text();
    };
    expect(await call("connection_status")).toContain('connected');
    expect(await call("disconnect_yoto")).toContain('disconnected');
    const disconnectedRead = await call("list_myo_playlists");
    expect(disconnectedRead).toContain("mcp/www_authenticate");
    expect(disconnectedRead).toContain("error_description");
    expect(outbound).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("reports permission readiness without refresh or grant changes (manage=%s)", async manage => {
    const client = await connectedClient(manage);
    outbound.mockClear();
    const { body } = await rpc(client.access_token, "tools/call", { name: "connection_status", arguments: {} });
    expect(JSON.parse(body.result.content[0].text)).toMatchObject({ connected: true, management: { enabled: true, connectorGranted: manage, yotoGranted: manage, ready: manage } });
    expect(outbound).not.toHaveBeenCalled();
  });

  it("enforces token scopes even when the original grant had permission", async () => {
    const ctx = createExecutionContext();
    ctx.props = { connectionId: randomId(), scopes: ["myo:read"] };
    const testEnv = { ...env, OAUTH_PROVIDER: { unwrapToken: async () => ({ scope: [] }) } } as unknown as AppEnv;
    const response = await mcp(new Request(`${origin}/mcp`, { headers: { Authorization: "Bearer test-token" } }), testEnv, ctx);
    expect(response.status).toBe(403);
    expect(response.headers.get("WWW-Authenticate")).toContain("insufficient_scope");
  });

  it("revokes a downstream grant without claiming to delete upstream credentials", async () => {
    const client = await connectedClient();
    const connectionId = client.access_token.split(":")[0];
    const revoked = await dispatch("/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: client.refresh_token, token_type_hint: "refresh_token", client_id: client.client_id }) });
    expect(revoked.status).toBe(200);
    expect((await rpc(client.access_token, "tools/list")).response.status).toBe(401);
    expect(await env.YOTO_CONNECTIONS.getByName(connectionId).status()).toEqual({ connected: true });
    expect(outbound).toHaveBeenCalledTimes(1);
  });

  it("fails closed before connection access when its limiter is missing", async () => {
    const ctx = createExecutionContext();
    ctx.props = { connectionId: randomId(), scopes: ["myo:read"] };
    const config = { ...env, CONNECTION_LIMITER: undefined, OAUTH_PROVIDER: { unwrapToken: async () => ({ scope: ["myo:read"] }) } } as unknown as AppEnv;
    expect((await mcp(new Request(`${origin}/mcp`, { headers: { Authorization: "Bearer mock" } }), config, ctx)).status).toBe(503);
    expect(outbound).not.toHaveBeenCalled();
  });

  it("rejects wrong resource authorization requests", async () => {
    const { query } = await startAuth();
    for (const resource of ["https://other.test/mcp", origin, `${origin}/other`]) {
      query.set("resource", resource);
      expect((await dispatch(`/authorize?${query}`)).status).toBe(400);
    }
    expect(outbound).not.toHaveBeenCalled();
  });

  it("rejects wrong-audience, expired and deleted downstream tokens", async () => {
    const { access_token } = await connectedClient();
    // Modify only this test grant in local KV to exercise the provider boundary.
    const entries = await env.OAUTH_KV.list({ prefix: "token:" });
    expect(entries.keys).toHaveLength(1);
    const key = entries.keys[0].name;
    const original = await env.OAUTH_KV.get<Record<string, unknown>>(key, "json");
    for (const changes of [{ audience: "https://other.test/mcp" }, { audience: origin }, { expiresAt: 1 }]) {
      await env.OAUTH_KV.put(key, JSON.stringify({ ...original, ...changes }));
      const { response } = await rpc(access_token, "tools/list");
      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toContain("invalid_token");
    }
    await env.OAUTH_KV.put(key, JSON.stringify({ ...original, scope: [] }));
    // Scope errors are plain HTTP, not JSON-RPC, so check the boundary directly.
    const scopeResponse = await dispatch("/mcp", { headers: { Authorization: `Bearer ${access_token}` } });
    expect(scopeResponse.status).toBe(403);
    expect(scopeResponse.headers.get("WWW-Authenticate")).toContain("insufficient_scope");
    await env.OAUTH_KV.delete(key);
    expect((await rpc(access_token, "tools/list")).response.status).toBe(401);
    expect(outbound).toHaveBeenCalledTimes(1);
  });

  it("keeps authenticated connections isolated after disconnect", async () => {
    const first = await connectedClient();
    const second = await connectedClient();
    expect((await rpc(first.access_token, "tools/call", { name: "disconnect_yoto", arguments: {} })).body.result.isError).not.toBe(true);
    const status = await rpc(second.access_token, "tools/call", { name: "connection_status", arguments: {} });
    expect(JSON.parse(status.body.result.content[0].text)).toMatchObject({ connected: true });
    const read = await rpc(first.access_token, "tools/call", { name: "list_myo_playlists", arguments: {} });
    expect(read.body.result.isError).toBe(true);
    expect(read.body.result._meta["mcp/www_authenticate"]).toHaveLength(1);
    expect(outbound).toHaveBeenCalledTimes(2);
  });

  it("reports invalid tools and arguments without upstream requests", async () => {
    const { access_token } = await connectedClient();
    for (const params of [{ name: "unknown_tool", arguments: {} }, { name: "get_myo_playlist", arguments: { cardId: "../private" } }, { name: "get_myo_playlist", arguments: {} }]) {
      const { body } = await rpc(access_token, "tools/call", params);
      expect(Boolean(body.error || body.result?.isError)).toBe(true);
    }
    const unknown = await rpc(access_token, "unsupported/method");
    expect(unknown.body.error.code).toBe(-32601);
    expect(outbound).toHaveBeenCalledTimes(1);
  });

  it("sanitizes upstream errors and signals reconnect only after revoked credentials", async () => {
    const { access_token } = await connectedClient();
    for (const status of [503, 401]) {
      outbound.mockImplementationOnce(async () => new Response("private-upstream-secret", { status }));
      const { body } = await rpc(access_token, "tools/call", { name: "list_myo_playlists", arguments: {} });
      expect(body.result.isError).toBe(true);
      expect(JSON.stringify(body)).not.toContain("private-upstream-secret");
      expect(Boolean(body.result._meta?.["mcp/www_authenticate"])).toBe(status === 401);
    }
  });

  it("lists all nine tools in one page with truthful annotations", async () => {
    const { access_token } = await connectedClient();
    const { body } = await rpc(access_token, "tools/list");
    expect(body.result.nextCursor).toBeUndefined();
    expect(body.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(["apply_myo_change", "begin_myo_upload", "cancel_myo_upload", "connection_status", "disconnect_yoto", "get_myo_playlist", "get_myo_upload", "list_myo_playlists", "prepare_myo_change"]);
    for (const tool of body.result.tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.annotations.readOnlyHint).toBe(!["disconnect_yoto", "prepare_myo_change", "apply_myo_change", "begin_myo_upload", "cancel_myo_upload"].includes(tool.name));
      expect(tool.annotations.destructiveHint).toBe(["disconnect_yoto", "apply_myo_change", "cancel_myo_upload"].includes(tool.name));
      expect(tool.annotations.openWorldHint).toBe(["get_myo_playlist", "list_myo_playlists", "prepare_myo_change", "apply_myo_change", "begin_myo_upload", "get_myo_upload"].includes(tool.name));
    }
  });

  it("runs authenticated management preview/apply and rejects absent confirmation", async () => {
    const { access_token } = await connectedClient(true);
    const preview = await rpc(access_token, "tools/call", { name: "prepare_myo_change", arguments: { change: { kind: "create", title: "Managed" } } });
    const changeId = JSON.parse(preview.body.result.content[0].text).changeId;
    const denied = await rpc(access_token, "tools/call", { name: "apply_myo_change", arguments: { changeId, confirmed: false } });
    expect(Boolean(denied.body.error || denied.body.result?.isError)).toBe(true);
    expect(outbound).toHaveBeenCalledTimes(1);
    const card = { cardId: "managed", title: "Managed", content: { chapters: [], playbackType: "linear", activity: "yoto_Player", version: "1", restricted: true }, metadata: { description: "" } };
    outbound.mockImplementationOnce(async () => Response.json({card})).mockImplementationOnce(async () => Response.json({cards:[card]})).mockImplementationOnce(async () => Response.json({card}));
    const result = await rpc(access_token, "tools/call", { name: "apply_myo_change", arguments: { changeId, confirmed: true } });
    expect(result.body.result.isError).not.toBe(true);
    expect(JSON.parse(result.body.result.content[0].text).cardId).toBe("managed");
    const replay = await rpc(access_token, "tools/call", { name: "apply_myo_change", arguments: { changeId, confirmed: true } });
    expect(replay.body.result).toEqual(result.body.result);
    expect(outbound).toHaveBeenCalledTimes(4);
  });

  it("does not allow read-only tokens to prepare writes", async () => {
    const { access_token } = await connectedClient();
    const { body } = await rpc(access_token, "tools/call", { name: "prepare_myo_change", arguments: { change: { kind: "create", title: "Test" } } });
    expect(body.result.isError).toBe(true);
    const challenge = body.result._meta["mcp/www_authenticate"][0];
    expect(challenge).toContain('scope="myo:read myo:write"');
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain('error_description="Approve Yoto playlist management to prepare or apply changes"');
    expect(challenge).toContain(`resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`);
    expect(outbound).toHaveBeenCalledTimes(1);
  });

  it("requests management only after explicit downstream scope and rejects missing upstream grant", async () => {
    const flow = await startAuth("myo:read myo:write");
    const consent = await approve(flow);
    expect((await yotoLink(consent)).searchParams.get("scope")).toBe("user:content:view user:content:manage offline_access");
    outbound.mockResolvedValueOnce(Response.json({ access_token: "mock", refresh_token: "mock", expires_in: 3600, token_type: "Bearer", scope: "user:content:view" }));
    const result = await dispatch(`/oauth/yoto/callback?state=${flow.state}&code=mock`, { headers: { Cookie: flow.cookie } });
    expect(result.status).toBe(400);
  });

  it("rejects expired consent transactions", async () => {
    const flow = await startAuth();
    await runInDurableObject(env.AUTH_FLOWS.getByName(flow.state), (_object, state) => {
      const stored = state.storage.kv.get<Record<string, unknown>>("flow")!;
      state.storage.kv.put("flow", { ...stored, expiresAt: 0 });
    });
    expect((await approve(flow)).status).toBe(400);
    expect(outbound).not.toHaveBeenCalled();
  });
});

describe("per-connection credentials", () => {
  it("encrypts at rest, isolates connections and deletes credentials on disconnect", async () => {
    const first = env.YOTO_CONNECTIONS.getByName(randomId());
    const second = env.YOTO_CONNECTIONS.getByName(randomId());
    await first.initialize(validTokens());
    const stored = await runInDurableObject(first, (_object, state) => state.storage.kv.get<string>("tokens"));
    expect(stored).not.toContain("test-access");
    expect(stored).not.toContain("test-refresh");
    expect(await first.status()).toEqual({ connected: true });
    expect(await second.status()).toEqual({ connected: false });
    await first.disconnect();
    expect(await first.status()).toEqual({ connected: false });
    expect(await runInDurableObject(first, (_object, state) => state.storage.kv.get("tokens"))).toBeUndefined();
    await expectRejected(() => first.list());
    expect(outbound).not.toHaveBeenCalled();
  });

  it("refreshes once under concurrent calls and strips private fields", async () => {
    let connection = env.YOTO_CONNECTIONS.getByName(randomId());
    await connection.initialize({ ...validTokens(), expiresAt: 0 });
    let refreshes = 0;
    outbound.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/oauth/token")) {
        refreshes++;
        expect(new URLSearchParams(init!.body as string).get("refresh_token")).toBe("test-refresh");
        return Response.json({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600, token_type: "Bearer" });
      }
      expect(new Headers(init!.headers).get("Authorization")).toBe("Bearer rotated-access");
      return Response.json({ cards: [{ cardId: "owned", title: "Example", userId: "private", metadata: { previewAudio: "https://private.test/audio" } }] });
    });
    const lists = await Promise.all([connection.list(), connection.list(), connection.list()]);
    expect(refreshes).toBe(1);
    expect(JSON.stringify(lists)).not.toContain("private");
    const id = connection.id;
    await abortAllDurableObjects();
    connection = env.YOTO_CONNECTIONS.get(id);
    await connection.list();
    expect(refreshes).toBe(1);
  });

  it("uses the rotated refresh token on the next expiry after restart", async () => {
    let connection = env.YOTO_CONNECTIONS.getByName(randomId());
    await connection.initialize({ ...validTokens(), expiresAt: 0 });
    let refreshes = 0;
    outbound.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/oauth/token")) {
        const expected = refreshes === 0 ? "test-refresh" : "rotated-refresh-1";
        expect(new URLSearchParams(init!.body as string).get("refresh_token")).toBe(expected);
        refreshes++;
        return Response.json({ access_token: `access-${refreshes}`, refresh_token: `rotated-refresh-${refreshes}`, expires_in: 3600, token_type: "Bearer" });
      }
      return Response.json({ cards: [] });
    });
    await connection.list();
    await runInDurableObject(connection, async (_object, state) => {
      const tokens = await unseal<Record<string, unknown>>(state.storage.kv.get<string>("tokens")!, env.TOKEN_ENCRYPTION_KEY);
      state.storage.kv.put("tokens", await seal({ ...tokens, expiresAt: 0 }, env.TOKEN_ENCRYPTION_KEY));
    });
    const id = connection.id;
    await abortAllDurableObjects();
    connection = env.YOTO_CONNECTIONS.get(id);
    await connection.list();
    expect(refreshes).toBe(2);
  });

  it.each([
    { name: "omitted", response: {}, expected: ["user:content:view", "user:content:manage"] },
    { name: "reduced", response: { scope: "user:content:view" }, expected: ["user:content:view"] },
    { name: "empty", response: { scope: "" }, expected: [""] }
  ])("retains $name refresh scope semantics across rotations and restart", async ({ response, expected }) => {
    const owner = randomId();
    let connection = env.YOTO_CONNECTIONS.getByName(owner);
    await connection.initialize({ ...validTokens(), expiresAt: 0, scopes: ["user:content:view", "user:content:manage"] });
    let refreshes = 0;
    outbound.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/oauth/token")) {
        expect(new URLSearchParams(init!.body as string).get("refresh_token")).toBe(refreshes === 0 ? "test-refresh" : `refresh-${refreshes}`);
        refreshes++;
        return Response.json({ access_token: `access-${refreshes}`, refresh_token: `refresh-${refreshes}`, expires_in: 3600, ...(refreshes === 1 ? response : {}) });
      }
      return Response.json({ cards: [] });
    });
    for (let rotation = 0; rotation < 3; rotation++) {
      await connection.list();
      expect(await connection.managementPermission()).toBe(expected.includes("user:content:manage"));
      if (expected.includes("user:content:manage")) {
        expect(await connection.prepareChange(owner, { kind: "create", title: "Synthetic preview" })).toHaveProperty("changeId");
      } else {
        await expectRejected(() => connection.prepareChange(owner, { kind: "create", title: "Synthetic preview" }));
      }
      await runInDurableObject(connection, async (_object, state) => {
        const tokens = await unseal<Record<string, unknown>>(state.storage.kv.get<string>("tokens")!, env.TOKEN_ENCRYPTION_KEY);
        expect(tokens.scopes).toEqual(expected);
        state.storage.kv.put("tokens", await seal({ ...tokens, expiresAt: 0 }, env.TOKEN_ENCRYPTION_KEY));
      });
      const id = connection.id;
      await abortAllDurableObjects();
      connection = env.YOTO_CONNECTIONS.get(id);
    }
    expect(refreshes).toBe(3);
  });

  it("uses each connection's own upstream identity and blocks a foreign playlist before detail fetch", async () => {
    const a = env.YOTO_CONNECTIONS.getByName(randomId()), b = env.YOTO_CONNECTIONS.getByName(randomId());
    await a.initialize({ ...validTokens(), accessToken: "identity-a" });
    await b.initialize({ ...validTokens(), accessToken: "identity-b" });
    outbound.mockImplementation(async (input, init) => {
      expect(String(input)).toBe("https://api.yotoplay.com/content/mine");
      const bearer = new Headers(init!.headers).get("Authorization");
      expect(["Bearer identity-a", "Bearer identity-b"]).toContain(bearer);
      return Response.json({ cards: [{ cardId: bearer === "Bearer identity-a" ? "owned-a" : "owned-b" }] });
    });
    const [first, second] = await Promise.all([a.list(), b.list()]);
    expect(first.cards.map(c => c.cardId)).toEqual(["owned-a"]);
    expect(second.cards.map(c => c.cardId)).toEqual(["owned-b"]);
    await expectRejected(() => a.get("owned-b"));
    await expectRejected(() => b.get("owned-a"));
    expect(outbound).toHaveBeenCalledTimes(4);
  });

  it("never retries an ambiguous single-use refresh", async () => {
    let connection = env.YOTO_CONNECTIONS.getByName(randomId());
    await connection.initialize({ ...validTokens(), expiresAt: 0 });
    await expectRejected(() => connection.list());
    const id = connection.id;
    await abortAllDurableObjects();
    connection = env.YOTO_CONNECTIONS.get(id);
    await expectRejected(() => connection.list());
    expect(outbound).toHaveBeenCalledTimes(1);
    expect(await connection.status()).toEqual({ connected: false });
  });

  it("requires reconnect after a crash with refresh marked in progress", async () => {
    let connection = env.YOTO_CONNECTIONS.getByName(randomId());
    await connection.initialize(validTokens());
    await runInDurableObject(connection, (_object, state) => { state.storage.kv.put("refreshing", true); });
    const id = connection.id;
    await abortAllDurableObjects();
    connection = env.YOTO_CONNECTIONS.get(id);
    await expectRejected(() => connection.list());
    expect(outbound).not.toHaveBeenCalled();
  });

  it("verifies ownership before fetching a playlist", async () => {
    let connection = env.YOTO_CONNECTIONS.getByName(randomId());
    await connection.initialize(validTokens());
    outbound.mockImplementation(async () => Response.json({ cards: [{ cardId: "owned" }] }));
    await expectRejected(() => connection.get("somebody-elses-card"));
    expect(outbound).toHaveBeenCalledTimes(1);
    expect(String(outbound.mock.calls[0][0])).toBe("https://api.yotoplay.com/content/mine");
  });

  it("returns owned chapter details without signed audio URLs or user identity", async () => {
    const connection = env.YOTO_CONNECTIONS.getByName(randomId());
    await connection.initialize(validTokens());
    outbound.mockImplementation(async (input) => String(input).endsWith("/mine")
      ? Response.json({ cards: [{ cardId: "owned" }] })
      : Response.json({ card: { cardId: "owned", title: "Example", creatorEmail: "private@example.test", content: { chapters: [{ key: "01", title: "Chapter", tracks: [{ key: "01", title: "Track", trackUrl: "https://private.test/audio" }] }] } } }));
    const result = await connection.get("owned");
    expect(result.content?.chapters?.[0].title).toBe("Chapter");
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("expires unused credentials and preserves recently used connections", async () => {
    let connection = env.YOTO_CONNECTIONS.getByName(randomId());
    await connection.initialize(validTokens());
    await runDurableObjectAlarm(connection);
    expect(await connection.status()).toEqual({ connected: true });
    await runInDurableObject(connection, (_object, state) => { state.storage.kv.put("expires", 0); });
    await runDurableObjectAlarm(connection);
    expect(await connection.status()).toEqual({ connected: false });
  });

  it("rejects expired credentials before the cleanup alarm runs", async () => {
    const connection = env.YOTO_CONNECTIONS.getByName(randomId());
    await connection.initialize(validTokens());
    await runInDurableObject(connection, (_object, state) => { state.storage.kv.put("expires", 0); });
    await expectRejected(() => connection.list());
    expect(await connection.status()).toEqual({ connected: false });
    expect(outbound).not.toHaveBeenCalled();
    expect(await runInDurableObject(connection, (_object, state) => state.storage.kv.get("tokens"))).toBeUndefined();
  });

  it("extends retention only after a validated playlist read", async () => {
    const connection = env.YOTO_CONNECTIONS.getByName(randomId());
    await connection.initialize(validTokens());
    const deadline = Date.now() + 60_000;
    await runInDurableObject(connection, (_object, state) => { state.storage.kv.put("expires", deadline); });
    outbound.mockImplementationOnce(async () => Response.json({ cards: "invalid" }));
    await expectRejected(() => connection.list());
    expect(await runInDurableObject(connection, (_object, state) => state.storage.kv.get("expires"))).toBe(deadline);
    outbound.mockImplementationOnce(async () => Response.json({ cards: [{ cardId: "owned" }] }));
    outbound.mockImplementationOnce(async () => Response.json({ card: { cardId: "different" } }));
    await expectRejected(() => connection.get("owned"));
    expect(await runInDurableObject(connection, (_object, state) => state.storage.kv.get("expires"))).toBe(deadline);
    outbound.mockImplementationOnce(async () => Response.json({ cards: [] }));
    expect(await connection.list()).toEqual({ cards: [] });
    expect(await runInDurableObject(connection, (_object, state) => state.storage.kv.get<number>("expires"))).toBeGreaterThan(deadline);
  });

  it("returns every supplied library item and accepts an empty library", async () => {
    const connection = env.YOTO_CONNECTIONS.getByName(randomId());
    await connection.initialize(validTokens());
    const cards = Array.from({ length: 500 }, (_, index) => ({ cardId: `card-${index}`, title: `Playlist ${index}` }));
    outbound.mockImplementationOnce(async () => Response.json({ cards }));
    expect((await connection.list()).cards).toEqual(cards);
    outbound.mockImplementationOnce(async () => Response.json({ cards: [] }));
    expect(await connection.list()).toEqual({ cards: [] });
    expect(outbound).toHaveBeenCalledTimes(2);
  });

  it("invalidates revoked Yoto credentials but preserves credentials on transient failures", async () => {
    const connection = env.YOTO_CONNECTIONS.getByName(randomId());
    await connection.initialize(validTokens());
    outbound.mockImplementationOnce(async () => new Response("private upstream message", { status: 503 }));
    await expectRejected(() => connection.list());
    expect(await connection.status()).toEqual({ connected: true });
    outbound.mockImplementationOnce(async () => new Response("private upstream message", { status: 401 }));
    await expectRejected(() => connection.list());
    expect(await connection.status()).toEqual({ connected: false });
    await expectRejected(() => connection.list());
    expect(outbound).toHaveBeenCalledTimes(2);
  });

  it("does not restore credentials when disconnect queues behind a refresh", async () => {
    const connection = env.YOTO_CONNECTIONS.getByName(randomId());
    await connection.initialize({ ...validTokens(), expiresAt: 0 });
    outbound.mockImplementation(async (input) => String(input).endsWith("/oauth/token")
      ? Response.json({ access_token: "rotated", refresh_token: "rotated-refresh", expires_in: 3600, token_type: "Bearer" })
      : Response.json({ cards: [] }));
    const [read] = await Promise.all([connection.list(), connection.disconnect()]);
    expect(read).toEqual({ cards: [] });
    expect(await connection.status()).toEqual({ connected: false });
    await expectRejected(() => connection.list());
    expect(outbound).toHaveBeenCalledTimes(2);
    expect(await runInDurableObject(connection, (_object, state) => state.storage.kv.get("tokens"))).toBeUndefined();
  });

  it("rejects ciphertext modified at rest", async () => {
    const encrypted = JSON.parse(await seal({ secret: "private" }, btoa("a".repeat(32))));
    encrypted.data[0] ^= 1;
    await expect(unseal(JSON.stringify(encrypted), btoa("a".repeat(32)))).rejects.toThrow();
  });
});
