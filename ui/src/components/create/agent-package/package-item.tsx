import { Loader2, Trash2 } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { PanelItem } from "@/components/ui/card";

export function PackageItem(props: {
  children: ReactNode;
  onReveal: () => void | Promise<void>;
  onRemove: () => void;
  removing: boolean;
  disabled: boolean;
}) {
  return (
    <PanelItem className="group/item relative overflow-hidden p-0 transition-colors hover:bg-muted/55">
      <Button
        variant="ghost"
        className="h-auto w-full flex-col items-stretch gap-0 px-3 py-2.5 pr-11 text-left font-normal hover:bg-transparent"
        onClick={() => void props.onReveal()}
        disabled={props.disabled}
      >
        {props.children}
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        className="absolute right-2 top-2 opacity-0 transition-opacity group-hover/item:opacity-100 focus-visible:opacity-100"
        onClick={(event) => {
          event.stopPropagation();
          props.onRemove();
        }}
        disabled={props.disabled}
        aria-label="Remove"
      >
        {props.removing ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <Trash2 className="size-3" />
        )}
      </Button>
    </PanelItem>
  );
}
