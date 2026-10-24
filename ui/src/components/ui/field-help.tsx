import type { ReactNode } from "react";
import { Info } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils/utils";

/**
 * The small "i" affordance that explains a form field. One implementation for
 * every form in the app — pass `contentClassName` when the copy needs a wider
 * bubble than the default.
 */
export function FieldHelp({
  children,
  contentClassName,
  label,
}: {
  children: ReactNode;
  contentClassName?: string;
  label: string;
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          aria-label={label}
          render={<Button variant="ghost" size="icon-xs" className="size-5 text-muted-foreground" />}
        >
          <Info aria-hidden="true" className="size-3.5" />
        </TooltipTrigger>
        <TooltipContent
          side="top"
          align="start"
          className={cn("max-w-80 whitespace-normal text-left leading-relaxed", contentClassName)}
        >
          {children}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
