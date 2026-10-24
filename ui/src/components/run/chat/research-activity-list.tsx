import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
} from "@/components/ai-elements/chain-of-thought";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils/utils";
import {
  Source,
  Sources,
  SourcesContent,
  SourcesTrigger,
} from "@/components/ai-elements/sources";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { useSiteIcons } from "@/hooks/use-site-icons";
import {
  isTerminalResearchActivityState,
  researchAttachmentUrl,
  type ResearchActivity,
  type ResearchActivityState,
} from "@/lib/clients/research-activity-client";
import {
  Ban,
  CheckCircle2,
  CircleAlert,
  Clock3,
  ExternalLink,
  Globe,
  LoaderCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

/**
 * The one disclosure a turn's research is shown in.
 *
 * Both research tools reach here through the same projected read model, so
 * nothing below branches on which tool recorded a step. Ordinary chat and the
 * Deep Research task sheet render this same component.
 */
export function ResearchActivity({
  activities,
  expandedByDefault,
  resolved,
  settleMs = 0,
}: {
  activities: readonly ResearchActivity[];
  expandedByDefault?: boolean;
  resolved: boolean;
  /**
   * How long `resolved` must hold before the disclosure acts on it.
   *
   * A caller that infers "finished" from step data alone needs this: between two
   * research calls every recorded step is briefly terminal, and collapsing on
   * that flickers the panel shut while research is still running.
   */
  settleMs?: number;
}) {
  const settled = useSettledResolution(resolved, settleMs);
  const iconOrigins = useMemo(
    () => activities
      .filter(isVisitedPage)
      .map((activity) => activityOrigin(activity.url))
      .filter((origin): origin is string => origin !== null),
    [activities],
  );
  const icons = useSiteIcons(activities[0]?.sessionId ?? null, iconOrigins);
  const [userOpenState, setUserOpenState] = useState<{
    settled: boolean;
    open: boolean;
  } | null>(null);
  const open = userOpenState?.settled === settled
    ? userOpenState.open
    : expandedByDefault ?? !settled;
  const summary = useMemo(() => researchSummary(activities), [activities]);
  const label = settled ? "Research activity" : "Running research activity";

  if (activities.length === 0) return null;
  return (
    <ChainOfThought
      open={open}
      onOpenChange={(nextOpen) => setUserOpenState({ settled, open: nextOpen })}
      className="w-full space-y-0 py-1"
      aria-label="Web research activity"
    >
      <ChainOfThoughtHeader
        aria-label={`${label}: ${summary}`}
        className="w-full rounded-md py-1.5 text-left"
      >
        <span className="flex w-full min-w-0 items-center gap-2">
          {settled ? (
            <span className="truncate">{label}</span>
          ) : (
            <Shimmer as="span" className="truncate">{label}</Shimmer>
          )}
          <span className="ml-auto shrink-0 text-xs text-muted-foreground/70">
            {summary}
          </span>
        </span>
      </ChainOfThoughtHeader>
      <ChainOfThoughtContent className="mt-3">
        <div className="mb-2 max-h-72 overflow-y-auto rounded-lg border border-border">
          <Table
            className="table-fixed text-xs"
            containerClassName="rounded-none border-0 bg-transparent"
          >
            <TableCaption className="sr-only">Research steps</TableCaption>
            <colgroup>
              <col className="w-7" />
              <col />
              <col className="w-1/3" />
            </colgroup>
            <TableHeader className="sr-only">
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead>Page</TableHead>
                <TableHead>Source</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {activities.map((activity) => (
                <ResearchStep
                  key={activity.activityId}
                  activity={activity}
                  iconUrl={icons.get(activityOrigin(activity.url) ?? "")}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      </ChainOfThoughtContent>
    </ChainOfThought>
  );
}

export function ResearchSources({
  activities,
  answer,
}: {
  activities: readonly ResearchActivity[];
  answer: string;
}) {
  const sources = useMemo(
    () => citedCompletedSources(activities, answer),
    [activities, answer],
  );
  if (sources.length === 0) return null;
  return (
    <Sources className="mb-0 mt-1 text-muted-foreground">
      <SourcesTrigger count={sources.length} aria-label={`Used ${sources.length} sources`} />
      <SourcesContent>
        {sources.map((source, index) => (
          <Source
            key={source.url}
            href={source.url}
            title={source.title || source.host}
            className="max-w-xl text-left hover:text-foreground"
          >
            <span className="w-4 shrink-0 text-right tabular-nums">
              {index + 1}.
            </span>
            <span className="block min-w-0 truncate font-medium">
              {source.title || source.host}
            </span>
          </Source>
        ))}
      </SourcesContent>
    </Sources>
  );
}

function ResearchStep({
  activity,
  iconUrl,
}: {
  activity: ResearchActivity;
  iconUrl?: string | undefined;
}) {
  // Screenshots and downloads are still produced and stored by the browser
  // tool; only the read model is unified, so they keep their own route.
  const attachmentUrl = activity.attachment
    ? researchAttachmentUrl(activity.sessionId, activity.activityId)
    : undefined;
  const host = activityHost(activity.url);
  const failed = Boolean(activity.error);
  const Icon = failed
    ? activity.error?.code === "source_blocked" ? Ban : CircleAlert
    : isTerminalResearchActivityState(activity.state) ? CheckCircle2
      : activity.state === "running" ? LoaderCircle : Clock3;
  // A failed step has no page to describe, so its reason takes the page column
  // and the raw code stays available on hover for diagnosis.
  const primary = stepDescription(activity, host);
  // A page that was actually read is identified by its site; every other
  // outcome — denied, failed, cancelled, still running — is identified by what
  // happened to it, even when a URL survives and no error metadata was recorded.
  const showsSiteIcon = isVisitedPage(activity);
  // Any step that carries a real page address — visited, denied, failed,
  // cancelled, or still running — offers that exact address, query included,
  // from the source column. The display shows the host; the click never goes
  // to the bare origin.
  const sourceUrl = activityOrigin(activity.url) !== null ? activity.url : undefined;
  return (
    <TableRow
      aria-label={`Research activity ${activity.action} ${activity.error?.code ?? activity.state}`}
      className={failed ? "text-destructive" : undefined}
      title={activity.error?.message ?? undefined}
    >
      <TableCell className="py-1.5 pr-0 align-middle">
        {showsSiteIcon ? (
          <span className="flex size-4 items-center justify-center overflow-hidden rounded-sm bg-muted">
            {iconUrl
              ? <img src={iconUrl} alt="" className="size-4" />
              : <Globe className="size-3 text-muted-foreground" />}
          </span>
        ) : (
          <Icon
            className={cn(
              "size-4",
              failed ? "text-destructive" : "text-muted-foreground",
              activity.state === "running" && "animate-spin motion-reduce:animate-none",
            )}
          />
        )}
      </TableCell>
      <TableCell className="py-1.5 align-middle">
        {showsSiteIcon && activity.url ? (
          <Button
            variant="ghost"
            aria-label={`Open ${activity.url}`}
            className="h-auto w-full justify-start p-0 text-left text-xs font-normal hover:bg-transparent hover:underline"
            onClick={() => window.open(activity.url, "_blank", "noopener,noreferrer")}
          >
            <span className="block truncate" title={primary}>{primary}</span>
          </Button>
        ) : (
          <span className="block truncate" title={primary}>{primary}</span>
        )}
        {activity.attachment && attachmentUrl ? (
          <a
            href={attachmentUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex max-w-full items-center gap-1 text-xs text-primary-text hover:underline"
            aria-label={`Open research attachment ${activity.attachment.name}`}
          >
            <ExternalLink className="size-3 shrink-0" />
            <span className="truncate" title={activity.attachment.name}>
              {activity.attachment.name}
            </span>
          </a>
        ) : null}
      </TableCell>
      <TableCell className="py-1.5 text-right align-middle text-muted-foreground">
        {sourceUrl ? (
          <Button
            variant="ghost"
            aria-label={`Open source ${sourceUrl}`}
            className="h-auto w-full justify-end p-0 text-xs font-normal hover:bg-transparent hover:underline"
            onClick={() => window.open(sourceUrl, "_blank", "noopener,noreferrer")}
          >
            <span className="block truncate" title={sourceUrl}>
              {stepTrailing(activity, host)}
            </span>
          </Button>
        ) : (
          <span className="block truncate">{stepTrailing(activity, host)}</span>
        )}
      </TableCell>
    </TableRow>
  );
}

/**
 * `resolved`, delayed on the false-to-true edge only.
 *
 * The reverse edge applies at once so a late step reopens the panel immediately,
 * and cancels any pending settle so research that resumes is never collapsed
 * behind the user's back. With no settle window the caller's value passes
 * straight through, keeping callers that already know they are finished
 * synchronous.
 */
function useSettledResolution(resolved: boolean, settleMs: number): boolean {
  const [delayed, setDelayed] = useState(false);
  const [previousResolved, setPreviousResolved] = useState(resolved);
  // Adjusting state during render is React's documented way to reset derived
  // state when a prop changes. It keeps the reverse edge immediate without
  // setting state inside the effect, which would cascade renders.
  if (previousResolved !== resolved) {
    setPreviousResolved(resolved);
    setDelayed(false);
  }
  useEffect(() => {
    if (settleMs <= 0 || !resolved) return;
    const timer = window.setTimeout(() => setDelayed(true), settleMs);
    return () => window.clearTimeout(timer);
  }, [resolved, settleMs]);
  return settleMs <= 0 ? resolved : delayed;
}

function researchSummary(activities: readonly ResearchActivity[]): string {
  const steps = `${activities.length} ${activities.length === 1 ? "step" : "steps"}`;
  const usable = activities.filter(isVisitedPage).length;
  const failed = activities.filter((activity) => Boolean(activity.error)).length;
  // The header itself says whether research is running, so the counts no longer
  // repeat it. A total is not knowable until the run ends, so no "n of m".
  const active = activities.some((activity) =>
    !isTerminalResearchActivityState(activity.state));
  return [
    steps,
    usable > 0 ? `${usable} opened` : null,
    !active && failed > 0 ? `${failed} blocked or failed` : null,
  ].filter(Boolean).join(" · ");
}

/**
 * What this row says happened.
 *
 * A search names the index it queried once it has one, because "searched" with
 * no provider tells the reader nothing about where the evidence came from. A
 * page names itself once it has been read, and describes the attempt until
 * then, so a URL on screen always means a page the researcher reached.
 */
function stepDescription(
  activity: ResearchActivity,
  host: string | null,
): string {
  if (activity.error) return friendlyError(activity, host);
  if (activity.kind === "search") {
    if (!isTerminalResearchActivityState(activity.state)) return "Searching the web";
    const providers = (activity.searchProviders ?? []).map(providerName);
    return providers.length > 0
      ? `Searched ${formatList(providers)}`
      : "Searched the web";
  }
  if (!isTerminalResearchActivityState(activity.state)) {
    return `${presentAction(activity.action)} ${host ?? "page"}`;
  }
  return activity.title || compactUrl(activity.url) ||
    `${capitalize(pastAction(activity.action))} ${host ?? "page"}`;
}

/** The right-hand column: the site, or what the step is instead. */
function stepTrailing(
  activity: ResearchActivity,
  host: string | null,
): string {
  if (activity.kind === "search" && activity.resultCount !== undefined) {
    return `${activity.resultCount} ${activity.resultCount === 1 ? "result" : "results"}`;
  }
  return host ?? stateLabel(activity.state);
}

/**
 * Why a step ended, in terms of what happened rather than which tool it
 * happened in.
 *
 * One component renders both research tools, and most of these codes are
 * declared by both of them. Naming a tool here would describe a cancelled or
 * timed-out `research_web` step as a browser failure, so the fallback
 * describes the step itself instead.
 */
function friendlyError(activity: ResearchActivity, host: string | null): string {
  switch (activity.error?.code) {
    case "access_challenge": return "CAPTCHA or anti-bot verification";
    case "access_denied": return "Access was denied";
    case "rate_limited": return "The source rate-limited this request";
    case "not_found":
    case "page_not_found": return "The requested page was not found";
    case "empty_content": return "The page contained no usable content";
    case "unsupported_content": return "The content type is not supported";
    case "source_blocked": return "Skipped after an earlier failure on this host";
    case "domain_denied": return "Blocked by policy";
    case "not_configured": return "No search provider is configured";
    case "budget_exhausted": return "The research budget for this turn ran out";
    case "browser_unavailable": return "The managed browser was unavailable";
    case "timeout": return "The source did not respond in time";
    case "cancelled":
      return activity.kind === "search"
        ? "The search was cancelled"
        : "The step was cancelled";
    case "invalid_request": return "The request was rejected as invalid";
    case "element_not_found": return "The page element was no longer there";
    case "sensitive_input_blocked": return "Stopped before entering sensitive input";
    case "approval_denied": return "Approval was denied";
    case "approval_expired": return "The approval request expired";
    case "download_too_large": return "The download was too large";
    default:
      return activity.kind === "search"
        ? "Could not search the web"
        : `Could not ${actionVerb(activity.action)} ${host ?? "the page"}`;
  }
}

function actionVerb(action: string): string {
  switch (action) {
    case "go_back": return "return to";
    case "acquire": return "read";
    case "read_content": return "read";
    case "search_content": return "search";
    case "screenshot": return "capture";
    default: return action.replaceAll("_", " ");
  }
}

/** What a step in progress is doing, so a running row reads as an attempt. */
function presentAction(action: string): string {
  switch (action) {
    case "open": return "Opening";
    case "navigate": return "Visiting";
    case "observe": return "Checking";
    case "go_back": return "Returning to";
    case "acquire": return "Reading";
    case "read_content": return "Reading";
    case "search_content": return "Searching";
    case "extract": return "Extracting from";
    case "screenshot": return "Capturing";
    case "download": return "Downloading from";
    default: return capitalize(actionVerb(action));
  }
}

function pastAction(action: string): string {
  switch (action) {
    case "open": return "opened";
    case "navigate": return "visited";
    case "observe": return "checked";
    case "go_back": return "returned to";
    case "acquire": return "read";
    case "read_content": return "read";
    case "search_content": return "searched";
    case "extract": return "extracted from";
    case "screenshot": return "captured";
    case "download": return "downloaded from";
    case "close": return "closed";
    default: return `${actionVerb(action)}ed`;
  }
}

/** Provider identifiers are lowercase on the wire and brand names on screen. */
function providerName(provider: string): string {
  switch (provider) {
    case "brave": return "Brave";
    case "exa": return "Exa";
    case "firecrawl": return "Firecrawl";
    default: return capitalize(provider);
  }
}

function formatList(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  return `${values.slice(0, -1).join(", ")} and ${values.at(-1)}`;
}

function stateLabel(state: ResearchActivityState): string {
  switch (state) {
    case "awaiting-approval": return "awaiting approval";
    default: return state;
  }
}

function citedCompletedSources(
  activities: readonly ResearchActivity[],
  answer: string,
): Array<{ url: string; title?: string; host: string }> {
  const cited = new Set((answer.match(/https?:\/\/[^\s<]+/g) ?? [])
    .map(normalizeUrl)
    .filter(Boolean));
  const sources = new Map<string, { url: string; title?: string; host: string }>();
  for (const activity of activities) {
    if (!isVisitedPage(activity) || !activity.url) continue;
    const url = normalizeUrl(activity.url);
    const host = activityHost(url);
    if (!url || !host || !cited.has(url) || sources.has(url)) continue;
    sources.set(url, {
      url,
      ...(activity.title ? { title: activity.title } : {}),
      host,
    });
  }
  return [...sources.values()];
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value.replace(/[),.;:!?\]}]+$/g, ""));
    url.hash = "";
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return "";
  }
}

/**
 * Whether this step actually read a page.
 *
 * Only a completed `page` counts. A search discovers candidate URLs it never
 * opened, and a denied, failed or cancelled read can still carry a URL and no
 * error metadata; presenting either as a visited site would overstate what the
 * researcher saw and request an icon for it.
 */
function isVisitedPage(activity: ResearchActivity): boolean {
  return activity.kind === "page" &&
    activity.state === "completed" &&
    !activity.error &&
    activityOrigin(activity.url) !== null;
}

/**
 * The origin a site icon is requested for.
 *
 * Deliberately not the display host: `activityHost` strips `www`, and the app
 * authorizes icon requests against the exact origin the session recorded, where
 * `www`, the scheme and the port are all part of the identity.
 */
function activityOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function activityHost(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function compactUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return undefined;
  }
}

function capitalize(value: string): string {
  return value.length > 0 ? `${value[0]?.toUpperCase()}${value.slice(1)}` : value;
}
