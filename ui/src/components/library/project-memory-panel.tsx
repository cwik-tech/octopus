import type { WorkspaceProjectMemoryProposal } from "@contracts/projects";
import { Brain, Check, Loader2, X } from "lucide-react";
import { startTransition, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  decideProjectMemoryProposal,
  listProjectMemoryProposals,
} from "@/lib/clients/project-client";

export function ProjectMemoryPanel({
  projectId,
  active,
  initialProposals,
  onProposalDecided,
}: {
  projectId: string;
  active: boolean;
  initialProposals?: WorkspaceProjectMemoryProposal[];
  onProposalDecided?: (
    proposal: WorkspaceProjectMemoryProposal,
  ) => void | Promise<void>;
}) {
  const controlled = initialProposals !== undefined;
  const [localProposals, setLocalProposals] = useState<WorkspaceProjectMemoryProposal[]>(
    () => initialProposals ?? [],
  );
  const [localLoading, setLocalLoading] = useState(initialProposals === undefined);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const proposals = initialProposals ?? localProposals;
  const loading = controlled ? false : localLoading;

  useEffect(() => {
    if (controlled) return;
    let cancelled = false;
    startTransition(() => {
      setLocalProposals([]);
      setLocalLoading(true);
      setError(null);
    });
    void listProjectMemoryProposals(projectId)
      .then((next) => {
        if (!cancelled) setLocalProposals(next);
      })
      .catch((nextError: unknown) => {
        if (!cancelled) setError(errorMessage(nextError));
      })
      .finally(() => {
        if (!cancelled) setLocalLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [controlled, projectId]);

  useEffect(() => {
    startTransition(() => {
      setPendingId(null);
      setError(null);
    });
  }, [projectId]);

  const decide = async (
    proposal: WorkspaceProjectMemoryProposal,
    decision: "approve" | "reject",
  ) => {
    setPendingId(proposal.id);
    setError(null);
    try {
      const updated = await decideProjectMemoryProposal(
        projectId,
        proposal.id,
        decision,
      );
      if (controlled) {
        await onProposalDecided?.(updated);
      } else {
        setLocalProposals((current) =>
          current.map((entry) => entry.id === updated.id ? updated : entry),
        );
        await onProposalDecided?.(updated);
      }
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setPendingId(null);
    }
  };

  const pending = proposals.filter((proposal) => proposal.status === "pending");
  const approved = proposals.filter((proposal) => proposal.status === "approved");

  return (
    <section className="mt-6 rounded-xl border border-border/70 p-4" aria-labelledby="project-memory-heading">
      <div className="flex items-start gap-3">
        <Brain className="mt-0.5 size-4 text-muted-foreground" aria-hidden="true" />
        <div>
          <h3 id="project-memory-heading" className="font-heading text-base font-semibold">
            Project memory
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Approved memory is durable project knowledge. It is never added to prompts automatically.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Loading project memory…
        </div>
      ) : (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div>
            <h4 className="text-sm font-medium">Pending review</h4>
            {pending.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">No memory proposals need review.</p>
            ) : (
              <div className="mt-2 space-y-2">
                {pending.map((proposal) => (
                  <div key={proposal.id} className="rounded-lg border border-border/60 p-3">
                    <p className="text-sm">{proposal.content}</p>
                    <div className="mt-3 flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        disabled={!active || pendingId !== null}
                        aria-label="Approve project memory"
                        onClick={() => void decide(proposal, "approve")}
                      >
                        {pendingId === proposal.id ? (
                          <Loader2 className="animate-spin" aria-hidden="true" />
                        ) : (
                          <Check aria-hidden="true" />
                        )}
                        Approve
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={!active || pendingId !== null}
                        aria-label="Reject project memory"
                        onClick={() => void decide(proposal, "reject")}
                      >
                        <X aria-hidden="true" />
                        Reject
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div>
            <h4 className="text-sm font-medium">Approved memory</h4>
            {approved.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">No approved project memory yet.</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {approved.map((proposal) => (
                  <li key={proposal.id} className="rounded-lg bg-muted/50 p-3 text-sm">
                    {proposal.content}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
      {error ? <p className="mt-3 text-sm text-destructive" role="alert">{error}</p> : null}
    </section>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Project memory request failed";
}
