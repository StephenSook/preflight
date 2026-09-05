import { resolve } from "node:path";
import { defineConfig } from "vite";

// Three entries, one app: the public site, the cockpit dashboard, and the page a phone opens.
// The engine is imported from its TypeScript source in every mode ("development" condition), so the
// browser runs the same code the tests run and no package build has to precede the web build.
export default defineConfig({
  resolve: { conditions: ["development"] },
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        site: resolve(__dirname, "index.html"),
        app: resolve(__dirname, "app/index.html"),
        phone: resolve(__dirname, "phone/index.html"),
      },
    },
  },
  server: {
    // In development the API is the deployed host unless VITE_API_URL says otherwise; the proxy keeps
    // the browser on one origin so the token and the event stream behave as they will in production.
    proxy: {
      "/api": { target: process.env["VITE_API_URL"] ?? "https://preflight-api-rc34.onrender.com", changeOrigin: true },
      "/health": { target: process.env["VITE_API_URL"] ?? "https://preflight-api-rc34.onrender.com", changeOrigin: true },
    },
  },
});
