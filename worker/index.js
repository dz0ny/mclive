/**
 * Cloudflare Workers entry point.
 *
 * Dynamic routes live under /~/* (wrangler `run_worker_first = ["/~*"]`); all
 * other paths are served as static Astro assets. A single PacketHub Durable
 * Object handles the live ingest WebSocket and SSE fan-out.
 */
import { Hono } from "hono";
import { api } from "./api.js";
import { PacketHub } from "./hub.js";
import { backfillAdvertPubkeys, backfillScopes, backfillCountries, purgeOldData } from "./cleanup.js";
import { rebuildCoverage } from "./coverage.js";

export { PacketHub };

const app = new Hono().basePath("/~");

// Read-only JSON API (no WebSocket — safe to run through Hono).
app.route("/api", api);

app.notFound((c) => c.text("Not found", 404));

function hub(env) {
  const id = env.PACKET_HUB.idFromName("global");
  return env.PACKET_HUB.get(id);
}

export default {
  fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    // Live endpoints are forwarded straight to the PacketHub DO. WebSocket (101)
    // upgrades must NOT pass through Hono, which would wrap the response and
    // detach the server socket.
    //   /mqtt (and /~/mqtt): observer firmware connects as an MQTT-over-WS
    //     client. PsychicMqttClient's analyzer servers use a top-level /mqtt
    //     path, so we accept both. /mqtt is added to run_worker_first too.
    //   /~/stream: browsers receive live packet/node events via SSE.
    if (pathname === "/mqtt" || pathname === "/~/mqtt" || pathname === "/~/stream") {
      return hub(env).fetch(request);
    }
    return app.fetch(request, env, ctx);
  },

  // Cron Triggers (see [triggers].crons in wrangler.toml):
  //   hourly  → refresh the GRP_DATA coverage aggregate (worker/coverage.js).
  //   daily   → also wipe traffic older than one week (adverts + directories are
  //             kept forever — worker/cleanup.js) and drain the advert_pubkey,
  //             scope and country backfills.
  async scheduled(event, env, ctx) {
    const tasks = [rebuildCoverage(env)];
    if (event.cron === "17 3 * * *") {
      tasks.push(
        purgeOldData(env)
          .then(() => backfillAdvertPubkeys(env))
          .then(() => backfillScopes(env))
          .then(() => backfillCountries(env))
      );
    }
    ctx.waitUntil(Promise.all(tasks));
  },
};
