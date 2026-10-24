import { PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";

import { Button } from "@/components/ui/button";
import {
  PanelCard,
  PanelContent,
  PanelEmptyState,
  PanelHeader,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils/utils";


interface CreateSidebarProps {
  icon: React.ReactNode;
  title: React.ReactNode;
  actions?: React.ReactNode;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  loading?: boolean;
  loadingFallback?: React.ReactNode;
  empty?: React.ReactNode;
  error?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
}

function CreateSidebar({
  icon,
  title,
  actions,
  searchValue,
  onSearchChange,
  searchPlaceholder,
  loading = false,
  loadingFallback,
  empty,
  error,
  children,
  className,
  contentClassName,
}: CreateSidebarProps) {
  const showSearch =
    searchValue !== undefined && onSearchChange !== undefined;

  return (
    <PanelCard className={cn("h-full", className)}>
      <PanelHeader icon={icon} title={title} actions={actions} />
      <PanelContent
        className={cn("overflow-y-auto px-3 py-3", contentClassName)}
      >
        {showSearch ? (
          <div className="relative mb-3">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={searchValue}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder={searchPlaceholder}
              className="h-8 pl-8 text-xs"
            />
          </div>
        ) : null}

        {loading ? (
          loadingFallback ?? <CreateSidebarLoading />
        ) : empty ? (
          <PanelEmptyState className="text-sm text-muted-foreground">
            {empty}
          </PanelEmptyState>
        ) : (
          children
        )}

        {error ? (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive">
            <span>{error}</span>
          </div>
        ) : null}
      </PanelContent>
    </PanelCard>
  );
}

function CreateSidebarLoading() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-14 w-full rounded-lg" />
      <Skeleton className="h-14 w-full rounded-lg" />
      <Skeleton className="h-14 w-full rounded-lg" />
    </div>
  );
}

function CreateSidebarSlot({
  open,
  children,
  className,
}: {
  open: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "shrink-0 transition-[width,margin-right] duration-200 ease-out",
        open ? "mr-4 w-70 overflow-visible" : "mr-0 w-0 overflow-hidden",
        className,
      )}
    >
      <div className="h-full w-70">
        {children}
      </div>
    </div>
  );
}

function CreateSidebarToggle({
  open,
  setOpen,
  labels,
}: {
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  labels: { hide: string; show: string };
}) {
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => setOpen((value) => !value)}
      aria-label={open ? labels.hide : labels.show}
    >
      {open ? (
        <PanelLeftClose className="size-4" />
      ) : (
        <PanelLeftOpen className="size-4" />
      )}
    </Button>
  );
}

export { CreateSidebar, CreateSidebarSlot, CreateSidebarToggle };
