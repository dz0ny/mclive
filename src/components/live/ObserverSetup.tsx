import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Public uplink for community observers. The password is the Worker's INGEST_TOKEN.
const DSN = "wss://observer:dccf072f3272f5c9479db8b174738b3990f502cd114ed989@mclive.dz0ny.dev/mqtt";

// Codes the worker can place on the map (worker/lib/iata.js).
const IATA_CODES =
  "LJU ZAG VCE VIE BUD MUC FRA BER PRG WAW ZRH AMS CDG LHR LGW DUB MAD BCN FCO CPH ARN OSL HEL SEA PDX SFO LAX SJC DEN ORD DFW ATL JFK EWR BOS IAD MIA YVR YYZ NRT HND SIN HKG SYD AKL DXB".split(
    " "
  );

const CONSOLE = `set mqtt.url0 ${DSN}
set mqtt.iata LJU
set bridge.source rx
reboot`;

const TOPIC = "meshcore/{IATA}/{DEVICE_PUBKEY}/packets";

const PAYLOAD = `{
  "origin": "My Observer",
  "origin_id": "<device pubkey, hex>",
  "timestamp": "2026-10-07T12:00:00Z",
  "direction": "rx",
  "raw": "<full wire packet, hex>",
  "SNR": 6.25,
  "RSSI": -92,
  "hash": "<packet hash, hex>"
}`;

export default function ObserverSetup() {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <ol className="min-w-0 space-y-6">
        <Step n={1} title="Flash the observer firmware">
          <p>
            Observers are MeshCore repeaters running the MQTT observer build of{" "}
            <a href="https://github.com/dz0ny/mc-mq" className="underline underline-offset-2">
              mc-mq
            </a>
            . They hear LoRa traffic and uplink every packet here over MQTT-over-WebSocket.
          </p>
          <Code text="pio run -e Heltec_v3_repeater_observer_mqtt -t upload" />
        </Step>

        <Step n={2} title="Point it at mclive">
          <p>
            Paste these commands into the device console (serial or the companion app). Set{" "}
            <code className="font-mono text-xs">mqtt.iata</code> to the airport code closest to the
            observer — it places the observer on the map.
          </p>
          <Code text={CONSOLE} />
          <p className="text-muted-foreground text-xs">
            You can mirror to two more brokers with <code className="font-mono">mqtt.url1</code> and{" "}
            <code className="font-mono">mqtt.url2</code>. The DSN takes effect live; the reboot only
            makes sure everything is fresh.
          </p>
        </Step>

        <Step n={3} title="Check that it is connected">
          <Code text="get mqtt.status" />
          <p>
            It should report <code className="font-mono text-xs">brokers: 1/1 connected</code>. The
            observer appears on the <span className="font-medium">Status</span> tab after its first
            status report or packet. Observers that stay silent for 7 days are removed automatically
            and come back when they report again.
          </p>
        </Step>

        <Step n={4} title="Publishing from your own client (optional)">
          <p>
            Any MQTT client that speaks MQTT over WebSocket can publish with the same DSN (user{" "}
            <code className="font-mono text-xs">observer</code>, the token as password). Publish one
            JSON message per received packet to:
          </p>
          <Code text={TOPIC} />
          <Code text={PAYLOAD} />
          <p className="text-muted-foreground text-xs">
            The server decodes <code className="font-mono">raw</code> itself. Send the MeshCore packet{" "}
            <code className="font-mono">hash</code> too, so reports of the same packet from different
            observers merge into one row. A <code className="font-mono">…/status</code> topic with{" "}
            <code className="font-mono">stats.uptime_secs</code>, <code className="font-mono">model</code>{" "}
            and <code className="font-mono">firmware_version</code> fills in the status columns.
          </p>
        </Step>
      </ol>

      <aside className="space-y-4">
        <div className="rounded-lg border p-4">
          <h3 className="text-muted-foreground mb-2 text-xs font-semibold uppercase tracking-wide">Broker</h3>
          <dl className="space-y-1 text-sm">
            <Row k="Host" v="mclive.dz0ny.dev" />
            <Row k="Port" v="443 (wss)" />
            <Row k="Path" v="/mqtt" />
            <Row k="User" v="observer" />
          </dl>
          <div className="mt-3">
            <Code text={DSN} wrap />
          </div>
        </div>
        <div className="rounded-lg border p-4">
          <h3 className="text-muted-foreground mb-2 text-xs font-semibold uppercase tracking-wide">
            Region codes
          </h3>
          <p className="text-muted-foreground mb-2 text-xs">Codes the map can place today:</p>
          <div className="flex flex-wrap gap-1">
            {IATA_CODES.map((c) => (
              <span key={c} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                {c}
              </span>
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-4">
      <span className="bg-primary text-primary-foreground flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold">
        {n}
      </span>
      <div className="min-w-0 flex-1 space-y-2 text-sm">
        <h2 className="text-base font-semibold">{title}</h2>
        {children}
      </div>
    </li>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="font-mono text-xs">{v}</dd>
    </div>
  );
}

function Code({ text, wrap = false }: { text: string; wrap?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };
  return (
    <div className="group relative">
      <pre
        className={cn(
          "bg-muted overflow-x-auto rounded-md p-3 pr-16 font-mono text-xs leading-relaxed",
          wrap ? "break-all whitespace-pre-wrap" : "whitespace-pre"
        )}
      >
        {text}
      </pre>
      <Button
        variant="outline"
        size="sm"
        onClick={copy}
        className="absolute top-2 right-2 h-7 px-2 text-xs"
        aria-label="Copy to clipboard"
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
