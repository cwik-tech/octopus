import { useCallback, useRef, useState } from "react";

import type { RunEvent } from "@/components/run/stage-renderers/index";
import type { TaskRunEntry } from "@/components/run/tasks/task-strip";

export function useTaskRunStore() {
  const [tasks, setTasks] = useState<TaskRunEntry[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [taskEvents, setTaskEvents] = useState<Record<string, RunEvent[]>>({});
  const taskEventsRef = useRef(taskEvents);
  const taskEventReplayKeysRef = useRef<Record<string, Set<string>>>({});

  const replaceTaskEvents = useCallback(
    (events: Record<string, RunEvent[]>) => {
      const nextEvents: Record<string, RunEvent[]> = {};
      const nextReplayKeys: Record<string, Set<string>> = {};
      for (const [taskId, taskEvents] of Object.entries(events)) {
        const replayKeys = new Set<string>();
        nextEvents[taskId] = taskEvents.filter((event) => {
          const replayKey = runEventReplayKey(event);
          if (replayKeys.has(replayKey)) return false;
          replayKeys.add(replayKey);
          return true;
        });
        nextReplayKeys[taskId] = replayKeys;
      }
      taskEventReplayKeysRef.current = nextReplayKeys;
      taskEventsRef.current = nextEvents;
      setTaskEvents(nextEvents);
    },
    [],
  );

  const resetTaskEvents = useCallback((taskId: string) => {
    taskEventReplayKeysRef.current = {
      ...taskEventReplayKeysRef.current,
      [taskId]: new Set<string>(),
    };
    setTaskEvents((current) => {
      const next = { ...current, [taskId]: [] };
      taskEventsRef.current = next;
      return next;
    });
  }, []);

  const appendTaskEvent = useCallback((taskId: string, event: RunEvent) => {
    const replayKey = runEventReplayKey(event);
    const replayKeys = taskEventReplayKeysRef.current[taskId] ?? new Set<string>();
    if (replayKeys.has(replayKey)) return;
    replayKeys.add(replayKey);
    taskEventReplayKeysRef.current = {
      ...taskEventReplayKeysRef.current,
      [taskId]: replayKeys,
    };
    setTaskEvents((current) => {
      const events = current[taskId] ?? [];
      const next = { ...current, [taskId]: [...events, event] };
      taskEventsRef.current = next;
      return next;
    });
  }, []);

  return {
    activeTaskId,
    appendTaskEvent,
    replaceTaskEvents,
    resetTaskEvents,
    setActiveTaskId,
    setTasks,
    taskEvents,
    taskEventsRef,
    tasks,
  };
}

export type TaskRunStore = ReturnType<typeof useTaskRunStore>;

function runEventReplayKey(event: RunEvent): string {
  return event.sourceEnvelope
    ? `source:${JSON.stringify(event.sourceEnvelope)}`
    : `event:${event.id}`;
}
