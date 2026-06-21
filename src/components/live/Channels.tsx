import { useEffect, useMemo, useRef, useState } from "react";
import { useLiveFeed } from "./useLiveFeed";
import { usePacketDetail } from "./usePacketDetail";
import PacketDetailSheet from "./PacketDetail";
import { StatusPill } from "./ui-bits";
import type { Packet } from "@/lib/meshcore";
import {
  defaultChannels,
  deriveChannel,
  decodeGroupText,
  decodeGroupData,
  type Channel,
  type ChannelKind,
  type ChannelMessage,
} from "@/lib/channel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDateTime, formatTime, nodeForHash } from "@/lib/meshcore";
import { Hash, X, Lock, Radio, MessagesSquare, MapPin, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { useUrlString } from "./useUrlState";

// A channel timeline interleaves decoded text (GRP_TXT) and fast-GPS location
// updates (GRP_DATA) — a discriminated union so each renders distinctly.
type TextEntry = ChannelMessage & { kind: "text"; id: number; received_at: number };
type LocEntry = {
  kind: "loc";
  channel: string;
  sender: string;
  lat: number;
  lon: number;
  speed: number; // sender's ground speed, km/h (0 = stationary/unknown)
  id: number;
  received_at: number;
};
type Entry = TextEntry | LocEntry;

const STORAGE_KEY = "mclive.channels";

function loadStored(): { name: string; psk: string }[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
function saveStored(list: { name: string; psk: string }[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

function KindIcon({ kind, className }: { kind?: ChannelKind; className?: string }) {
  const Icon = kind === "public" ? Radio : kind === "private" ? Lock : Hash;
  return <Icon className={className} />;
}

export default function Channels() {
  const { packets, nodes, status } = useLiveFeed();
  const { selectedId, detail, loading, open, close } = usePacketDetail();
  const [channels, setChannels] = useState<Channel[]>([]);
  // active channel lives in the URL (?ch=) so a channel view is shareable
  const [active, setActive] = useUrlString("ch", "all");
  const [mode, setMode] = useState<"hashtag" | "private">("hashtag");
  const [name, setName] = useState("");
  const [psk, setPsk] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [history, setHistory] = useState<Packet[]>([]); // GRP_TXT from the last 24h
  const [locHistory, setLocHistory] = useState<Packet[]>([]); // GRP_DATA from the last 24h
  const inited = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (inited.current) return;
    inited.current = true;
    (async () => {
      const defaults = await defaultChannels();
      const stored = (
        await Promise.all(loadStored().map((c) => deriveChannel(c.name, c.psk)))
      ).filter(Boolean) as Channel[];
      // a user-added channel shadows a default of the same name
      const storedNames = new Set(stored.map((c) => c.name.toLowerCase()));
      setChannels([
        ...defaults.filter((d) => d.isPublic || !storedNames.has(d.name.toLowerCase())),
        ...stored,
      ]);
    })();
  }, []);

  // Load the last 24h of group-text and location packets (the live feed only
  // keeps ~200) — type 5 is GRP_TXT, type 6 is GRP_DATA (fast-GPS beacons).
  useEffect(() => {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    fetch(`/~/api/packets?type=5&since=${since}&limit=2000`)
      .then((r) => r.json())
      .then((d) => setHistory(d.packets ?? []))
      .catch(() => {});
    fetch(`/~/api/packets?type=6&since=${since}&limit=2000`)
      .then((r) => r.json())
      .then((d) => setLocHistory(d.packets ?? []))
      .catch(() => {});
  }, []);

  function persist(list: Channel[]) {
    saveStored(
      list.filter((c) => !c.builtin).map((c) => ({ name: c.name, psk: c.kind === "private" ? c.psk : "" }))
    );
  }

  async function addChannel(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError("Enter a channel name");
    if (mode === "private" && !psk.trim()) return setError("Enter the base64 PSK");
    const ch = await deriveChannel(name, mode === "private" ? psk.trim() : undefined);
    if (!ch) return setError("Invalid PSK — base64 for a 16- or 32-byte key");
    setChannels((prev) => {
      // adding a name that matches a default replaces it with the user's version
      const next = [...prev.filter((c) => c.name !== ch.name || c.isPublic), ch];
      persist(next);
      return next;
    });
    setActive(ch.name);
    setName("");
    setPsk("");
    setAdding(false);
  }

  function removeChannel(n: string) {
    setChannels((prev) => {
      const next = prev.filter((c) => c.name !== n || c.builtin);
      persist(next);
      return next;
    });
    if (active === n) setActive("all");
  }

  // Merge 24h history with the live feed (dedup by packet id), then decode each
  // GRP_TXT into a text entry and each GRP_DATA fast-GPS beacon into a location
  // entry — interleaved oldest-first like a chat.
  const entries = useMemo<Entry[]>(() => {
    if (channels.length === 0) return [];
    const out: Entry[] = [];

    const txt = new Map<number, Packet>();
    for (const p of history) if (p.payload_type === 5 && p.raw) txt.set(p.id ?? 0, p);
    for (const p of packets) if (p.payload_type === 5 && p.raw) txt.set(p.id ?? 0, p);
    for (const p of txt.values()) {
      const m = decodeGroupText(p.raw!, channels);
      if (m) out.push({ kind: "text", ...m, id: p.id ?? 0, received_at: p.last_seen });
    }

    const loc = new Map<number, Packet>();
    for (const p of locHistory) if (p.payload_type === 6 && p.raw) loc.set(p.id ?? 0, p);
    for (const p of packets) if (p.payload_type === 6 && p.raw) loc.set(p.id ?? 0, p);
    for (const p of loc.values()) {
      const d = decodeGroupData(p.raw!, channels);
      if (!d?.location) continue;
      const node = nodeForHash(d.location.pubkeyPrefix, nodes);
      out.push({
        kind: "loc",
        channel: d.channel,
        sender: node?.name || d.location.pubkeyPrefix.slice(0, 12),
        lat: d.location.lat,
        lon: d.location.lon,
        speed: d.location.speed,
        id: p.id ?? 0,
        received_at: p.last_seen,
      });
    }

    return out.sort((a, b) => a.received_at - b.received_at); // oldest first for chat
  }, [history, locHistory, packets, channels, nodes]);

  const shown = active === "all" ? entries : entries.filter((m) => m.channel === active);
  const countFor = (n: string) => entries.filter((m) => m.channel === n).length;
  const activeChannel = channels.find((c) => c.name === active) || null;

  // auto-scroll to newest
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [shown.length]);

  return (
    <div className="flex h-full flex-col gap-4 p-4 md:p-6">
      <header className="flex shrink-0 items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Channels</h1>
        <StatusPill status={status} />
      </header>

      {/* mobile: horizontal channel tab bar (always visible) */}
      <div className="shrink-0 space-y-2 md:hidden">
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          <ChannelChip label="All" active={active === "all"} count={entries.length} onClick={() => setActive("all")} />
          {channels.map((c) => (
            <ChannelChip
              key={c.name}
              icon={<KindIcon kind={c.kind} className="size-3.5 opacity-80" />}
              label={c.kind === "public" ? "Public" : c.kind === "hashtag" ? `#${c.name}` : c.name}
              count={countFor(c.name)}
              active={active === c.name}
              onClick={() => setActive(c.name)}
              onRemove={c.builtin ? undefined : () => removeChannel(c.name)}
            />
          ))}
          <button
            type="button"
            onClick={() => setAdding((a) => !a)}
            className="bg-muted text-muted-foreground inline-flex shrink-0 items-center gap-1 rounded-full border px-3 py-1 text-sm"
          >
            <Plus className="size-3.5" /> Add
          </button>
        </div>
        {adding && <AddChannelForm {...{ mode, setMode, name, setName, psk, setPsk, error, addChannel, setAdding, setError }} />}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border md:flex-row">
        {/* desktop sidebar: channel list */}
        <aside className="bg-muted/30 hidden shrink-0 flex-col border-r md:flex md:w-60">
          <div className="text-muted-foreground px-3 pt-3 pb-1 text-xs font-semibold uppercase tracking-wide">
            Channels
          </div>
          <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-2">
            <ChannelRow
              icon={<MessagesSquare className="size-4 opacity-80" />}
              label="All"
              count={entries.length}
              active={active === "all"}
              onClick={() => setActive("all")}
            />
            {channels.map((c) => (
              <ChannelRow
                key={c.name}
                icon={<KindIcon kind={c.kind} className="size-4 opacity-80" />}
                label={c.kind === "public" ? "Public" : c.kind === "hashtag" ? `#${c.name}` : c.name}
                count={countFor(c.name)}
                active={active === c.name}
                onClick={() => setActive(c.name)}
                onRemove={c.builtin ? undefined : () => removeChannel(c.name)}
              />
            ))}
          </div>

          {/* add channel (desktop) */}
          <div className="border-t p-2">
            {!adding ? (
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="text-muted-foreground hover:bg-muted hover:text-foreground flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm"
              >
                <Plus className="size-4" /> Add channel
              </button>
            ) : (
              <AddChannelForm {...{ mode, setMode, name, setName, psk, setPsk, error, addChannel, setAdding, setError }} />
            )}
          </div>
        </aside>

        {/* messages */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b px-4 py-3">
            {activeChannel ? (
              <KindIcon kind={activeChannel.kind} className="size-4 opacity-70" />
            ) : (
              <MessagesSquare className="size-4 opacity-70" />
            )}
            <span className="font-semibold">
              {activeChannel
                ? activeChannel.kind === "public"
                  ? "Public"
                  : activeChannel.kind === "hashtag"
                    ? `#${activeChannel.name}`
                    : activeChannel.name
                : "All channels"}
            </span>
            {activeChannel && (
              <span className="text-muted-foreground font-mono text-xs">key {activeChannel.psk.slice(0, 10)}…</span>
            )}
            <span className="text-muted-foreground ml-auto text-xs tabular-nums">{shown.length} entries</span>
          </div>

          <div className="flex-1 space-y-2 overflow-y-auto p-4">
            {shown.length === 0 && (
              <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
                No decoded messages or locations yet.
              </div>
            )}
            {shown.map((m) => (
              <button
                key={`${m.kind}-${m.channel}-${m.id}`}
                type="button"
                onClick={() => m.id && open(m.id)}
                className={cn(
                  "block w-full rounded-lg border px-3 py-2 text-left transition-colors hover:bg-muted/50",
                  m.kind === "loc" && "border-amber-500/30 bg-amber-500/5",
                  selectedId === m.id && "bg-muted/60"
                )}
              >
                <div className="flex items-baseline gap-2">
                  {m.kind === "loc" && <MapPin className="size-3.5 shrink-0 self-center text-amber-500" />}
                  <span className="font-semibold">{m.sender ?? "unknown"}</span>
                  {active === "all" && (
                    <span className="text-muted-foreground font-mono text-xs">{m.channel}</span>
                  )}
                  <span className="text-muted-foreground ml-auto text-xs tabular-nums" title={formatDateTime(m.received_at)}>
                    {formatTime(m.received_at)}
                  </span>
                </div>
                {m.kind === "text" ? (
                  <p className="mt-0.5 break-words text-sm">{m.text}</p>
                ) : (
                  <p className="text-muted-foreground mt-0.5 flex items-center gap-1.5 text-sm">
                    <span>shared GPS location</span>
                    <span className="text-foreground font-mono text-xs">
                      {m.lat.toFixed(5)}, {m.lon.toFixed(5)}
                    </span>
                    {m.speed > 0 && (
                      <span className="font-mono text-xs">· {m.speed} km/h</span>
                    )}
                  </p>
                )}
              </button>
            ))}
            <div ref={endRef} />
          </div>
        </main>
      </div>

      <PacketDetailSheet
        open={selectedId != null}
        loading={loading}
        detail={detail}
        onOpenChange={(o) => {
          if (!o) close();
        }}
      />
    </div>
  );
}

function ChannelChip({
  icon,
  label,
  count,
  active,
  onClick,
  onRemove,
}: {
  icon?: React.ReactNode;
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  onRemove?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex min-h-9 shrink-0 touch-manipulation items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm",
        active ? "bg-primary text-primary-foreground" : "bg-card"
      )}
    >
      {icon}
      <span>{label}</span>
      <span className="tabular-nums opacity-70">{count}</span>
      {onRemove && (
        <X
          className="-m-1.5 box-content size-3.5 p-1.5 opacity-60"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        />
      )}
    </button>
  );
}

type AddFormProps = {
  mode: "hashtag" | "private";
  setMode: (m: "hashtag" | "private") => void;
  name: string;
  setName: (v: string) => void;
  psk: string;
  setPsk: (v: string) => void;
  error: string | null;
  addChannel: (e: React.FormEvent) => void;
  setAdding: (v: boolean) => void;
  setError: (v: string | null) => void;
};

function AddChannelForm({ mode, setMode, name, setName, psk, setPsk, error, addChannel, setAdding, setError }: AddFormProps) {
  return (
    <form onSubmit={addChannel} className="space-y-2">
      <div className="inline-flex w-full rounded-md border p-0.5 text-xs">
        <button
          type="button"
          onClick={() => setMode("hashtag")}
          className={cn("inline-flex flex-1 items-center justify-center gap-1 rounded px-2 py-1", mode === "hashtag" ? "bg-primary text-primary-foreground" : "text-muted-foreground")}
        >
          <Hash className="size-3" /> Hashtag
        </button>
        <button
          type="button"
          onClick={() => setMode("private")}
          className={cn("inline-flex flex-1 items-center justify-center gap-1 rounded px-2 py-1", mode === "private" ? "bg-primary text-primary-foreground" : "text-muted-foreground")}
        >
          <Lock className="size-3" /> Private
        </button>
      </div>
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={mode === "hashtag" ? "hashtag name" : "channel name"} className="h-8" autoFocus />
      {mode === "private" && (
        <Input value={psk} onChange={(e) => setPsk(e.target.value)} placeholder="PSK (base64)" className="h-8 font-mono text-xs" />
      )}
      {error && <p className="text-destructive text-xs">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" className="h-7 flex-1">Add</Button>
        <Button type="button" size="sm" variant="ghost" className="h-7" onClick={() => { setAdding(false); setError(null); }}>Cancel</Button>
      </div>
      <p className="text-muted-foreground text-[11px] leading-snug">
        {mode === "hashtag" ? 'Key = SHA256("#name")[:16]' : "Exact base64 secret you paste."}
      </p>
    </form>
  );
}

function ChannelRow({
  icon,
  label,
  count,
  active,
  onClick,
  onRemove,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  onRemove?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={cn(
        "group flex shrink-0 cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm md:w-full md:border-0 md:px-2",
        active ? "bg-primary text-primary-foreground" : "hover:bg-muted"
      )}
    >
      {icon}
      <span className="truncate md:flex-1">{label}</span>
      <span className="text-xs tabular-nums opacity-70">{count}</span>
      {onRemove && (
        <X
          className="size-3 opacity-0 transition-opacity group-hover:opacity-70 hover:!opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        />
      )}
    </div>
  );
}
