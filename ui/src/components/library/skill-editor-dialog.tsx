import { Plus, Trash2, Upload } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import {
  createResourceSkill,
  saveResourceSkillRevision,
  type ResourceSkillMutation,
} from "@/lib/clients/resource-library-client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldHelp } from "@/components/ui/field-help";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type {
  ResourceLibraryRevisionFiles,
  ResourceLibrarySkill,
} from "@contracts/resource-library";

interface EditorFile {
  path: string;
  contentBase64: string;
  text: string | null;
  executable: boolean;
}

export function SkillEditorDialog({
  open,
  skill,
  initialFiles,
  expectedGeneration,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  skill?: ResourceLibrarySkill | undefined;
  initialFiles?: ResourceLibraryRevisionFiles | undefined;
  expectedGeneration: number;
  onOpenChange: (open: boolean) => void;
  onSaved: (result: ResourceSkillMutation) => void;
}) {
  const [slug, setSlug] = useState(skill?.slug ?? "new-skill");
  const [changeNote, setChangeNote] = useState("");
  const [files, setFiles] = useState<EditorFile[]>(() =>
    initialFiles ? initialFiles.files.map(toEditorFile) : [newSkillDocument("new-skill")]
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reportSaveError = (message: string) => {
    setError(message);
    toast.error("Could not save revision", { description: message });
  };

  const save = async () => {
    setError(null);
    if (!slug.trim()) {
      reportSaveError("Skill slug is required.");
      return;
    }
    if (files.some((file) => !file.path.trim())) {
      reportSaveError("Every supporting file needs a relative path.");
      return;
    }
    if (!files.some((file) => file.path === "SKILL.md")) {
      reportSaveError("The revision must contain SKILL.md.");
      return;
    }
    setPending(true);
    try {
      const inputFiles = files.map((file) => ({
        path: file.path,
        contentBase64: file.contentBase64,
        executable: file.executable,
      }));
      const result = skill
        ? await saveResourceSkillRevision({
            skillId: skill.id,
            baseRevisionId: skill.currentRevisionId,
            changeNote,
            expectedGeneration,
            files: inputFiles,
          })
        : await createResourceSkill({
            slug,
            changeNote,
            expectedGeneration,
            files: inputFiles,
          });
      if (result.unchanged) {
        toast.info("No changes to save", {
          description: `The files match Revision ${result.revision.sequence}. No new revision was created.`,
        });
      } else {
        toast.success(`Revision ${result.revision.sequence} saved`, { description: result.skill.displayName });
      }
      onSaved(result);
      onOpenChange(false);
    } catch (nextError) {
      reportSaveError(errorMessage(nextError));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={pending ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{skill ? `Edit ${skill.displayName}` : "Create a skill"}</DialogTitle>
          <DialogDescription>
            Text changes, supporting files, and binary replacements are saved together as one revision.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[65vh] min-w-0 space-y-4 overflow-y-auto pr-1">
          {!skill ? (
            <label className="block text-sm">
              <span className="mb-1 block font-medium">Skill slug</span>
              <Input
                value={slug}
                onChange={(event) => {
                  const next = event.target.value;
                  setSlug(next);
                  setFiles((current) => current.map((file) => {
                    if (file.path !== "SKILL.md" || file.text === null) return file;
                    const text = file.text.replace(/name: .*$/m, `name: ${next}`);
                    return { ...file, text, contentBase64: encodeBase64(text) };
                  }));
                }}
              />
            </label>
          ) : null}
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Change note</span>
            <Input
              value={changeNote}
              placeholder={skill ? "What changed in this revision?" : "Initial skill"}
              onChange={(event) => setChangeNote(event.target.value)}
            />
          </label>
          <div className="space-y-3">
            {files.map((file, index) => (
              <div key={index} className="rounded-xl border border-border/70 p-3">
                <div className="flex items-center gap-2">
                  <Input
                    aria-label={`Path for file ${index + 1}`}
                    value={file.path}
                    onChange={(event) => updateFile(setFiles, index, { path: event.target.value })}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    aria-pressed={file.executable}
                    onClick={() => updateFile(setFiles, index, { executable: !file.executable })}
                  >
                    {file.executable ? "Executable" : "Not executable"}
                  </Button>
                  <FieldHelp label={`About executable files for file ${index + 1}`}>
                    Executable lets the system run this file directly, such as a script. Leave it off for instructions, notes, and data files. Saving this setting does not run the file.
                  </FieldHelp>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Remove file ${index + 1}`}
                    disabled={files.length === 1}
                    onClick={() => setFiles((current) => current.filter((_, candidate) => candidate !== index))}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
                {file.text !== null ? (
                  <Textarea
                    aria-label={`Contents for file ${index + 1}`}
                    value={file.text}
                    onChange={(event) => updateFile(setFiles, index, {
                      text: event.target.value,
                      contentBase64: encodeBase64(event.target.value),
                    })}
                    className="mt-3 min-h-32 font-mono text-xs"
                  />
                ) : (
                  <div className="mt-3 text-xs text-muted-foreground">
                    Binary file · {byteLength(file.contentBase64)} bytes
                  </div>
                )}
                <label className="mt-3 inline-flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                  <Upload className="size-3.5" aria-hidden="true" />
                  Replace file
                  <Input
                    type="file"
                    className="hidden"
                    onChange={(event) => void replaceFile(event, index, setFiles)}
                  />
                </label>
              </div>
            ))}
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setFiles((current) => [...current, {
              path: "references/notes.md",
              contentBase64: encodeBase64(""),
              text: "",
              executable: false,
            }])}
          >
            <Plus aria-hidden="true" /> Add supporting file
          </Button>
        </div>
        {error ? <p className="max-h-24 overflow-y-auto text-sm text-destructive" role="alert">{error}</p> : null}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" disabled={pending} onClick={() => void save()}>
            {pending ? "Saving…" : "Save revision"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function toEditorFile(file: ResourceLibraryRevisionFiles["files"][number]): EditorFile {
  return {
    path: file.path,
    contentBase64: file.contentBase64,
    text: decodeBase64(file.contentBase64),
    executable: file.executable,
  };
}

function newSkillDocument(slug: string): EditorFile {
  const text = `---\nname: ${slug}\ndescription: Explains the task. Use when the task needs this skill.\n---\n\n# Instructions\n`;
  return {
    path: "SKILL.md",
    contentBase64: encodeBase64(text),
    text,
    executable: false,
  };
}

function updateFile(
  setFiles: React.Dispatch<React.SetStateAction<EditorFile[]>>,
  index: number,
  update: Partial<EditorFile>,
): void {
  setFiles((current) => current.map((file, candidate) =>
    candidate === index ? { ...file, ...update } : file
  ));
}

async function replaceFile(
  event: React.ChangeEvent<HTMLInputElement>,
  index: number,
  setFiles: React.Dispatch<React.SetStateAction<EditorFile[]>>,
): Promise<void> {
  const selected = event.target.files?.[0];
  if (!selected) return;
  const contentBase64 = encodeBase64(new Uint8Array(await selected.arrayBuffer()));
  updateFile(setFiles, index, {
    contentBase64,
    text: decodeBase64(contentBase64),
  });
  event.target.value = "";
}

function decodeBase64(value: string): string | null {
  try {
    const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function encodeBase64(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function byteLength(value: string): number {
  return atob(value).length;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
