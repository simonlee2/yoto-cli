import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: { bindings: {
      ENROLLMENT_ENABLED: "true", WRITES_ENABLED: "true", UPLOADS_ENABLED: "true", PUBLIC_ORIGIN: "https://connector.test", YOTO_CLIENT_ID: "test-client",
      TOKEN_ENCRYPTION_KEY: btoa("a".repeat(32))
    } }
  })],
  test: { include: ["test/**/*.test.ts"] }
});
