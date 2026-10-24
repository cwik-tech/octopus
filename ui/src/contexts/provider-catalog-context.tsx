/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { AppDefaultModelState } from "@contracts/agent-model-selection";
import {
  fetchProviderCatalog,
  type ModelEffortCapability,
  type ProviderCatalogGroup,
  type ProviderModelSelection,
} from "@/lib/clients/provider-settings-client";

interface ProviderCatalogContextValue {
  groups: ProviderCatalogGroup[];
  /**
   * Effort ranges by provider and model, for every pair one is known for.
   *
   * Beside the groups rather than inside them: an Agent may name a built-in API
   * provider that has no group at all, and its range still has to reach the
   * editor.
   */
  effortCapabilities: ModelEffortCapability[];
  /** The default's pair when it can run, otherwise `null`. */
  defaultModel: ProviderModelSelection | null;
  /** The deliberate choice and its readiness. */
  defaultModelState: AppDefaultModelState;
  loading: boolean;
  error: string | null;
  refresh(): Promise<void>;
}

const EMPTY_PROVIDER_CATALOG: ProviderCatalogContextValue = {
  groups: [],
  effortCapabilities: [],
  defaultModel: null,
  defaultModelState: { status: "unset" },
  loading: false,
  error: null,
  refresh: async () => undefined,
};

const ProviderCatalogContext = createContext<ProviderCatalogContextValue>(
  EMPTY_PROVIDER_CATALOG,
);

export function ProviderCatalogProvider({ children }: { children: ReactNode }) {
  const [groups, setGroups] = useState<ProviderCatalogGroup[]>([]);
  const [effortCapabilities, setEffortCapabilities] = useState<
    ModelEffortCapability[]
  >([]);
  const [defaultModel, setDefaultModel] =
    useState<ProviderModelSelection | null>(null);
  const [defaultModelState, setDefaultModelState] =
    useState<AppDefaultModelState>({ status: "unset" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const latestLoad = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    latestLoad.current?.abort();
    const controller = new AbortController();
    latestLoad.current = controller;
    const apply = (snapshot: Awaited<ReturnType<typeof fetchProviderCatalog>>) => {
      setGroups(snapshot.catalog);
      setEffortCapabilities(snapshot.effortCapabilities ?? []);
      setDefaultModel(snapshot.defaultModel);
      setDefaultModelState(snapshot.defaultModelState ?? { status: "unset" });
      setError(null);
      setLoading(false);
    };
    try {
      const saved = await fetchProviderCatalog(false, controller.signal);
      if (controller.signal.aborted) return;
      apply(saved);
      const discovered = await fetchProviderCatalog(true, controller.signal);
      if (!controller.signal.aborted) apply(discovered);
    } catch (refreshError) {
      if (controller.signal.aborted) return;
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Show the saved catalog first; discovery updates it without blocking use.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    return () => latestLoad.current?.abort();
  }, [refresh]);

  const value = useMemo(
    () => ({
      groups,
      effortCapabilities,
      defaultModel,
      defaultModelState,
      loading,
      error,
      refresh,
    }),
    [
      groups,
      effortCapabilities,
      defaultModel,
      defaultModelState,
      loading,
      error,
      refresh,
    ],
  );

  return (
    <ProviderCatalogContext.Provider value={value}>
      {children}
    </ProviderCatalogContext.Provider>
  );
}

export function useProviderCatalog(): ProviderCatalogContextValue {
  return useContext(ProviderCatalogContext);
}
