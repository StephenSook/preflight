import Fastify from "fastify";
import { referenceApp } from "./index.js";

/** Standalone runner for local development; in production the plugin is mounted inside the Preflight service. */
const port = Number(process.env["PORT"] ?? 3232);
const app = Fastify({ logger: true });
app.addContentTypeParser(["application/json", "text/plain"], { parseAs: "string" }, (_req, body, done) => done(null, body));
await app.register(referenceApp, { selfBaseUrl: process.env["REFERENCE_BASE_URL"] ?? `http://127.0.0.1:${port}`, mode: (process.env["REFERENCE_MODE"] as "broken" | "fixed" | undefined) ?? "broken", adminToken: process.env["REFERENCE_ADMIN_TOKEN"] });
await app.listen({ port, host: "0.0.0.0" });
