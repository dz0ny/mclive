// @ts-check
import { defineConfig, fontProviders } from "astro/config";
import { imageService } from "@unpic/astro/service";
import { defineConfig as viteConfig } from "vite";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import sitemap from "@astrojs/sitemap";
import favicons from "astro-favicons";
import pagefind from "astro-pagefind";
import { agentsSummary } from "@nuasite/agent-summary";
import { astroGrab } from "astro-grab";

// https://astro.build/config
export default defineConfig({
  site: "https://mclive.dz0ny.dev",
  output: "static",
  trailingSlash: "always",
  image: { service: imageService() },
  integrations: [
    react(),
    sitemap(),
    agentsSummary(),
    pagefind(),
    astroGrab(),
    favicons({
      input: "./src/assets/favicon.png",
      name: "Site",
      short_name: "Site Name",
    }),
  ],

  vite: viteConfig({
    cacheDir: ".astro/vite",
    plugins: [tailwindcss()],
    resolve: {
      alias: {
        "@": "/src",
      },
    },
  }),

  build: {
    concurrency: 4,
  },

  // No Cloudflare adapter: this is a static site served via Workers Static
  // Assets, with the custom worker in `worker/` (main + run_worker_first in
  // wrangler.toml) handling all /~/* dynamic routes (MQTT ingest, SSE, API).
  server: { port: 4321, host: "0.0.0.0", allowedHosts: true },
  devToolbar: { enabled: false },

  fonts: [],
});
