import type { AgentProgressSnapshot } from '@contracts/agent-progress';
import type { AgentProgressUpdate } from '@contracts/agent-progress';
import { useEffect, useState } from 'react';
import { ChevronRight, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { formatElapsedDuration } from '@/components/run/tasks/task-timing';

function progressLabel(update: AgentProgressUpdate): string {
  if (update.kind === 'reported') return update.summary;
  switch (update.phase) {
    case 'starting': return 'Starting provider';
    case 'thinking': return 'Thinking';
    case 'waiting': return 'Waiting for provider';
    case 'answering': return 'Writing response';
    case 'tool': return update.toolName ? `Running ${update.toolName}` : 'Running a tool';
    case 'retry': return update.attempt ? `Provider retry ${update.attempt}` : 'Provider retry';
    case 'rate_limited': return 'Provider quota reached';
  }
}

export function AgentProgress({ speaker, snapshot }: { speaker: string; snapshot: AgentProgressSnapshot }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const observed = snapshot.current.kind === 'observed' ? snapshot.current : undefined;
  const showReport = snapshot.reported !== undefined && observed?.phase !== 'tool' && observed?.phase !== 'retry' && observed?.phase !== 'rate_limited';
  const label = showReport ? snapshot.reported?.summary ?? progressLabel(snapshot.current) : progressLabel(snapshot.current);
  const age = Math.max(0, now - snapshot.updatedAt);
  const retryDelay = observed?.retryDelayMs;
  return (
    <Collapsible className="my-2 text-sm text-muted-foreground">
      <CollapsibleTrigger render={<Button variant="ghost" className="h-auto max-w-full justify-start gap-2 px-1 py-1 font-normal" aria-label={`Agent progress: ${label}`} />}>
        <Loader2 aria-hidden="true" className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
        <span className="truncate">{label}</span>
        <ChevronRight aria-hidden="true" className="size-3.5 shrink-0" />
      </CollapsibleTrigger>
      {showReport ? <p className="ml-6 text-xs">Agent-reported{observed ? ` · ${progressLabel(observed)}` : ''}</p> : null}
      {observed?.phase === 'retry' && retryDelay !== undefined ? <p className="ml-6 text-xs">{age < retryDelay ? `Next attempt in ${Math.ceil((retryDelay - age) / 1000)}s` : 'Waiting for provider retry'}</p> : null}
      {age >= 30_000 ? <p className="ml-6 text-xs">Last activity {formatElapsedDuration(age)} ago</p> : null}
      <CollapsibleContent className="ml-6 space-y-2 py-2 text-xs">
        <p>{speaker} · Progress</p>
        {observed && showReport ? <p>{progressLabel(observed)}</p> : null}
        {snapshot.reported && snapshot.reported.tasks.length > 0 ? <>
          <p className="font-medium">Agent-reported tasks</p>
          <ul aria-label="Agent-reported tasks" className="space-y-1">
            {snapshot.reported.tasks.map(task => <li key={task.id}>{task.label} · {task.status === 'active' ? 'In progress' : task.status === 'completed' ? 'Completed' : 'Pending'}</li>)}
          </ul>
        </> : null}
        <p className="font-medium">Recent activity</p>
        <ol aria-label="Recent activity" className="space-y-1">
          {snapshot.history.map((entry, index) => <li key={`${entry.at}:${index}`} className="flex gap-2"><span className="tabular-nums">{formatElapsedDuration(entry.at - snapshot.startedAt)}</span><span>{entry.update.kind === 'reported' ? 'Agent-reported: ' : ''}{progressLabel(entry.update)}</span></li>)}
        </ol>
      </CollapsibleContent>
    </Collapsible>
  );
}
