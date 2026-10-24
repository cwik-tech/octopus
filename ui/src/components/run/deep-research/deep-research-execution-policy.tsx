import type { ResearchExecutionPolicy } from "@/lib/models/session-model";

export function DeepResearchExecutionPolicy({
  policy,
}: {
  policy: ResearchExecutionPolicy;
}) {
  return (
    <section
      className="rounded-lg border border-border/60 bg-background p-3"
      data-testid="deep-research-execution-policy"
    >
      <h4 className="text-xs font-semibold text-foreground">
        Adaptive execution policy
      </h4>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        {policy.complexityRationale}
      </p>
      <dl className="mt-2 grid gap-1.5 text-xs text-muted-foreground sm:grid-cols-2">
        <PolicyField label="Complexity" value={policy.complexity} />
        <PolicyField label="Search breadth" value={policy.searchBreadth} />
        <PolicyField
          label="Research cost cap"
          value={`$${policy.maxCostUsd.toFixed(2)}`}
        />
        <PolicyField
          label="Synthesis"
          value={policy.synthesis.mode === "section_dossiers"
            ? `Section dossiers · up to ${policy.synthesis.maximumParallelSections} parallel drafts`
            : "Single report synthesis"}
        />
        <PolicyField
          label="Evidence targets"
          value={`${policy.evidenceTargets.minimumSupportedClaims} supported claims · ${policy.evidenceTargets.minimumIndependentSourcesPerConsequentialClaim} independent sources per consequential claim`}
        />
        <PolicyField
          label="Adaptive stop"
          value={`Information gain ≥ ${policy.stopping.minimumExpectedInformationGain}/100 · max ${policy.stopping.maximumCorrectionWaves} correction waves`}
        />
        <PolicyField
          label="Cross-verification"
          value={policy.evidenceTargets.crossVerifyConsequentialClaims
            ? "Required for consequential claims"
            : "Not required beyond task evidence rules"}
        />
      </dl>
    </section>
  );
}

function PolicyField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="inline font-medium text-foreground/80">{label}: </dt>
      <dd className="inline capitalize">{value.replaceAll("_", " ")}</dd>
    </div>
  );
}
