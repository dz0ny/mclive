# MeshCore ingest

The MeshCore observer firmware (PsychicMqttClient) speaks **MQTT over WebSocket**
and connects **directly** to the Worker — there is no local bridge process. The
Worker's `PacketHub` Durable Object is a minimal MQTT broker at `/~/mqtt`: it
accepts the device's CONNECT, ACKs QoS-1 PUBLISHes, decodes the packet, persists
to D1, and fans out to the live page over SSE (`/~/stream`).

## Point a real device at the Worker

### Firmware patch (one-time)

Stock MeshCore builds the custom broker URI as `mqtt://host:port` (raw TCP),
which a Cloudflare Worker can't accept — Workers only speak MQTT-over-WebSocket.
The patch in `~/mc-mq` (`src/helpers/bridges/MQTTBridge.{h,cpp}`, helper
`buildBrokerURI`) makes the firmware use the configured server **verbatim when it
already contains a URI scheme**, so you can set a `wss://…/mqtt` endpoint.

TLS: the custom-broker path configures no CA cert, so esp-tls **skips server
certificate verification** (accepts any cert) — no cert management needed.

Rebuild + flash the observer firmware, e.g.:

```bash
cd ~/mc-mq && pio run -e Heltec_v3_repeater_observer_mqtt -t upload
```

### Device console config

Set the custom MQTT server to the Worker's WS endpoint plus credentials (the
password must match the Worker's `INGEST_TOKEN`; a username is required for the
firmware to send credentials at all):

```
set mqtt.server wss://<your-worker-host>/mqtt
set mqtt.username observer
set mqtt.password <INGEST_TOKEN>
set mqtt.iata SEA
set bridge.source rx
reboot
```

Notes:
- Use the top-level `/mqtt` path (added to `run_worker_first`); `/~/mqtt` also works.
- The port is set internally from the scheme (`wss`→443, `ws`→80), so no
  separate `mqtt.port` is needed. Override it by encoding a port in the URI,
  e.g. `wss://host:8884/mqtt`.
- For a plaintext/local broker use `ws://<host>/mqtt` (no TLS).

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
