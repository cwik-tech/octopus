import {
  Cable,
  FileCode2,
  FileSpreadsheet,
  FileText,
  Globe,
} from "lucide-react";
import { type ReactNode } from "react";

import { AgentMcpGrants } from "@/components/create/agent-mcp-grants";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils/utils";

export function AgentToolsPanel({
  agentName,
  webResearchEnabled,
  personaAvailable,
  browserDomainsRestricted,
  browserDomains,
  generateWordEnabled,
  generateExcelEnabled,
  savingPersona,
  saveError,
  onWebResearchEnabledChange,
  onBrowserDomainsRestrictedChange,
  onBrowserDomainsChange,
  onGenerateWordEnabledChange,
  onGenerateExcelEnabledChange,
  onBrowserDomainsBlur,
  scripts,
}: {
  agentName: string | null;
  webResearchEnabled: boolean;
  personaAvailable: boolean;
  browserDomainsRestricted: boolean;
  browserDomains: string;
  generateWordEnabled: boolean;
  generateExcelEnabled: boolean;
  savingPersona: boolean;
  saveError: string | null;
  onWebResearchEnabledChange: (enabled: boolean) => void;
  onBrowserDomainsRestrictedChange: (restricted: boolean) => void;
  onBrowserDomainsChange: (domains: string) => void;
  onGenerateWordEnabledChange: (enabled: boolean) => void;
  onGenerateExcelEnabledChange: (enabled: boolean) => void;
  onBrowserDomainsBlur: () => void;
  scripts: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-border/60 p-3">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                <Globe
                  className={cn(
                    "size-4",
                    webResearchEnabled
                      ? "text-sky-400"
                      : "text-muted-foreground/60",
                  )}
                />
              </span>
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  Web research
                  <Badge variant="secondary" className="h-5 px-1.5 text-xs">
                    Built-in
                  </Badge>
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Uses configured search providers and governed page acquisition,
                  with managed Chrome fallback.
                </span>
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Switch
                checked={webResearchEnabled}
                disabled={!personaAvailable || savingPersona}
                onCheckedChange={onWebResearchEnabledChange}
                aria-label="Toggle Web research"
              />
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                <FileText
                  className={cn(
                    "size-4",
                    generateWordEnabled
                      ? "text-blue-400"
                      : "text-muted-foreground/60",
                  )}
                />
              </span>
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  Generate Word
                  <Badge variant="secondary" className="h-5 px-1.5 text-xs">
                    Built-in
                  </Badge>
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Generate formatted Word files from Markdown.
                </span>
              </span>
            </div>
            <Switch
              checked={generateWordEnabled}
              disabled={!personaAvailable || savingPersona}
              onCheckedChange={onGenerateWordEnabledChange}
              aria-label="Toggle Generate Word"
            />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                <FileSpreadsheet
                  className={cn(
                    "size-4",
                    generateExcelEnabled
                      ? "text-emerald-400"
                      : "text-muted-foreground/60",
                  )}
                />
              </span>
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  Generate Excel
                  <Badge variant="secondary" className="h-5 px-1.5 text-xs">
                    Built-in
                  </Badge>
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Generate Excel workbooks from Markdown tables or curated templates.
                </span>
              </span>
            </div>
            <Switch
              checked={generateExcelEnabled}
              disabled={!personaAvailable || savingPersona}
              onCheckedChange={onGenerateExcelEnabledChange}
              aria-label="Toggle Generate Excel"
            />
          </div>
        </div>
        {webResearchEnabled ? (
          <div className="mt-3 space-y-3">
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2.5">
              <div>
                <p className="text-xs font-medium">Restrict websites</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Limits managed-browser fallback to the listed domains and the
                  saved browser profile.
                </p>
              </div>
              <Switch
                checked={browserDomainsRestricted}
                disabled={!personaAvailable || savingPersona}
                onCheckedChange={onBrowserDomainsRestrictedChange}
                aria-label="Toggle website restrictions"
              />
            </div>
            {browserDomainsRestricted ? (
              <div className="space-y-1.5">
                <label htmlFor="agent-browser-domains" className="text-xs font-medium">
                  Allowed browser domains
                </label>
                <Input
                  id="agent-browser-domains"
                  value={browserDomains}
                  disabled={savingPersona}
                  onBlur={onBrowserDomainsBlur}
                  placeholder="example.com, *.research.example.org"
                  onChange={(event) => onBrowserDomainsChange(event.currentTarget.value)}
                />
                <p className="text-xs text-muted-foreground">
                  HTTPS only. Add both <code>domain.com</code> and <code>*.domain.com</code> when both are needed.
                </p>
              </div>
            ) : null}
          </div>
        ) : null}
        {saveError ? (
          <p className="mt-2 text-xs text-destructive" role="alert">{saveError}</p>
        ) : null}
      </div>

      <Tabs defaultValue="mcps" className="min-h-0 flex-1 gap-0">
        <div className="shrink-0 border-b border-border/60 px-3 py-2">
          <TabsList aria-label="Agent tool types">
            <TabsTrigger value="mcps">
              <Cable />
              MCPs
            </TabsTrigger>
            <TabsTrigger value="scripts">
              <FileCode2 />
              Scripts
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="mcps" className="min-h-0 flex-1 overflow-y-auto p-3">
          <AgentMcpGrants key={agentName ?? "no-agent"} agentName={agentName} />
        </TabsContent>
        <TabsContent value="scripts" className="min-h-0 flex-1 overflow-y-auto p-3">
          {scripts}
        </TabsContent>
      </Tabs>
    </div>
  );
}
