import type { ReactNode } from "react";

import { Kbd } from "@/components/ui/kbd";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function HeaderIconButton({
  active,
  children,
  disabled,
  keys,
  label,
  onClick,
}: {
  active?: boolean;
  children: ReactNode;
  disabled?: boolean;
  keys?: string[];
  label: string;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        type="button"
        aria-label={label}
        aria-disabled={disabled ? true : undefined}
        disabled={disabled}
        tabIndex={disabled ? -1 : undefined}
        onClick={(event) => {
          if (disabled) {
            event.preventDefault();
            return;
          }
          onClick();
        }}
        className={[
          "desktop-toolbar-button inline-flex size-8 items-center justify-center rounded-lg border border-transparent text-muted-foreground transition-colors",
          active ? "bg-accent text-accent-foreground" : "hover:bg-muted hover:text-foreground",
          disabled ? "cursor-not-allowed opacity-40 hover:bg-transparent" : "",
        ].join(" ")}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {label}
        {keys && keys.length > 0 ? (
          <>
            {" "}
            {keys.map((key, index) => (
              <Kbd key={index}>{key}</Kbd>
            ))}
          </>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}
