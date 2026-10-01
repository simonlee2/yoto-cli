import { env } from "cloudflare:workers";
import { describe, it, expect, vi, afterEach } from "vitest";
import { authRoutes } from "../src/auth";
import { randomId } from "../src/security";
import type { AppEnv } from "../src/env";

afterEach(() => vi.restoreAllMocks());

// Entirely synthetic callbacks: no real code, account, key or outbound request.
function fixture() {
  const state = randomId(), secret = randomId();
  const request = new Request(`https://connector.test/oauth/yoto/callback?state=${state}&code=synthetic-code`, { headers: { Cookie: `__Host-yoto-flow=${secret}` } });
  const initialize = vi.fn(async () => {}), disconnect = vi.fn(async () => {});
  const complete = vi.fn(async () => ({ redirectTo: "https://assistant.test/callback?code=synthetic-downstream" }));
  const bindings = { ...env, PUBLIC_ORIGIN: "https://connector.test", YOTO_CLIENT_ID: "synthetic-client", TOKEN_ENCRYPTION_KEY: btoa("a".repeat(32)),
    AUTH_FLOWS: { getByName: () => ({ consume: async () => ({ request: { scope: ["myo:read"] }, verifier: "synthetic-verifier" }) }) },
    YOTO_CONNECTIONS: { getByName: () => ({ initialize, disconnect }) },
    OAUTH_PROVIDER: { completeAuthorization: complete }
  } as unknown as AppEnv;
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_in: 3600, token_type: "Bearer" }));
  return { request, bindings, initialize, disconnect, complete, fetcher };
}

describe("private callback diagnostics", () => {
  it.each(["configuration", "yoto-token", "credential-storage", "assistant-grant"] as const)("identifies %s without disclosing exception data", async stage => {
    const f = fixture();
    const sensitive = "synthetic-secret-that-must-never-appear";
    if (stage === "configuration") f.bindings.TOKEN_ENCRYPTION_KEY = "invalid-base64!";
    if (stage === "yoto-token") f.fetcher.mockRejectedValue(new Error(sensitive));
    if (stage === "credential-storage") f.initialize.mockRejectedValue(new Error(sensitive));
    if (stage === "assistant-grant") f.complete.mockRejectedValue(new Error(sensitive));
    const response = await authRoutes(f.request, f.bindings);
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain(`Support stage: ${stage}.`);
    for (const value of [sensitive, "synthetic-code", "synthetic-access", "synthetic-refresh"]) expect(body).not.toContain(value);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(f.disconnect).toHaveBeenCalledOnce();
    if (stage === "configuration") expect(f.fetcher).not.toHaveBeenCalled();
    if (["configuration", "yoto-token"].includes(stage)) expect(f.initialize).not.toHaveBeenCalled();
    if (stage !== "assistant-grant") expect(f.complete).not.toHaveBeenCalled();
  });

  it.each(["http", "missing-refresh", "malformed-json"])("contains %s token-response failures", async kind => {
    const f = fixture();
    f.fetcher.mockImplementation(async () => kind === "http" ? new Response("private upstream error", {status:400}) : kind === "malformed-json" ? new Response("private invalid JSON") : Response.json({ access_token: "synthetic-access", expires_in: 3600, token_type: "Bearer" }));
    const response = await authRoutes(f.request, f.bindings);
    const text = await response.text();
    expect(text).toContain("Support stage: yoto-token. Token check:");
    expect(text).not.toContain("private");
    expect(f.initialize).not.toHaveBeenCalled();
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.disconnect).toHaveBeenCalledOnce();
  });

  it("completes the synthetic callback without changing its scopes or redirect", async () => {
    const f = fixture();
    const response = await authRoutes(f.request, f.bindings);
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("https://assistant.test/callback?code=synthetic-downstream");
    expect(f.complete).toHaveBeenCalledWith(expect.objectContaining({ scope: ["myo:read"], props: expect.objectContaining({ scopes: ["myo:read"] }) }));
    expect(f.disconnect).not.toHaveBeenCalled();
  });
});
