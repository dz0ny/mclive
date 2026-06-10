# MeshCore ingest

The MeshCore observer firmware (PsychicMqttClient) speaks **MQTT over WebSocket**
and connects **directly** to the Worker — there is no local bridge process. The
Worker's `PacketHub` Durable Object is a minimal MQTT broker at `/~/mqtt`: it
accepts the device's CONNECT, ACKs QoS-1 PUBLISHes, decodes the packet, persists
to D1, and fans out to the live page over SSE (`/~/stream`).

## Point a real device at the Worker

### Firmware (one-time)

The firmware in `~/mc-mq` configures each destination as a single **DSN URL** and
can fan out to up to **3** brokers at once (`mqtt.url0`, `mqtt.url1`, `mqtt.url2`),
each with its own client. A DSN is:

```
scheme://[user:password@]host[:port][/path]
```

Schemes & default ports: `mqtt`→1883, `mqtts`→8883, `ws`→80, `wss`→443. The DSN
is parsed once into the broker's connection URI + credentials (helper `parseDSN`
in `src/helpers/bridges/MQTTBridge.{h,cpp}`); changing it takes effect live, no
reboot required.

TLS: for the secure schemes (`wss`/`mqtts`) the firmware attaches the standard
Arduino root-CA bundle, so a publicly-trusted cert (e.g. the Worker's Cloudflare
cert) **validates automatically** — no per-cert configuration. Plaintext `ws`/
`mqtt` schemes use no TLS.

Build + flash the observer firmware, e.g.:

```bash
cd ~/mc-mq && pio run -e Heltec_v3_repeater_observer_mqtt -t upload
```

### Device console config

Fold the Worker's WS endpoint **and** credentials into one DSN. The password must
match the Worker's `INGEST_TOKEN`; a username is required for the firmware to send
credentials at all:

```
set mqtt.url0 wss://observer:<INGEST_TOKEN>@<your-worker-host>/mqtt
set mqtt.iata SEA
set bridge.source rx
reboot
```

Notes:
- Use the top-level `/mqtt` path (added to `run_worker_first`); `/~/mqtt` also works.
- The port comes from the scheme (`wss`→443, `ws`→80); override it by encoding a
  port in the DSN, e.g. `wss://observer:<token>@host:8884/mqtt`.
- For a plaintext/local broker use `ws://observer:<token>@<host>/mqtt` (no TLS).
- To mirror to a second sink, add `set mqtt.url1 <dsn>` (and `mqtt.url2`). Clear a
  slot with an empty value, e.g. `set mqtt.url1`.
- `get mqtt.urlN` echoes the DSN verbatim (password included); `get mqtt.status`
  shows `brokers: N/M connected`.

> The old per-field keys (`mqtt.server` / `mqtt.port` / `mqtt.username` /
> `mqtt.password`) and the built-in "Let's Mesh Analyzer" US/EU uplinks were
> removed — everything is a DSN now.

## Replay synthetic data (no device needed)

`replay.mjs` uses the real `mqtt` client library to publish to the same broker
endpoint, so it exercises the full path (MQTT framing → decode → D1 → SSE). It
emits adverts (with locations) plus flood traffic that hops through those nodes:

```bash
# Worker must be running (see repo: bun run build && bun run db:migrate && bun run dev:worker)
MQTT_WS_URL=ws://localhost:8787/~/mqtt INGEST_TOKEN=dev-local-token \
  bun run bridge:replay
```

### Topic / payload assumptions

- Topic: `meshcore/{IATA}/{DEVICE_KEY}/packets` — the IATA segment places the
  observing device on the map. Other leaves (`/status`, `/raw`) are ignored.
- Payload: the observer firmware's packet JSON (`origin`, `origin_id`,
  `timestamp`, `direction`, `packet_type`, `route`, `len`, `payload_len`, `raw`,
  `SNR`, `RSSI`, `hash`). The `raw` hex (full wire packet) is decoded server-side
  for node locations (adverts) and hop paths.
