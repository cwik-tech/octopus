import { useCallback, useEffect, useRef, useState } from "react";

import {
  createSchedule as createScheduleRequest,
  deleteSchedule as deleteScheduleRequest,
  listSchedules,
  runScheduleNow as runScheduleNowRequest,
  updateSchedule as updateScheduleRequest,
  type Schedule,
  type ScheduleInput,
  type SchedulePatch,
} from "@/lib/clients/schedules-client";

const SCHEDULES_REFRESH_INTERVAL_MS = 10_000;

export interface SchedulesState {
  schedules: Schedule[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  create: (input: ScheduleInput) => Promise<Schedule>;
  update: (id: string, patch: SchedulePatch) => Promise<Schedule>;
  remove: (id: string) => Promise<void>;
  runNow: (id: string) => Promise<{ sessionId: string; taskId: string }>;
}

export function useSchedules(enabled: boolean): SchedulesState {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const activeRefresh = useRef<Promise<void> | null>(null);
  const activeController = useRef<AbortController | null>(null);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    if (activeRefresh.current) return activeRefresh.current;
    const controller = new AbortController();
    const requestGeneration = generation.current;
    activeController.current = controller;
    const request = listSchedules(controller.signal)
      .then((next) => {
        if (!controller.signal.aborted && generation.current === requestGeneration) {
          setSchedules(next);
          setError(null);
        }
      })
      .catch((requestError: unknown) => {
        if (!controller.signal.aborted) {
          setError(
            requestError instanceof Error
              ? requestError.message
              : "Schedules could not be loaded.",
          );
        }
      })
      .finally(() => {
        if (activeController.current === controller) activeController.current = null;
        if (activeRefresh.current === request) activeRefresh.current = null;
        if (!controller.signal.aborted) setLoading(false);
      });
    activeRefresh.current = request;
    return request;
  }, []);

  useEffect(() => {
    if (!enabled) {
      activeController.current?.abort();
      activeController.current = null;
      activeRefresh.current = null;
      return;
    }
    const initialId = window.setTimeout(() => void refresh(), 0);
    const intervalId = window.setInterval(
      () => void refresh(),
      SCHEDULES_REFRESH_INTERVAL_MS,
    );
    return () => {
      window.clearTimeout(initialId);
      window.clearInterval(intervalId);
      activeController.current?.abort();
      activeController.current = null;
      activeRefresh.current = null;
    };
  }, [enabled, refresh]);

  const create = useCallback(async (input: ScheduleInput) => {
    const created = await createScheduleRequest(input);
    generation.current += 1;
    setSchedules((current) => [...current, created]);
    setError(null);
    return created;
  }, []);

  const update = useCallback(async (id: string, patch: SchedulePatch) => {
    const updated = await updateScheduleRequest(id, patch);
    generation.current += 1;
    setSchedules((current) =>
      current.map((schedule) => (schedule.id === id ? updated : schedule)),
    );
    setError(null);
    return updated;
  }, []);

  const remove = useCallback(async (id: string) => {
    await deleteScheduleRequest(id);
    generation.current += 1;
    setSchedules((current) => current.filter((schedule) => schedule.id !== id));
    setError(null);
  }, []);

  const runNow = useCallback(async (id: string) => {
    const result = await runScheduleNowRequest(id);
    generation.current += 1;
    activeController.current?.abort();
    activeController.current = null;
    activeRefresh.current = null;
    void refresh();
    return result;
  }, [refresh]);

  return { schedules, loading, error, refresh, create, update, remove, runNow };
}
