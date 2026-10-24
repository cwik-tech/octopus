import { Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils/utils";

interface SidebarSearchProps {
  label: string;
  onSearch: (query: string) => void;
  placeholder?: string | undefined;
}

const MINIMUM_SEARCH_LENGTH = 3;
const EMPTY_SEARCH_CLOSE_DELAY_MS = 5_000;

/** A right-aligned trigger that expands across the sidebar only when needed. */
export function SidebarSearch({ label, onSearch, placeholder }: SidebarSearchProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const closeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(
    () => () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
      }
    },
    [],
  );

  const cancelPendingClose = () => {
    if (closeTimerRef.current === null) return;

    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };

  const close = () => {
    cancelPendingClose();
    setDraft("");
    setOpen(false);
    onSearch("");
  };

  const updateSearch = (value: string) => {
    cancelPendingClose();
    setDraft(value);
    const query = value.trim();
    onSearch(query.length >= MINIMUM_SEARCH_LENGTH ? query : "");
  };

  const scheduleClose = () => {
    if (draft || closeTimerRef.current !== null) return;

    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false);
      closeTimerRef.current = null;
    }, EMPTY_SEARCH_CLOSE_DELAY_MS);
  };

  return (
    <div
      className="pointer-events-none absolute inset-x-2 top-0 h-7"
      onMouseEnter={cancelPendingClose}
      onMouseLeave={scheduleClose}
    >
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label={`Search ${label}`}
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className={cn(
          "pointer-events-auto absolute right-0 top-0 text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          open && "pointer-events-none opacity-0",
        )}
      >
        <Search className="size-3.5" />
      </Button>

      <form
        className={cn(
          "absolute right-0 top-0 flex h-7 origin-right items-center overflow-hidden rounded-md bg-sidebar transition-[width,opacity] duration-200 ease-out motion-reduce:transition-none",
          open ? "pointer-events-auto w-full opacity-100" : "pointer-events-none w-0 opacity-0",
        )}
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <Input
          ref={inputRef}
          type="text"
          role="searchbox"
          value={draft}
          onChange={(event) => updateSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              close();
            }
          }}
          aria-label={`Search ${label}`}
          placeholder={placeholder ?? `Search ${label.toLowerCase()}…`}
          className="h-7 min-w-0 flex-1 border-0 bg-transparent px-2 text-xs shadow-none focus-visible:border-0 focus-visible:ring-0"
        />
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Clear search"
          onClick={close}
          className="mr-1 shrink-0 text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          <X className="size-3.5" />
        </Button>
      </form>
    </div>
  );
}
