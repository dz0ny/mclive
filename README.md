# MeshCore Observatory

A live LoRa mesh observatory — observer firmware uplinks MeshCore packets over MQTT-over-WebSocket to a Cloudflare Worker (`PacketHub` Durable Object), which decodes them into D1 and streams nodes, packets, adverts, channels and observer status to the web app (Astro + OpenLayers + shadcn/ui).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/dz0ny/mclive)

> Scaffolded by [Hakuto](https://hakuto.dev/), a Claude Code plugin for building Astro sites with shadcn/ui and Cloudflare Workers.

## Develop

```sh
bun install
bun run dev
```

Open http://localhost:4321.

### Optional: devenv

This scaffold ships with a [devenv](https://devenv.sh) config (`devenv.nix`, `devenv.yaml`, `.envrc`) that declares `bun` and `wrangler`. If you use devenv, `devenv up` starts the dev server.

**Don't use devenv?** Delete `devenv.nix`, `devenv.yaml`, and `.envrc`. Nothing else depends on them.

## Build & deploy

```sh
bun run build        # → dist/
wrangler deploy      # → Cloudflare Workers
```

### Preview the built site

```sh
bun run build
bun run preview
```

`bun run dev` starts Astro's development server with live reload and dev-only behavior. `bun run preview` serves the production build from `dist/`, so use it for review before deploying.

Edit `wrangler.toml` to set the Worker name and custom domain:

```toml
name = "my-site"

[assets]
directory = "./dist"

[[routes]]
pattern = "example.com"
custom_domain = true
```

## Add an observer

The map and packet feed are populated by **observer nodes** — MeshCore devices
running the MQTT observer firmware ([`mc-mq`](https://github.com/dz0ny/mc-mq),
e.g. `pio run -e Heltec_Wireless_Paper_repeater_observer_mqtt -t upload`). An
observer hears LoRa traffic and uplinks each packet to this Worker over
MQTT-over-WebSocket. Point one at your deployment with a single DSN:

```
set mqtt.url0 wss://observer:<INGEST_TOKEN>@<your-worker-host>/mqtt
set mqtt.iata SEA          # region code, places the observer on the map
set bridge.source rx
```

`<INGEST_TOKEN>` must match the Worker's `INGEST_TOKEN` secret. You can fan out
to up to three sinks (`mqtt.url0`/`1`/`2`). New observers show up automatically
on the **Observers** page. Full setup (TLS, replay without hardware, topic
format) is in [`bridge/README.md`](./bridge/README.md).

## Stack

Astro 6 · Tailwind CSS v4 · shadcn/ui · TypeScript · Biome · Bun · Cloudflare Workers

## Working with Claude

`CLAUDE.md` at the repo root carries the agent spec. The Hakuto plugin provides skills (`website-builder`, `brand-designer`, `professional-copywriter`, `section-form`, `section-blog`, `section-docs`, `plausible-analytics`, `seo-audit`, `prelaunch-checklist`, `scaffold-sync`) that auto-invoke based on what you ask for.

Update the plugin with `/plugin update hakuto` inside Claude Code.
