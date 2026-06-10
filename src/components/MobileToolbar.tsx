import { useEffect, useState } from "react";
import { Radio, Map as MapIcon, Megaphone, Hash, Palette, Sun, Moon, Check } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Packets", Icon: Radio },
  { href: "/map/", label: "Map", Icon: MapIcon },
  { href: "/adverts/", label: "Adverts", Icon: Megaphone },
  { href: "/channels/", label: "Channels", Icon: Hash },
] as const;

const PALETTES: [string, string][] = [
  ["nord", "Nord"],
  ["tokyo", "Tokyo Night"],
  ["catppuccin", "Catppuccin"],
  ["rosepine", "Rosé Pine"],
];

export default function MobileToolbar({ path }: { path: string }) {
  const norm = path.replace(/\/+$/, "") || "/";
  const isActive = (h: string) => {
    const t = h.replace(/\/+$/, "") || "/";
    return t === "/" ? norm === "/" : norm.startsWith(t);
  };

  const [dark, setDark] = useState(false);
  const [pal, setPal] = useState("nord");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
    setPal(document.documentElement.dataset.theme || "nord");
  }, []);

  const toggleDark = () => {
    const d = document.documentElement.classList.toggle("dark");
    setDark(d);
    try {
      localStorage.setItem("mclive.theme", d ? "dark" : "light");
    } catch {}
  };
  const applyPalette = (v: string) => {
    if (v === "nord") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = v;
    setPal(v);
    try {
      localStorage.setItem("mclive.palette", v);
    } catch {}
  };

  const tab = "flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-medium";

  return (
    <nav className="bg-card/95 supports-[backdrop-filter]:bg-card/75 z-50 flex shrink-0 border-t backdrop-blur md:hidden">
      {NAV.map(({ href, label, Icon }) => {
        const active = isActive(href);
        return (
          <a
            key={href}
            href={href}
            className={cn(tab, "relative", active ? "text-primary" : "text-muted-foreground")}
          >
            {active && <span className="bg-primary absolute inset-x-5 top-0 h-0.5 rounded-full" />}
            <Icon className="size-5" />
            {label}
          </a>
        );
      })}

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger className={cn(tab, "text-muted-foreground")}>
          <Palette className="size-5" />
          Theme
        </SheetTrigger>
        <SheetContent side="bottom" className="rounded-t-2xl pb-8">
          <SheetHeader>
            <SheetTitle>Appearance</SheetTitle>
          </SheetHeader>

          <div className="space-y-5 py-4">
            <div>
              <p className="text-muted-foreground mb-2 text-xs font-semibold uppercase tracking-wide">
                Palette
              </p>
              <div className="grid grid-cols-2 gap-2">
                {PALETTES.map(([v, name]) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => applyPalette(v)}
                    className={cn(
                      "flex items-center justify-between rounded-lg border px-3 py-2.5 text-sm transition-colors",
                      pal === v ? "border-primary bg-primary/10 text-primary" : "hover:bg-muted"
                    )}
                  >
                    {name}
                    {pal === v && <Check className="size-4" />}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="text-muted-foreground mb-2 text-xs font-semibold uppercase tracking-wide">
                Variant
              </p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => dark && toggleDark()}
                  className={cn(
                    "flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm",
                    !dark ? "border-primary bg-primary/10 text-primary" : "hover:bg-muted"
                  )}
                >
                  <Sun className="size-4" /> Light
                </button>
                <button
                  type="button"
                  onClick={() => !dark && toggleDark()}
                  className={cn(
                    "flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm",
                    dark ? "border-primary bg-primary/10 text-primary" : "hover:bg-muted"
                  )}
                >
                  <Moon className="size-4" /> Dark
                </button>
              </div>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </nav>
  );
}
