import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { ArrowDown, ArrowUp, ArrowUpDown, Check, Filter, X } from "lucide-react";

export function FilterButton({ active }: { active: boolean }) {
  return (
    <Filter
      className={cn(
        "size-3.5 transition-colors",
        active ? "text-primary fill-primary/20" : "text-muted-foreground/40 hover:text-foreground"
      )}
    />
  );
}

/** Column header with a text-search filter popover. */
export function TextFilterHead({
  label,
  value,
  onChange,
  placeholder,
  align = "start",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  align?: "start" | "end";
}) {
  return (
    <span className="flex items-center gap-1">
      {label}
      <Popover>
        <PopoverTrigger className="rounded p-0.5 outline-none">
          <FilterButton active={!!value} />
        </PopoverTrigger>
        <PopoverContent align={align} className="w-60 p-2">
          <div className="relative">
            <Input
              autoFocus
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder={placeholder}
              className="h-8 pr-7"
            />
            {value && (
              <button
                type="button"
                onClick={() => onChange("")}
                className="text-muted-foreground hover:text-foreground absolute right-2 top-1/2 -translate-y-1/2"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </span>
  );
}

/** Column header with a multi-select options filter popover. */
export function OptionFilterHead({
  label,
  active,
  onClear,
  children,
  align = "start",
}: {
  label: string;
  active: boolean;
  onClear: () => void;
  children: React.ReactNode;
  align?: "start" | "end";
}) {
  return (
    <span className="flex items-center gap-1">
      {label}
      <Popover>
        <PopoverTrigger className="rounded p-0.5 outline-none">
          <FilterButton active={active} />
        </PopoverTrigger>
        <PopoverContent align={align} className="w-48 p-1">
          <div className="max-h-64 space-y-0.5 overflow-y-auto">{children}</div>
          {active && (
            <button
              type="button"
              onClick={onClear}
              className="text-muted-foreground hover:bg-muted mt-1 w-full rounded px-2 py-1 text-left text-xs"
            >
              Clear filter
            </button>
          )}
        </PopoverContent>
      </Popover>
    </span>
  );
}

export function OptionRow({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="hover:bg-muted flex w-full items-center gap-2 rounded px-2 py-1.5 text-left"
    >
      <span
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded border",
          selected && "bg-primary border-primary text-primary-foreground"
        )}
      >
        {selected && <Check className="size-3" />}
      </span>
      {children}
    </button>
  );
}

export type SortDir = 1 | -1;

/** Column-header sort toggle: off → asc → desc → off. */
export function SortToggle({ dir, onClick }: { dir: SortDir | null; onClick: () => void }) {
  const Icon = dir === 1 ? ArrowUp : dir === -1 ? ArrowDown : ArrowUpDown;
  return (
    <button type="button" onClick={onClick} className="rounded p-0.5 outline-none" title="Sort">
      <Icon
        className={cn(
          "size-3.5 transition-colors",
          dir ? "text-primary" : "text-muted-foreground/40 hover:text-foreground"
        )}
      />
    </button>
  );
}

/** Toggle a value in a Set immutably. */
export function toggleInSet<T>(set: Set<T>, v: T): Set<T> {
  const next = new Set(set);
  next.has(v) ? next.delete(v) : next.add(v);
  return next;
}
