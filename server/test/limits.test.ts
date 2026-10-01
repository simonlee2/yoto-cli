import { env } from "cloudflare:workers";
import { reset, createExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { enforceLimit, guardRequest } from "../src/limits";
import worker from "../src/index";
import type { AppEnv } from "../src/env";

const allowed = () => ({ limit: vi.fn(async () => ({ success: true })) });
function bindings() {
  return { ...env, ENROLLMENT_ENABLED: "true", EDGE_LIMITER: allowed(), AUTH_LIMITER: allowed(), MCP_LIMITER: allowed() } as unknown as AppEnv;
}
afterEach(async () => { await reset(); });

describe("pilot abuse controls", () => {
  it("fails closed on missing and unavailable limiters", async () => {
    expect((await enforceLimit(undefined, "test"))?.status).toBe(503);
    expect((await enforceLimit({ limit: async () => { throw new Error("private infrastructure detail"); } }, "test"))?.status).toBe(503);
  });
  it("denies registration before creating client records", async () => {
    const config = bindings();
    config.EDGE_LIMITER = { limit: async () => ({ success: false }) };
    const response = await worker.fetch(new Request("https://connector.test/register", { method: "POST", body: "{}" }), config, createExecutionContext());
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect((await env.OAUTH_KV.list()).keys).toHaveLength(0);
  });
  it("pauses new enrollment without blocking token or MCP traffic", async () => {
    const config = bindings();
    config.ENROLLMENT_ENABLED = "false";
    for (const path of ["/register", "/authorize", "/consent"]) {
      expect((await guardRequest(new Request(`https://connector.test${path}`), config) as Response).status).toBe(503);
    }
    for (const path of ["/token", "/mcp", "/oauth/yoto/callback"]) {
      expect(await guardRequest(new Request(`https://connector.test${path}`), config)).toBeInstanceOf(Request);
    }
  });
  it("uses separate buckets without including bearer tokens or raw IPs", async () => {
    const config = bindings();
    await guardRequest(new Request("https://connector.test/mcp", { headers: { "CF-Connecting-IP": "192.0.2.10", Authorization: "Bearer private-secret" } }), config);
    const key = vi.mocked(config.MCP_LIMITER.limit).mock.calls[0][0].key;
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(key).not.toContain("192.0.2.10");
    expect(key).not.toContain("private-secret");
    expect(config.AUTH_LIMITER.limit).not.toHaveBeenCalled();
  });
  it("rejects actual oversized chunked bodies and preserves allowed bodies", async () => {
    const config = bindings();
    const oversized = new Request("https://connector.test/register", { method: "POST", body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(65_537)); controller.close(); } }) });
    expect((await guardRequest(oversized, config) as Response).status).toBe(413);
    const body = JSON.stringify({ title: "Music 🎵" });
    const accepted = await guardRequest(new Request("https://connector.test/mcp", { method: "POST", body }), config) as Request;
    expect(await accepted.text()).toBe(body);
  });
  it("enforces the configured native limiter in the local Workers runtime", async () => {
    const results = [];
    for (let i = 0; i < 21; i++) results.push(await enforceLimit(env.AUTH_LIMITER, "unique-limit-test"));
    expect(results.slice(0, 20).every(result => result === null)).toBe(true);
    expect(results[20]?.status).toBe(429);
  });
});
