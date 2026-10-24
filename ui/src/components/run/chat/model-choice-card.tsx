import { TriangleAlert } from "lucide-react";
import { useState } from "react";

import type { ModelChoiceOffer } from "@contracts/model-choice";
import { Button } from "@/components/ui/button";
import { formatDisplayName } from "@/lib/utils/display-name";

const REASON_TEXT: Record<ModelChoiceOffer["reason"], string> = {
  // One reason covers every way a provider can be unusable for this agent: no
  // credential, no permission, no remaining credit, a connection that was
  // removed, and -- since Team startup began deferring pinned CLIs instead of
  // refusing the whole Team -- a CLI that is simply not installed. "No usable
  // credential" is a false sentence for that last one, and sends the reader
  // hunting for an API key that was never the problem.
  "missing-credential": "its provider is not ready",
  "unknown-model": "the provider does not know that model",
  "provider-rejected": "the provider rejected the request",
};

/**
 * The one action a failed explicit model earns: run this attempt again on the
 * application default.
 *
 * Names the exact pair that will run and the exact pair that failed, because
 * approving this is consent to that specific substitution and nothing else. It
 * says plainly that the agent keeps its own setting, since the common fear
 * here is that agreeing once silently repoints the agent.
 */
export function ModelChoiceCard(props: {
  offer: ModelChoiceOffer;
  disabled?: boolean;
  onApprove: (offer: ModelChoiceOffer) => void | Promise<void>;
}) {
  const [approving, setApproving] = useState(false);
  const { offer } = props;
  return (
    <div
      role="note"
      aria-label="Model choice"
      className="flex max-w-3xl flex-col gap-2 rounded-lg border border-orange-500/30 bg-orange-500/8 px-3 py-2 text-xs"
    >
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-orange-500" />
        <p className="min-w-0 break-words text-muted-foreground">
          {formatDisplayName(offer.agentName)} could not run on{" "}
          {offer.failedChoice.provider} / {offer.failedChoice.model} because{" "}
          {REASON_TEXT[offer.reason]}. You can run this one attempt on the
          application default, {offer.proposedDefault.provider} /{" "}
          {offer.proposedDefault.model}. Its saved settings will not change.
        </p>
      </div>
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="outline"
          disabled={props.disabled || approving}
          onClick={() => {
            setApproving(true);
            void Promise.resolve(props.onApprove(offer)).finally(() =>
              setApproving(false),
            );
          }}
        >
          Retry this Agent using app default
        </Button>
      </div>
    </div>
  );
}
