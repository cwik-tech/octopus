import { buildResearchAgentPrompt } from "@contracts/deep-research-agent-prompt";

import type { ResearchWorkerSpec } from "@/lib/models/session-model";

export function ResearchAgentPrompt({
  worker,
}: {
  worker: ResearchWorkerSpec;
}) {
  return (
    <section>
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Generated agent prompt
      </div>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        This task-specific prompt is sent to the researcher. Runtime security and evidence guardrails are added separately.
      </p>
      <pre
        className="mt-2 whitespace-pre-wrap rounded-lg border border-border/70 bg-muted/30 p-4 font-sans text-xs leading-relaxed text-foreground"
        data-testid="generated-research-agent-prompt"
      >
        {buildResearchAgentPrompt(worker)}
      </pre>
    </section>
  );
}
