import {
  Braces,
  CheckCircle2,
  KeyRound,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { parseMcpConnectionJson } from "@/components/settings/mcp-connection-json";
import {
  type McpAuthenticationChoice,
  type McpSecretRow,
  type McpServerDraft,
} from "@/components/settings/mcp-connection-draft";
import { McpCapabilityAliasEditor } from "@/components/settings/mcp-capability-alias-editor";
import { FieldHelp } from "@/components/ui/field-help";
import { type McpTransportKind } from "@/lib/clients/mcp-settings-client";

let nextNewSecretRowId = 1;

export function McpConnectionEditor({
  draft,
  busy,
  onChange,
  onCancel,
  onSubmit,
}: {
  draft: McpServerDraft;
  busy: boolean;
  onChange: (draft: McpServerDraft) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const [entryMode, setEntryMode] = useState<"form" | "json">("form");
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [importNotice, setImportNotice] = useState<string | null>(null);

  function updateTransportType(transportType: McpTransportKind): void {
    onChange({
      ...draft,
      transportType,
      secrets: [],
      originalSecretKeys: [],
      stdioTrustAcknowledged: false,
    });
  }

  return (
    <form
      className="space-y-5 rounded-xl border border-border/70 bg-muted/20 p-4"
      aria-label={draft.id ? "Edit MCP connection" : "Add MCP connection"}
      onSubmit={(event) => {
        event.preventDefault();
        if (entryMode === "form") onSubmit();
      }}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold">
            {draft.id ? "Edit MCP connection" : "Add MCP connection"}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Saving validates the server before it becomes available to agents.
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close editor"
          onClick={onCancel}
        >
          <X />
        </Button>
      </div>

      {!draft.id ? (
        <div
          className="inline-flex w-fit rounded-lg border border-border/70 bg-background p-1"
          role="group"
          aria-label="Connection setup method"
        >
          <Button
            type="button"
            size="sm"
            variant={entryMode === "form" ? "secondary" : "ghost"}
            aria-pressed={entryMode === "form"}
            onClick={() => {
              setEntryMode("form");
              setJsonError(null);
            }}
          >
            Enter manually
          </Button>
          <Button
            type="button"
            size="sm"
            variant={entryMode === "json" ? "secondary" : "ghost"}
            aria-pressed={entryMode === "json"}
            onClick={() => setEntryMode("json")}
          >
            <Braces />
            Paste JSON
          </Button>
        </div>
      ) : null}

      {entryMode === "json" && !draft.id ? (
        <JsonImportPanel
          value={jsonText}
          error={jsonError}
          onChange={(value) => {
            setJsonText(value);
            setJsonError(null);
          }}
          onApply={() => {
            const result = parseMcpConnectionJson(jsonText);
            if (!result.ok) {
              setJsonError(result.error);
              return;
            }
            onChange(result.draft);
            setImportNotice(
              result.secretCount > 0
                ? `${result.importedName || "Connection"} imported from JSON. Review the fields and ${result.secretCount} imported secret ${result.secretCount === 1 ? "value" : "values"}, replace any placeholders, then save and validate.`
                : `${result.importedName || "Connection"} imported from JSON. Review the fields, then save and validate.`,
            );
            setEntryMode("form");
            setJsonError(null);
          }}
          onCancel={onCancel}
        />
      ) : (
        <>
          {importNotice ? (
            <p role="status" className="rounded-lg border border-primary/25 bg-primary/5 p-3 text-sm">
              {importNotice}
            </p>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-1.5 text-sm">
              <span className="font-medium">Name</span>
              <Input
                value={draft.name}
                autoFocus
                onChange={(event) => onChange({ ...draft, name: event.target.value })}
              />
            </label>
            <div className="space-y-1.5 text-sm">
              <div className="flex items-center gap-1">
                <label htmlFor="mcp-transport" className="font-medium">Transport</label>
                <FieldHelp label="Help: transport selection">
                  Choose <span className="font-mono">stdio</span> when the provider gives
                  you a command to run locally. Choose Streamable HTTP when it gives you
                  a remote URL, usually ending in <span className="font-mono">/mcp</span>.
                </FieldHelp>
              </div>
              <select
                id="mcp-transport"
                value={draft.transportType}
                aria-label="MCP transport"
                className="h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                onChange={(event) => updateTransportType(event.target.value as McpTransportKind)}
              >
                <option value="stdio">stdio</option>
                <option value="streamable-http">Streamable HTTP</option>
              </select>
            </div>
          </div>

          {draft.transportType === "stdio" ? (
            <>
              <StdioEditor draft={draft} onChange={onChange} />
              <label className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
                <input
                  type="checkbox"
                  checked={draft.stdioTrustAcknowledged}
                  className="mt-0.5 size-4 shrink-0 accent-primary"
                  onChange={(event) => onChange({
                    ...draft,
                    stdioTrustAcknowledged: event.target.checked,
                  })}
                />
                <span>
                  I trust this command and understand validation will run it locally on this computer.
                </span>
              </label>
            </>
          ) : (
            <HttpEditor draft={draft} onChange={onChange} />
          )}

          <McpCapabilityAliasEditor
            aliases={draft.capabilityAliases}
            onChange={(capabilityAliases) => onChange({
              ...draft,
              capabilityAliases,
            })}
          />

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={busy || (
                draft.transportType === "stdio" && !draft.stdioTrustAcknowledged
              )}
            >
              {busy ? <RefreshCw className="animate-spin" /> : <CheckCircle2 />}
              {busy ? "Saving and validating..." : "Save & Validate"}
            </Button>
          </div>
        </>
      )}
    </form>
  );
}

function JsonImportPanel({
  value,
  error,
  onChange,
  onApply,
  onCancel,
}: {
  value: string;
  error: string | null;
  onChange: (value: string) => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  return (
    <section className="space-y-4" aria-labelledby="mcp-json-import-heading">
      <div>
        <h4 id="mcp-json-import-heading" className="font-medium">Paste MCP configuration JSON</h4>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Paste one connection copied from a provider. Claude/Cursor
          <span className="font-mono"> mcpServers </span>
          JSON, VS Code <span className="font-mono">servers</span> JSON, and a single
          server object are supported. You will review the imported fields before anything runs.
        </p>
      </div>
      <Textarea
        value={value}
        aria-label="MCP configuration JSON"
        className="min-h-64 font-mono text-xs"
        spellCheck={false}
        placeholder={'{\n  "mcpServers": {\n    "mcp-docs": {\n      "type": "streamable-http",\n      "url": "https://modelcontextprotocol.io/mcp"\n    }\n  }\n}'}
        onChange={(event) => onChange(event.target.value)}
      />
      {error ? (
        <p role="alert" className="text-sm text-destructive">{error}</p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="button" disabled={!value.trim()} onClick={onApply}>
          <Braces />
          Apply JSON
        </Button>
      </div>
    </section>
  );
}

function StdioEditor({
  draft,
  onChange,
}: {
  draft: McpServerDraft;
  onChange: (draft: McpServerDraft) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-1.5 text-sm">
        <div className="flex items-center gap-1">
          <label htmlFor="mcp-command" className="font-medium">Command</label>
          <FieldHelp label="Help: local command">
            The executable that starts the local MCP server. If the provider shows
            <span className="font-mono"> npx -y @company/mcp-server</span>, enter
            <span className="font-mono"> npx</span> here.
          </FieldHelp>
        </div>
        <Input
          id="mcp-command"
          value={draft.command}
          className="font-mono"
          placeholder="node"
          autoComplete="off"
          onChange={(event) => onChange({ ...draft, command: event.target.value })}
        />
      </div>
      <div className="space-y-1.5 text-sm">
        <div className="flex items-center gap-1">
          <label htmlFor="mcp-arguments" className="font-medium">Arguments</label>
          <FieldHelp label="Help: command arguments">
            Everything after the command, in the same order, with one item per line.
            For <span className="font-mono">npx -y @company/mcp-server</span>, enter
            <span className="font-mono"> -y</span> and
            <span className="font-mono"> @company/mcp-server</span> on separate lines.
          </FieldHelp>
        </div>
        <Textarea
          id="mcp-arguments"
          value={draft.argsText}
          aria-label="Arguments, one per line"
          className="min-h-24 font-mono"
          placeholder={"server.mjs\n--read-only"}
          onChange={(event) => onChange({ ...draft, argsText: event.target.value })}
        />
        <span className="block text-xs text-muted-foreground">Enter one argument per line.</span>
      </div>
      <div className="space-y-1.5 text-sm">
        <div className="flex items-center gap-1">
          <label htmlFor="mcp-working-directory" className="font-medium">
            Working directory (optional)
          </label>
          <FieldHelp label="Help: working folder">
            The folder where the local process starts. Leave it empty unless the
            provider specifies a folder or the server uses relative file paths.
          </FieldHelp>
        </div>
        <Input
          id="mcp-working-directory"
          value={draft.cwd}
          className="font-mono"
          placeholder="/absolute/path"
          onChange={(event) => onChange({ ...draft, cwd: event.target.value })}
        />
      </div>
      <SecretRowsEditor
        label="Secret environment variables"
        helpLabel="Help: environment secrets"
        help={
          <>
            Credentials the local server reads by variable name, such as
            <span className="font-mono"> API_KEY</span>. Add the key and value here;
            values are encrypted and are not placed in command arguments.
          </>
        }
        keyPlaceholder="VARIABLE_NAME"
        rows={draft.secrets}
        originalKeys={draft.originalSecretKeys}
        onChange={(secrets) => onChange({ ...draft, secrets })}
      />
    </div>
  );
}

function HttpEditor({
  draft,
  onChange,
}: {
  draft: McpServerDraft;
  onChange: (draft: McpServerDraft) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-1.5 text-sm">
        <div className="flex items-center gap-1">
          <label htmlFor="mcp-url" className="font-medium">MCP URL</label>
          <FieldHelp label="Help: remote endpoint">
            The full Streamable HTTP endpoint supplied by the provider, usually
            ending in <span className="font-mono">/mcp</span>. Do not enter the
            provider&apos;s website homepage or a deprecated
            <span className="font-mono"> /sse</span> endpoint.
          </FieldHelp>
        </div>
        <Input
          id="mcp-url"
          type="url"
          value={draft.url}
          placeholder="https://example.com/mcp"
          onChange={(event) => onChange({ ...draft, url: event.target.value })}
        />
      </div>
      <div className="space-y-1.5 text-sm">
        <div className="flex items-center gap-1">
          <label htmlFor="mcp-authentication" className="font-medium">Authentication</label>
          <FieldHelp label="Help: HTTP authentication choice">
            Use None for a public endpoint. Use Secret headers when the provider
            gives you an API key or token to send as an HTTP header. OAuth support
            is coming later.
          </FieldHelp>
        </div>
        <select
          id="mcp-authentication"
          value={draft.authentication}
          aria-label="HTTP authentication"
          className="h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          onChange={(event) => onChange({
            ...draft,
            authentication: event.target.value as McpAuthenticationChoice,
          })}
        >
          <option value="none">None</option>
          <option value="secret-headers">Secret headers</option>
          <option value="oauth" disabled>
            OAuth (coming later)
          </option>
        </select>
      </div>

      {draft.authentication === "secret-headers" ? (
        <SecretRowsEditor
          label="Secret headers"
          helpLabel="Help: secret HTTP headers"
          help={
            <>
              HTTP header names and secret values exactly as documented by the
              provider. For example, an <span className="font-mono">Authorization</span>
              value may need to include <span className="font-mono">Bearer </span>
              before the token. Values are encrypted.
            </>
          }
          keyPlaceholder="Authorization"
          rows={draft.secrets}
          originalKeys={draft.originalSecretKeys}
          onChange={(secrets) => onChange({ ...draft, secrets })}
        />
      ) : null}

      {draft.authentication === "oauth" ? (
        <div className="space-y-4 rounded-lg border border-border/70 p-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <KeyRound className="size-4" />
            OAuth metadata
          </div>
          <p className="text-xs text-muted-foreground">
            Existing OAuth metadata is preserved for forward compatibility, but OAuth
            connections cannot be validated yet. Choose None or Secret headers to use this MCP now.
          </p>
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium">Authorization server URL (optional)</span>
            <Input
              type="url"
              value={draft.authorizationServerUrl}
              onChange={(event) => onChange({
                ...draft,
                authorizationServerUrl: event.target.value,
              })}
            />
          </label>
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium">Client ID (optional)</span>
            <Input
              value={draft.clientId}
              autoComplete="off"
              onChange={(event) => onChange({ ...draft, clientId: event.target.value })}
            />
          </label>
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium">Scopes</span>
            <Textarea
              value={draft.scopesText}
              aria-label="OAuth scopes, one per line"
              className="min-h-20 font-mono"
              placeholder={"mcp:tools\nmcp:resources"}
              onChange={(event) => onChange({ ...draft, scopesText: event.target.value })}
            />
            <span className="block text-xs text-muted-foreground">Enter one scope per line.</span>
          </label>
        </div>
      ) : null}
    </div>
  );
}

function SecretRowsEditor({
  label,
  helpLabel,
  help,
  keyPlaceholder,
  rows,
  originalKeys,
  onChange,
}: {
  label: string;
  helpLabel?: string;
  help?: ReactNode;
  keyPlaceholder: string;
  rows: McpSecretRow[];
  originalKeys: string[];
  onChange: (rows: McpSecretRow[]) => void;
}) {
  return (
    <fieldset className="space-y-2 rounded-lg border border-border/70 p-3">
      <legend className="sr-only">{label}</legend>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <span className="px-1 text-sm font-medium">{label}</span>
          {help ? (
            <FieldHelp label={helpLabel ?? `Help for ${label.toLowerCase()}`}>
              {help}
            </FieldHelp>
          ) : null}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onChange([
            ...rows,
            { id: `new-${nextNewSecretRowId++}`, key: "", value: "" },
          ])}
        >
          <Plus />
          Add secret
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No secret values configured.</p>
      ) : (
        rows.map((row, index) => {
          const stored = originalKeys.includes(row.key);
          return (
            <div
              key={row.id}
              className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_auto] gap-2"
            >
              <Input
                value={row.key}
                aria-label={`${label} key ${index + 1}`}
                className="font-mono"
                placeholder={keyPlaceholder}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => onChange(rows.map((candidate) =>
                  candidate.id === row.id
                    ? { ...candidate, key: event.target.value }
                    : candidate,
                ))}
              />
              <Input
                type="password"
                value={row.value}
                aria-label={`${label} value ${index + 1}`}
                className="font-mono"
                placeholder={stored ? "Stored secret — blank preserves it" : "Secret value"}
                autoComplete="new-password"
                onChange={(event) => onChange(rows.map((candidate) =>
                  candidate.id === row.id
                    ? { ...candidate, value: event.target.value }
                    : candidate,
                ))}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${row.key || `${label} row ${index + 1}`}`}
                onClick={() => onChange(rows.filter((candidate) => candidate.id !== row.id))}
              >
                <X />
              </Button>
            </div>
          );
        })
      )}
    </fieldset>
  );
}
