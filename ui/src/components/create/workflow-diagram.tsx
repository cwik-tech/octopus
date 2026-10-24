import { Maximize2, Workflow } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils/utils";
import { formatDisplayName } from "@/lib/utils/display-name";
import type { StepDraft } from "@/lib/models/workflow-generator-model";

interface WorkflowDiagramProps {
  source: string | null;
  steps?: StepDraft[];
  selectedStepId?: string | null;
  onStepSelect?: (stepId: string) => void;
  className?: string;
}

let mermaidInitialised = false;

async function getMermaid(): Promise<typeof import("mermaid").default> {
  const mod = await import("mermaid");
  if (!mermaidInitialised) {
    mod.default.initialize({
      startOnLoad: false,
      theme: "neutral",
      flowchart: { htmlLabels: true, curve: "basis" },
      securityLevel: "strict",
    });
    mermaidInitialised = true;
  }
  return mod.default;
}

function WorkflowDiagram({
  source,
  steps = [],
  selectedStepId,
  onStepSelect,
  className,
}: WorkflowDiagramProps) {
  const hasSource = !!source && source.trim().length > 0;

  return (
    <div
      className={cn(
        "relative flex min-h-55 flex-col items-center justify-center gap-3 overflow-auto rounded-lg border border-border/60 bg-background/70 p-4",
        className,
      )}
    >
      {hasSource ? (
        <>
          <DiagramSvg
            source={source}
            steps={steps}
            selectedStepId={selectedStepId}
            onStepSelect={onStepSelect}
          />
          {steps.length > 0 && onStepSelect ? (
            <div className="flex max-w-full flex-wrap items-center justify-center gap-1.5 pr-8">
              {steps.map((step) => (
                <Button
                  key={step.id}
                  variant="ghost"
                  size="xs"
                  onClick={() => onStepSelect(step.id)}
                  className={[
                    "h-auto border px-2 py-1 font-mono font-normal",
                    selectedStepId === step.id
                      ? "border-primary/40 bg-primary/10 text-foreground hover:bg-primary/10"
                      : "border-border/60 bg-background/80 text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                  ].join(" ")}
                >
                  {formatDisplayName(step.id)}
                </Button>
              ))}
            </div>
          ) : null}
          <Dialog>
            <DialogTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Maximize diagram"
                  className="absolute top-2 right-2 bg-background/70 backdrop-blur"
                />
              }
            >
              <Maximize2 className="size-3.5" />
            </DialogTrigger>
            <DialogContent className="flex h-[90vh] max-h-[90vh] w-[95vw] max-w-[95vw] flex-col gap-3 sm:max-w-[95vw]">
              <DialogTitle className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                Workflow Preview
              </DialogTitle>
              <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-lg border border-border/60 bg-background/70 p-4">
                <DiagramSvg
                  source={source}
                  steps={steps}
                  selectedStepId={selectedStepId}
                  onStepSelect={onStepSelect}
                />
              </div>
            </DialogContent>
          </Dialog>
        </>
      ) : (
        <DiagramEmptyState />
      )}
    </div>
  );
}

function DiagramEmptyState() {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-8 text-center">
      <div className="rounded-full bg-muted/60 p-3">
        <Workflow className="size-5 text-muted-foreground" />
      </div>
      <div className="max-w-xs space-y-1">
        <div className="text-sm font-medium text-foreground">
          No workflow yet
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Describe what you want to build — the diagram will appear here as
          you and the architect agree on the steps.
        </p>
      </div>
    </div>
  );
}

function DiagramSvg({
  source,
  steps,
  selectedStepId,
  onStepSelect,
}: {
  source: string;
  steps: StepDraft[];
  selectedStepId?: string | null | undefined;
  onStepSelect?: ((stepId: string) => void) | undefined;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [renderId] = useState(
    () => `wf-diagram-${crypto.randomUUID()}`,
  );

  useEffect(() => {
    let cancelled = false;

    async function render() {
      try {
        const mermaid = await getMermaid();
        const { svg } = await mermaid.render(renderId, source);
        if (cancelled) return;
        // Mermaid returns SVG containing foreignObject with HTML labels
        // (e.g. <br>). Parse in 'text/html' mode — more lenient than
        // 'image/svg+xml' for mixed HTML-in-SVG content — then locate the
        // <svg> element and append it (avoids innerHTML).
        const parser = new DOMParser();
        const parsed = parser.parseFromString(svg, "text/html");
        const svgRoot = parsed.querySelector("svg");
        if (!svgRoot) {
          throw new Error("Mermaid did not return an SVG root element");
        }
        bindStepNodes(svgRoot, steps, selectedStepId, onStepSelect);
        if (ref.current) {
          while (ref.current.firstChild) {
            ref.current.removeChild(ref.current.firstChild);
          }
          ref.current.appendChild(svgRoot);
        }
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        if (ref.current) {
          while (ref.current.firstChild) {
            ref.current.removeChild(ref.current.firstChild);
          }
        }
      }
    }

    void render();

    return () => {
      cancelled = true;
    };
  }, [source, renderId, steps, selectedStepId, onStepSelect]);

  if (error) {
    return (
      <div className="text-xs text-destructive">
        Diagram failed to render: {error}
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className="w-full text-center [&_svg]:mx-auto [&_svg]:max-w-full"
    />
  );
}

function bindStepNodes(
  svgRoot: SVGSVGElement,
  steps: StepDraft[],
  selectedStepId: string | null | undefined,
  onStepSelect: ((stepId: string) => void) | undefined,
) {
  if (!onStepSelect || steps.length === 0) return;

  const nodes = Array.from(svgRoot.querySelectorAll<SVGGElement>("g.node"));
  for (const step of steps) {
    const sanitizedId = sanitizeMermaidId(step.id);
    const node = nodes.find((candidate) => {
      const text = candidate.textContent ?? "";
      const id = candidate.id ?? "";
      return (
        id.includes(sanitizedId) ||
        (text.includes(step.id) && (!step.team || text.includes(step.team)))
      );
    });

    if (!node) continue;

    node.dataset.workflowStepId = step.id;
    node.setAttribute("role", "button");
    node.setAttribute("tabindex", "0");
    node.setAttribute("aria-label", `Inspect ${step.id}`);
    node.style.cursor = "pointer";

    const shape = node.querySelector<SVGElement>("rect, polygon, path");
    if (shape && selectedStepId === step.id) {
      shape.setAttribute("stroke", "var(--primary)");
      shape.setAttribute("stroke-width", "2.5");
    }

    node.addEventListener("click", () => onStepSelect(step.id));
    node.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onStepSelect(step.id);
      }
    });
  }
}

function sanitizeMermaidId(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_]/g, "_");
  if (cleaned === "" || /^\d/.test(cleaned)) return `s_${cleaned || "x"}`;
  return cleaned;
}

export default WorkflowDiagram;
