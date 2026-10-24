import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatDisplayName } from "@/lib/utils/display-name";

/**
 * The detailed brief a planned Agent is generated from, shown only on request.
 *
 * The proposal card shows the Agent's summary. The brief can run to thousands
 * of characters, so it stays out of the card and opens here instead, whole and
 * unchanged, as selectable text.
 *
 * The summary heads the dialog as well. The card caps it at three lines, and
 * a narrow chat column cuts a long valid summary short, so this is where the
 * rest of it can be read.
 */
export function AgentBuildBriefDialog({
  agentName,
  summary,
  brief,
}: {
  agentName: string;
  summary: string;
  brief: string;
}) {
  const displayName = formatDisplayName(agentName);
  return (
    <Dialog>
      {/* Every card in a batch has this button, so its name says whose brief
          it opens. It starts with the visible label, so voice control finds it. */}
      <DialogTrigger
        aria-label={`View build brief for ${displayName}`}
        render={<Button size="sm" variant="link" className="h-auto px-0" />}
      >
        View build brief
      </DialogTrigger>
      {/* Two rows, header and brief, so the brief row gives the scroll area a
          bounded height and a long brief scrolls inside the dialog. */}
      <DialogContent className="max-h-[85dvh] grid-rows-[auto_minmax(0,1fr)] sm:max-w-2xl">
        <DialogHeader className="pr-8">
          <DialogTitle>Build brief for {displayName}</DialogTitle>
          <DialogDescription>{summary}</DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0">
          <p className="pr-3 text-sm whitespace-pre-wrap break-words">{brief}</p>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
