import { useMemo, useRef } from "react";
import type { ReactNode, UIEvent } from "react";

import type { LineDiffResult } from "@/lib/utils/line-diff";
import { cn } from "@/lib/utils/utils";

interface PersonaMarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Line diff of the current value against the last saved baseline. When
   * null, only line numbers are shown. */
  diff: LineDiffResult | null;
  /** Called when focus leaves the text, e.g. to save what was typed. */
  onBlur?: () => void;
  /** Controls pinned to the editor's top-right corner. */
  actions?: ReactNode;
  className?: string;
}

const BAR_CLASS: Record<string, string> = {
  added: "bg-emerald-500",
  modified: "bg-amber-500",
};

export default function PersonaMarkdownEditor({
  value,
  onChange,
  diff,
  onBlur,
  actions,
  className,
}: PersonaMarkdownEditorProps) {
  const gutterInnerRef = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => value.split("\n"), [value]);
  const lineNumberDigits = String(lines.length).length;
  const deletionsByLine = useMemo(() => {
    const map = new Map<number, string[]>();
    for (const deletion of diff?.deletions ?? []) {
      const atLine = Math.min(deletion.atLine, lines.length - 1);
      map.set(atLine, [...(map.get(atLine) ?? []), ...deletion.lines]);
    }
    return map;
  }, [diff, lines.length]);

  const handleScroll = (event: UIEvent<HTMLTextAreaElement>) => {
    const gutter = gutterInnerRef.current;
    if (gutter) {
      gutter.style.transform = `translateY(${-event.currentTarget.scrollTop}px)`;
    }
  };

  return (
    <div className={cn("flex overflow-hidden", className)}>
      <div
        aria-hidden
        data-testid="persona-editor-gutter"
        style={{ width: `calc(${lineNumberDigits}ch + 11px)` }}
        // The transparent borders match the text frame's, so each number
        // stays level with its line.
        className="shrink-0 select-none overflow-hidden border-y border-transparent font-mono text-xs"
      >
        <div ref={gutterInnerRef} className="py-3 will-change-transform">
          {lines.map((_, index) => {
            const kind = diff?.kinds[index] ?? "unchanged";
            const removed = deletionsByLine.get(index);
            return (
              <div
                key={index}
                className="relative flex h-4.5 items-center justify-end gap-1 pr-1"
              >
                <span className="leading-4.5 text-muted-foreground/60 tabular-nums">
                  {index + 1}
                </span>
                <span
                  title={
                    kind === "added"
                      ? "Line added"
                      : kind === "modified"
                        ? "Line modified"
                        : undefined
                  }
                  className={cn(
                    "h-3 w-0.75 shrink-0 rounded-full",
                    BAR_CLASS[kind] ?? "bg-transparent",
                  )}
                />
                {removed ? (
                  <span
                    title={`Removed:\n${removed.join("\n")}`}
                    className="absolute top-0 right-0 h-0 w-0 border-y-3 border-l-5 border-y-transparent border-l-red-500"
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
      <div className="relative flex min-w-0 flex-1 overflow-hidden rounded-lg border border-border/60 bg-muted/40 focus-within:border-primary/40">
        <textarea
          aria-label="Persona markdown"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onScroll={handleScroll}
          onBlur={onBlur}
          wrap="off"
          spellCheck={false}
          className="min-h-0 flex-1 resize-none overflow-auto bg-transparent py-3 pr-3 pl-2 font-mono text-xs leading-4.5 whitespace-pre outline-none"
        />
        {actions ? (
          <div className="absolute top-1.5 right-4 flex items-center gap-1">
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  );
}
