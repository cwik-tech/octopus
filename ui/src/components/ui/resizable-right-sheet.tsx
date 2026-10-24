import { GripVertical } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { SheetContent } from "@/components/ui/sheet";
import { cn } from "@/lib/utils/utils";

interface ResizableRightSheetContentProps
  extends ComponentProps<typeof SheetContent> {
  defaultWidth?: number;
  minimumWidth?: number;
  open: boolean;
  resizeLabel: string;
  viewportMargin?: number;
}

export function ResizableRightSheetContent({
  children,
  className,
  defaultWidth = 768,
  minimumWidth = 420,
  open,
  resizeLabel,
  style,
  viewportMargin = 48,
  ...props
}: ResizableRightSheetContentProps) {
  const getMaximumWidth = useCallback(() => {
    if (typeof window === "undefined") return defaultWidth;
    return Math.max(minimumWidth, window.innerWidth - viewportMargin);
  }, [defaultWidth, minimumWidth, viewportMargin]);
  const clampWidth = useCallback(
    (value: number) => Math.min(Math.max(value, minimumWidth), getMaximumWidth()),
    [getMaximumWidth, minimumWidth],
  );
  const [width, setWidth] = useState(defaultWidth);
  const stopDraggingRef = useRef<(() => void) | null>(null);

  const stopDragging = useCallback(() => {
    stopDraggingRef.current?.();
    stopDraggingRef.current = null;
  }, []);

  useEffect(() => {
    if (!open) {
      stopDragging();
      return undefined;
    }

    const handleViewportResize = () => setWidth((current) => clampWidth(current));
    window.addEventListener("resize", handleViewportResize);
    handleViewportResize();
    return () => {
      window.removeEventListener("resize", handleViewportResize);
      stopDragging();
    };
  }, [clampWidth, open, stopDragging]);

  const handleResizePointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    event.preventDefault();
    stopDragging();
    const startX = event.clientX;
    const startWidth = width;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      setWidth(clampWidth(startWidth + startX - moveEvent.clientX));
    };
    const handlePointerUp = () => stopDragging();
    const cleanup = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    stopDraggingRef.current = cleanup;
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
  };

  return (
    <SheetContent
      {...props}
      // "desktop-shell" carries the app's thin scrollbar styling, which the
      // sheet would otherwise miss: its content renders in a portal, outside
      // the shell element those rules are scoped to.
      className={cn("desktop-shell max-w-[calc(100vw-1.5rem)]", className)}
      style={{
        ...style,
        maxWidth: "calc(100vw - 1.5rem)",
        width: `${clampWidth(width)}px`,
      }}
    >
      {open ? (
        <button
          aria-label={resizeLabel}
          className="absolute inset-y-0 left-0 z-10 flex w-4 -translate-x-1/2 cursor-ew-resize items-center justify-center text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          type="button"
          onPointerDown={handleResizePointerDown}
        >
          <span className="flex h-10 w-4 items-center justify-center rounded-md border border-border bg-background shadow-sm">
            <GripVertical className="size-3" />
          </span>
        </button>
      ) : null}
      {children}
    </SheetContent>
  );
}
