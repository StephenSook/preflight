import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

// Local runs read .env (DATABASE_URL for the integration suite). Variables already set in the
// environment win, so CI secrets are never shadowed by a stray local file.
if (existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    reporters: process.env.CI ? ["verbose"] : ["default"],
    passWithNoTests: false,
  },
});
