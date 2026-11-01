import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        main: "./src/index.ts",
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            ZONE_NAME: "dyn.example.test",
            CF_ZONE_ID: "zone1",
            CF_API_TOKEN: "cf-test-token",
            // Overrides .dev.vars, which points local dev at a fake API.
            CF_API_BASE: "https://api.cloudflare.com/client/v4",
            AGENT_TOKEN: "agent-secret",
            DYN_USERNAME: "dynuser",
            DYN_UPDATER_KEY: "dynkey",
            ADMIN_AUTH_DISABLED: "true",
            // Pinned so a local .dev.vars never changes what the tests see.
            PANEL_LANG: "en",
            TIME_ZONE: "UTC",
            NTP_PORTS: "55123-55199",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"] },
  };
});
