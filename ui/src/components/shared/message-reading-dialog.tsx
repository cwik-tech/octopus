import { Maximize2 } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { cn } from "@/lib/utils/utils";

export function MessageReadingDialog({
  children,
  title,
  header,
  className,
}: {
  children: ReactNode;
  title: string;
  header?: ReactNode;
  className?: string;
}) {
  return (
    <Dialog>
      <DialogTrigger render={
        <Button
          aria-label="Maximize message"
          className={cn("text-muted-foreground", className)}
          size="icon-xs"
          title="Maximize message"
          type="button"
          variant="ghost"
        />
      }>
        <Maximize2 aria-hidden="true" />
      </DialogTrigger>
      <DialogContent className="desktop-shell flex h-[92dvh] w-[92vw] max-w-none flex-col overflow-hidden bg-surface-sunken px-12 py-[calc(var(--spacing)*12*0.7)] sm:max-w-none">
        <DialogHeader className="shrink-0 pr-8">
          <DialogTitle className={header ? "sr-only" : "break-words leading-snug"}>{title}</DialogTitle>
          {header}
        </DialogHeader>
        <div className="min-h-0 min-w-0 flex-1 overflow-auto text-base leading-relaxed whitespace-normal wrap-anywhere [&>*]:h-auto [&>*]:max-w-none">
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}
