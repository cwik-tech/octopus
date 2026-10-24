import type {
  WorkspaceProjectCatalogFile,
  WorkspaceProjectCatalogRoot,
  WorkspaceProjectCatalogSessionBranch,
} from "@contracts/projects";
import { Download, FileSearch, Loader2 } from "lucide-react";
import { startTransition, useCallback, useEffect, useRef, useState } from "react";

import {
  FileTree,
  FileTreeActions,
  FileTreeFile,
  FileTreeFolder,
  FileTreeIcon,
  FileTreeName,
} from "@/components/ai-elements/file-tree";
import { ArtifactPreviewSheet } from "@/components/run/pickers/artifact-preview-sheet";
import type { ArtifactPreviewTarget } from "@/components/run/stage-renderers";
import {
  getProjectCatalogRoot,
  getProjectCatalogSession,
  projectCatalogResourceUrl,
} from "@/lib/clients/project-client";

const ROOT_EXPANDED = new Set(["shared-inputs", "sessions"]);

type ProjectFileCatalogProps = {
  projectId: string;
  showHiddenFiles?: boolean;
} & (
  | {
      /** Controlled aggregate mode: the parent owns root refreshes. */
      initialRoot: WorkspaceProjectCatalogRoot;
      refreshKey?: never;
    }
  | {
      /** Standalone mode: refreshKey requests another catalog-root read. */
      initialRoot?: undefined;
      refreshKey?: string | number;
    }
);

export function ProjectFileCatalog(props: ProjectFileCatalogProps) {
  return <ProjectFileCatalogContent key={props.projectId} {...props} />;
}

function ProjectFileCatalogContent({
  projectId,
  refreshKey,
  initialRoot,
  showHiddenFiles = false,
}: ProjectFileCatalogProps) {
  const [root, setRoot] = useState<WorkspaceProjectCatalogRoot | null>(
    initialRoot ?? null,
  );
  const [branches, setBranches] = useState<
    Record<string, WorkspaceProjectCatalogSessionBranch>
  >({});
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(ROOT_EXPANDED),
  );
  const [selectedPath, setSelectedPath] = useState<string>();
  const [previewTarget, setPreviewTarget] = useState<ArtifactPreviewTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadingSessions = useRef(new Set<string>());
  const branchesRef = useRef(branches);
  const selectedPathRef = useRef<string | undefined>(undefined);
  const mountedRef = useRef(true);

  const reconcileRoot = useCallback((nextRoot: WorkspaceProjectCatalogRoot) => {
    const sessionIds = new Set(nextRoot.sessions.map((session) => session.id));
    const nextBranches = pruneCatalogBranches(branchesRef.current, sessionIds);
    branchesRef.current = nextBranches;
    setBranches(nextBranches);
    setExpanded((current) => pruneExpandedSessions(current, sessionIds));
    const currentSelection = selectedPathRef.current;
    if (
      currentSelection &&
      !findCatalogFile(nextRoot, nextBranches, currentSelection)
    ) {
      selectedPathRef.current = undefined;
      setSelectedPath(undefined);
      setPreviewTarget(null);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (initialRoot) {
      startTransition(() => reconcileRoot(initialRoot));
      return;
    }
    let cancelled = false;
    void getProjectCatalogRoot(projectId)
      .then((next) => {
        if (!cancelled) {
          setRoot(next);
          reconcileRoot(next);
        }
      })
      .catch((nextError: unknown) => {
        if (!cancelled) setError(errorMessage(nextError));
      });
    return () => {
      cancelled = true;
    };
  }, [initialRoot, projectId, reconcileRoot, refreshKey]);

  const loadSession = useCallback(
    async (sessionId: string) => {
      const requestedProjectId = projectId;
      const loadingKey = `${requestedProjectId}:${sessionId}`;
      if (
        branchesRef.current[sessionId] ||
        loadingSessions.current.has(loadingKey)
      ) return;
      loadingSessions.current.add(loadingKey);
      try {
        const branch = await getProjectCatalogSession(projectId, sessionId);
        if (!mountedRef.current) return;
        setBranches((current) => {
          const next = { ...current, [sessionId]: branch };
          branchesRef.current = next;
          return next;
        });
        setExpanded((current) => {
          const next = new Set(current);
          for (const category of branchCategories(branch, true)) {
            next.add(categoryPath(sessionId, category.key));
          }
          return next;
        });
      } catch (nextError) {
        if (mountedRef.current) {
          setError(errorMessage(nextError));
        }
      } finally {
        loadingSessions.current.delete(loadingKey);
      }
    },
    [projectId],
  );

  const handleExpandedChange = (next: Set<string>) => {
    setExpanded(next);
    for (const path of next) {
      if (!path.startsWith("session:")) continue;
      const sessionId = path.slice("session:".length);
      if (sessionId && !branches[sessionId]) void loadSession(sessionId);
    }
  };

  const handleSelect = (path: string) => {
    selectedPathRef.current = path;
    setSelectedPath(path);
    const file = findCatalogFile(initialRoot ?? root, branches, path);
    if (!file) return;
    if (file.capabilities.preview === "artifact" && file.resource.kind === "run_artifact") {
      setPreviewTarget({
        runId: file.resource.runId,
        artifactPath: file.resource.artifactPath,
      });
      return;
    }
    if (file.capabilities.preview === "browser") {
      window.open(
        projectCatalogResourceUrl(file.resource.resourcePath),
        "_blank",
        "noopener,noreferrer",
      );
    }
  };

  const catalogRoot = initialRoot ?? root;
  const selectedFileExists = !selectedPath || Boolean(
    findCatalogFile(catalogRoot, branches, selectedPath),
  );
  const visiblePreviewTarget = selectedFileExists ? previewTarget : null;

  return (
    <section className="mt-6" aria-labelledby="project-file-catalog-heading">
      <div className="mb-2">
        <h3 id="project-file-catalog-heading" className="font-heading text-base font-semibold">
          File catalog
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Shared inputs and session outputs. Session files load when you expand a session.
        </p>
      </div>

      {error ? (
        <p className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : !catalogRoot ? (
        <div className="flex items-center gap-2 rounded-lg border p-4 text-sm text-muted-foreground" role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Loading file catalog…
        </div>
      ) : (
        <FileTree
          expanded={expanded}
          selectedPath={selectedPath}
          onExpandedChange={handleExpandedChange}
          onSelect={handleSelect}
        >
          <FileTreeFolder path="shared-inputs" name="Shared inputs">
            {catalogRoot.sharedInputs.length > 0
              ? catalogRoot.sharedInputs.map(renderFile)
              : <EmptyTreeLabel text="No shared inputs" />}
          </FileTreeFolder>
          <FileTreeFolder path="sessions" name="Sessions">
            {catalogRoot.sessions.length > 0 ? catalogRoot.sessions.map((session) => {
              const branch = branches[session.id];
              return (
                <FileTreeFolder
                  key={session.id}
                  path={sessionPath(session.id)}
                  name={session.title}
                >
                  {branch
                    ? branchCategories(branch, showHiddenFiles).map((category) => (
                        <FileTreeFolder
                          key={category.key}
                          path={categoryPath(session.id, category.key)}
                          name={category.label}
                        >
                          {category.files.map(renderFile)}
                        </FileTreeFolder>
                      ))
                    : (
                        <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground" role="status">
                          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                          Loading session files…
                        </div>
                      )}
                </FileTreeFolder>
              );
            }) : <EmptyTreeLabel text="No project sessions" />}
          </FileTreeFolder>
        </FileTree>
      )}

      <ArtifactPreviewSheet
        open={visiblePreviewTarget !== null}
        target={visiblePreviewTarget}
        onOpenChange={(open) => {
          if (!open) setPreviewTarget(null);
        }}
      />
    </section>
  );
}

function renderFile(file: WorkspaceProjectCatalogFile) {
  return (
    <FileTreeFile key={file.id} path={file.id} name={file.name}>
      <span className="size-4 shrink-0" />
      <FileTreeIcon>
        <FileSearch className="size-4 text-muted-foreground" aria-hidden="true" />
      </FileTreeIcon>
      <FileTreeName>{file.name}</FileTreeName>
      {file.capabilities.download ? (
        <FileTreeActions>
          <a
            aria-label={`Download ${file.name}`}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            download={file.name}
            href={projectCatalogResourceUrl(file.resource.resourcePath)}
          >
            <Download className="size-3.5" aria-hidden="true" />
          </a>
        </FileTreeActions>
      ) : null}
    </FileTreeFile>
  );
}

function EmptyTreeLabel({ text }: { text: string }) {
  return <p className="px-2 py-1 text-xs text-muted-foreground">{text}</p>;
}

function branchCategories(
  branch: WorkspaceProjectCatalogSessionBranch,
  showHiddenFiles: boolean,
) {
  return [
    { key: "inputs", label: "Inputs", files: branch.inputs },
    { key: "deliveries", label: "Deliveries", files: branch.deliveries },
    ...(showHiddenFiles
      ? [{ key: "artifacts", label: "Artifacts", files: branch.artifacts }]
      : []),
    { key: "evidence", label: "Evidence", files: branch.evidence },
  ].filter((category) => category.files.length > 0);
}

function findCatalogFile(
  root: WorkspaceProjectCatalogRoot | null,
  branches: Record<string, WorkspaceProjectCatalogSessionBranch>,
  id: string,
): WorkspaceProjectCatalogFile | undefined {
  const files = [
    ...(root?.sharedInputs ?? []),
    ...Object.values(branches).flatMap((branch) => [
      ...branch.inputs,
      ...branch.deliveries,
      ...branch.artifacts,
      ...branch.evidence,
    ]),
  ];
  return files.find((file) => file.id === id);
}

function sessionPath(sessionId: string): string {
  return `session:${sessionId}`;
}

function categoryPath(sessionId: string, category: string): string {
  return `category:${sessionId}:${category}`;
}

function pruneCatalogBranches(
  branches: Record<string, WorkspaceProjectCatalogSessionBranch>,
  sessionIds: ReadonlySet<string>,
): Record<string, WorkspaceProjectCatalogSessionBranch> {
  if (Object.keys(branches).every((sessionId) => sessionIds.has(sessionId))) {
    return branches;
  }
  return Object.fromEntries(
    Object.entries(branches).filter(([sessionId]) => sessionIds.has(sessionId)),
  );
}

function pruneExpandedSessions(
  expanded: Set<string>,
  sessionIds: ReadonlySet<string>,
): Set<string> {
  const next = new Set(
    [...expanded].filter((path) => {
      if (path.startsWith("session:")) {
        return sessionIds.has(path.slice("session:".length));
      }
      if (path.startsWith("category:")) {
        const sessionId = path.slice("category:".length).split(":", 1)[0];
        return Boolean(sessionId && sessionIds.has(sessionId));
      }
      return true;
    }),
  );
  if (
    next.size === expanded.size &&
    [...next].every((path) => expanded.has(path))
  ) {
    return expanded;
  }
  return next;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
