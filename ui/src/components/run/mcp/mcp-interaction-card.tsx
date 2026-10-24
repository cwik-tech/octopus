import { Check, ExternalLink, Waypoints, X } from "lucide-react";
import {
  useId,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  type McpApprovalInteraction,
  type McpElicitationFormValue,
  type McpFormElicitationInteraction,
  type McpFormFieldSchema,
  type McpInteraction,
  type McpInteractionResponse,
  type McpUrlElicitationInteraction,
} from "@/lib/clients/mcp-interactions-client";
import { cn } from "@/lib/utils/utils";
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
  type ConfirmationState,
} from "@/components/ai-elements/confirmation";

interface McpInteractionCardProps {
  interaction: McpInteraction;
  onRespond: (response: McpInteractionResponse) => Promise<McpInteraction>;
}

export function McpInteractionCard({
  interaction,
  onRespond,
}: McpInteractionCardProps) {
  if (interaction.kind === "approval") {
    return <ApprovalCard interaction={interaction} onRespond={onRespond} />;
  }
  if (interaction.mode === "form") {
    return <FormElicitationCard interaction={interaction} onRespond={onRespond} />;
  }
  return <UrlElicitationCard interaction={interaction} onRespond={onRespond} />;
}

function ApprovalCard({
  interaction,
  onRespond,
}: {
  interaction: McpApprovalInteraction;
  onRespond: McpInteractionCardProps["onRespond"];
}) {
  const [responding, setResponding] = useState<string | null>(null);
  const [responseError, setResponseError] = useState<string | null>(null);

  const respond = async (response: McpInteractionResponse, label: string) => {
    setResponding(label);
    setResponseError(null);
    try {
      await onRespond(response);
    } catch (error) {
      setResponseError(errorMessage(error));
    } finally {
      setResponding(null);
    }
  };

  return (
    <Confirmation
      approval={confirmationApproval(interaction)}
      state={confirmationState(interaction)}
      className="mx-auto max-w-2xl"
      role="group"
      aria-label="Approval required"
    >
      <ConfirmationTitle>
        <span>Approval required</span> · <code>{interaction.namespacedToolName}</code>
      </ConfirmationTitle>
      <ConfirmationRequest>
        <div className="space-y-2 text-xs">
          <p>An agent wants to perform this tool action.</p>
          <div className="flex flex-wrap items-center gap-2">
            <span className={riskClassName(interaction.toolRisk)}>
              {riskLabel(interaction.toolRisk)}
            </span>
            <span className="text-muted-foreground">
              Source: <code>{interaction.serverId}</code>
            </span>
          </div>
          <div>
            <span className="text-muted-foreground">Argument names:</span>{" "}
            {interaction.argumentNames.length > 0
              ? interaction.argumentNames.map((name) => (
                  <code
                    key={name}
                    className="mr-1 rounded bg-muted px-1.5 py-0.5 text-xs"
                  >
                    {name}
                  </code>
                ))
              : "None"}
          </div>
        </div>
      </ConfirmationRequest>

      {interaction.status === "pending" ? (
        <>
          {responseError ? <p role="alert" className="text-xs text-destructive">{responseError} You can retry.</p> : null}
          {responding ? <p role="status" className="text-xs text-muted-foreground">{responding}</p> : null}
          <ConfirmationActions>
            <ConfirmationAction
              disabled={Boolean(responding)}
              onClick={() => void respond({
                kind: "approval",
                decision: "approve",
                scope: "once",
              }, "Allowing once…")}
            >
              Allow once
            </ConfirmationAction>
            <ConfirmationAction
              variant="outline"
              disabled={Boolean(responding)}
              onClick={() => void respond({
                kind: "approval",
                decision: "approve",
                scope: "run",
              }, "Allowing for run…")}
            >
              Allow for run
            </ConfirmationAction>
            <ConfirmationAction
              variant="destructive"
              disabled={Boolean(responding)}
              onClick={() => void respond({
                kind: "approval",
                decision: "deny",
              }, "Denying…")}
            >
              Deny
            </ConfirmationAction>
          </ConfirmationActions>
        </>
      ) : null}
      <ConfirmationAccepted>
        <Check className="size-4" />
        <span>{approvalStatusLabel(interaction)}</span>
      </ConfirmationAccepted>
      <ConfirmationRejected>
        <X className="size-4" />
        <span>{approvalStatusLabel(interaction)}</span>
      </ConfirmationRejected>
    </Confirmation>
  );
}

function confirmationState(interaction: McpApprovalInteraction): ConfirmationState {
  if (interaction.status === "pending") return "approval-requested";
  if (interaction.status === "approved-once" || interaction.status === "approved-run") {
    return "output-available";
  }
  return "output-denied";
}

function confirmationApproval(interaction: McpApprovalInteraction) {
  if (interaction.status === "pending") return { id: interaction.interactionId };
  return {
    id: interaction.interactionId,
    approved:
      interaction.status === "approved-once" || interaction.status === "approved-run",
  };
}

function FormElicitationCard({
  interaction,
  onRespond,
}: {
  interaction: McpFormElicitationInteraction;
  onRespond: McpInteractionCardProps["onRespond"];
}) {
  const formId = useId();
  const [draft, setDraft] = useState<Record<string, FormDraftValue>>(() =>
    initialDraft(interaction),
  );
  const [touched, setTouched] = useState<Set<string>>(() => new Set());
  const [responding, setResponding] = useState<string | null>(null);
  const [responseError, setResponseError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  const updateField = (name: string, value: FormDraftValue) => {
    setDraft((current) => ({ ...current, [name]: value }));
    setTouched((current) => new Set(current).add(name));
    setValidationError(null);
    setResponseError(null);
  };

  const respond = async (
    response: McpInteractionResponse,
    label: string,
  ) => {
    setResponding(label);
    setResponseError(null);
    try {
      await onRespond(response);
    } catch (error) {
      setResponseError(errorMessage(error));
    } finally {
      setResponding(null);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!event.currentTarget.checkValidity()) {
      event.currentTarget.reportValidity();
      return;
    }
    const result = buildFormValues(interaction, draft, touched);
    if (result.error) {
      setValidationError(result.error);
      return;
    }
    void respond({
      kind: "elicitation",
      action: "accept",
      values: result.values,
    }, "Continuing…");
  };

  return (
    <InteractionShell
      icon={<Waypoints className="size-4 text-primary-text" />}
      title="Information requested"
      description={interaction.message}
      interaction={interaction}
    >
      {interaction.status === "pending" ? (
        <form id={formId} autoComplete="off" onSubmit={handleSubmit}>
          <div className="space-y-3">
            {Object.entries(interaction.schema.properties).map(([name, field]) => (
              <FormField
                key={name}
                interactionId={interaction.interactionId}
                name={name}
                field={field}
                required={interaction.schema.required.includes(name)}
                value={draft[name] ?? defaultDraftValue(field)}
                onChange={(value) => updateField(name, value)}
              />
            ))}
          </div>
          <InteractionActions
            error={validationError ?? responseError}
            responding={responding}
          >
            <Button size="sm" type="submit" disabled={Boolean(responding)}>
              Continue
            </Button>
            <Button
              size="sm"
              type="button"
              variant="outline"
              disabled={Boolean(responding)}
              onClick={() => void respond({
                kind: "elicitation",
                action: "decline",
              }, "Declining…")}
            >
              Decline
            </Button>
            <Button
              size="sm"
              type="button"
              variant="ghost"
              disabled={Boolean(responding)}
              onClick={() => void respond({
                kind: "elicitation",
                action: "cancel",
              }, "Cancelling…")}
            >
              Cancel
            </Button>
          </InteractionActions>
        </form>
      ) : (
        <ResolvedStatus>{elicitationStatusLabel(interaction)}</ResolvedStatus>
      )}
    </InteractionShell>
  );
}

function UrlElicitationCard({
  interaction,
  onRespond,
}: {
  interaction: McpUrlElicitationInteraction;
  onRespond: McpInteractionCardProps["onRespond"];
}) {
  const [responding, setResponding] = useState<string | null>(null);
  const [responseError, setResponseError] = useState<string | null>(null);
  const safeUrl = safeExternalUrl(interaction.url);

  const respond = async (
    response: McpInteractionResponse,
    label: string,
  ) => {
    setResponding(label);
    setResponseError(null);
    try {
      await onRespond(response);
    } catch (error) {
      setResponseError(errorMessage(error));
    } finally {
      setResponding(null);
    }
  };

  return (
    <InteractionShell
      icon={<ExternalLink className="size-4 text-primary-text" />}
      title="Action requested"
      description={interaction.message}
      interaction={interaction}
    >
      {interaction.status === "pending" ? (
        <>
          {safeUrl ? (
            <a
              href={safeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-primary-text underline-offset-4 hover:underline"
            >
              Open request in browser
              <ExternalLink className="size-3.5" />
            </a>
          ) : (
            <p role="alert" className="text-xs text-destructive">
              This request contains an unsafe link and cannot be opened.
            </p>
          )}
          <InteractionActions error={responseError} responding={responding}>
            <Button
              size="sm"
              disabled={Boolean(responding) || !safeUrl}
              onClick={() => void respond({
                kind: "elicitation",
                action: "accept",
              }, "Continuing…")}
            >
              Continue
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={Boolean(responding)}
              onClick={() => void respond({
                kind: "elicitation",
                action: "decline",
              }, "Declining…")}
            >
              Decline
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={Boolean(responding)}
              onClick={() => void respond({
                kind: "elicitation",
                action: "cancel",
              }, "Cancelling…")}
            >
              Cancel
            </Button>
          </InteractionActions>
        </>
      ) : (
        <ResolvedStatus>{elicitationStatusLabel(interaction)}</ResolvedStatus>
      )}
    </InteractionShell>
  );
}

function InteractionShell({
  icon,
  title,
  description,
  interaction,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  interaction: McpInteraction;
  children: ReactNode;
}) {
  return (
    <Card size="sm" className="w-full max-w-2xl border-l-4 border-l-primary/50">
      <CardHeader>
        <div className="flex items-center gap-2">
          {icon}
          <CardTitle>{title}</CardTitle>
        </div>
        <CardDescription>{description}</CardDescription>
        <div className="text-xs text-muted-foreground">
          Agent: <code>{interaction.agentPath}</code>
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function InteractionActions({
  error,
  responding,
  children,
}: {
  error: string | null;
  responding: string | null;
  children: ReactNode;
}) {
  return (
    <CardFooter className="mt-3 flex-wrap gap-2 px-0 pb-0">
      <div className="flex flex-wrap gap-2">{children}</div>
      {responding ? (
        <span role="status" className="text-xs text-muted-foreground">
          {responding}
        </span>
      ) : null}
      {error ? (
        <span role="alert" className="w-full text-xs text-destructive">
          {error} You can retry.
        </span>
      ) : null}
    </CardFooter>
  );
}

function ResolvedStatus({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="text-xs font-medium text-muted-foreground">
      {children}
    </p>
  );
}

type FormDraftValue = string | boolean | string[];

function FormField({
  interactionId,
  name,
  field,
  required,
  value,
  onChange,
}: {
  interactionId: string;
  name: string;
  field: McpFormFieldSchema;
  required: boolean;
  value: FormDraftValue;
  onChange: (value: FormDraftValue) => void;
}) {
  const baseId = `mcp-${safeIdPart(interactionId)}-${safeIdPart(name)}`;
  const descriptionId = field.description ? `${baseId}-description` : undefined;
  const label = field.title ?? name;

  if (field.type === "boolean") {
    return (
      <div className="space-y-1">
        <label className="flex items-center gap-2 text-sm font-medium" htmlFor={baseId}>
          <input
            id={baseId}
            type="checkbox"
            checked={value === true}
            aria-describedby={descriptionId}
            onChange={(event) => onChange(event.target.checked)}
          />
          {label}{required ? " *" : ""}
        </label>
        <FieldDescription id={descriptionId}>{field.description}</FieldDescription>
      </div>
    );
  }

  if (field.type === "array") {
    const selected = Array.isArray(value) ? value : [];
    const options = "enum" in field.items
      ? field.items.enum.map((entry) => ({ value: entry, label: entry }))
      : field.items.anyOf.map((entry) => ({
          value: entry.const,
          label: entry.title,
        }));
    return (
      <fieldset className="space-y-1.5" aria-describedby={descriptionId}>
        <legend className="text-sm font-medium">{label}{required ? " *" : ""}</legend>
        <FieldDescription id={descriptionId}>{field.description}</FieldDescription>
        <div className="grid gap-1 sm:grid-cols-2">
          {options.map((option, index) => {
            const optionId = `${baseId}-${index}`;
            return (
              <label key={option.value} htmlFor={optionId} className="flex items-center gap-2 text-sm">
                <input
                  id={optionId}
                  type="checkbox"
                  checked={selected.includes(option.value)}
                  onChange={(event) => onChange(event.target.checked
                    ? [...selected, option.value]
                    : selected.filter((entry) => entry !== option.value))}
                />
                {option.label}
              </label>
            );
          })}
        </div>
      </fieldset>
    );
  }

  if (field.type === "string" && ("enum" in field || "oneOf" in field)) {
    const options = "enum" in field
      ? field.enum.map((entry) => ({ value: entry, label: entry }))
      : field.oneOf.map((entry) => ({ value: entry.const, label: entry.title }));
    return (
      <div className="space-y-1">
        <label className="text-sm font-medium" htmlFor={baseId}>
          {label}{required ? " *" : ""}
        </label>
        <select
          id={baseId}
          value={typeof value === "string" ? value : ""}
          required={required}
          aria-describedby={descriptionId}
          onChange={(event) => onChange(event.target.value)}
          className="h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <option value="">Select an option</option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <FieldDescription id={descriptionId}>{field.description}</FieldDescription>
      </div>
    );
  }

  const stringField = field.type === "string" ? field : undefined;
  const inputType = !stringField
    ? "number"
    : stringField.format === "date"
      ? "date"
      : stringField.format === "email"
        ? "email"
        : stringField.format === "uri"
          ? "url"
          : "text";
  const dateTimePattern = stringField?.format === "date-time"
    ? String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})`
    : undefined;
  return (
    <div className="space-y-1">
      <label className="text-sm font-medium" htmlFor={baseId}>
        {label}{required ? " *" : ""}
      </label>
      <Input
        id={baseId}
        type={inputType}
        value={typeof value === "string" ? value : ""}
        required={required && (
          field.type !== "string" ||
          Boolean(field.format) ||
          (field.minLength ?? 0) > 0
        )}
        min={field.type === "number" || field.type === "integer" ? field.minimum : undefined}
        max={field.type === "number" || field.type === "integer" ? field.maximum : undefined}
        step={field.type === "integer" ? 1 : field.type === "number" ? "any" : undefined}
        minLength={field.type === "string" ? field.minLength : undefined}
        maxLength={field.type === "string" ? field.maxLength : undefined}
        pattern={dateTimePattern}
        placeholder={dateTimePattern ? "2026-07-12T14:30:00Z" : undefined}
        aria-describedby={descriptionId}
        onChange={(event) => onChange(event.target.value)}
      />
      <FieldDescription id={descriptionId}>{field.description}</FieldDescription>
    </div>
  );
}

function FieldDescription({
  id,
  children,
}: {
  id?: string | undefined;
  children?: string | undefined;
}) {
  return children ? <p id={id} className="text-xs text-muted-foreground">{children}</p> : null;
}

function initialDraft(
  interaction: McpFormElicitationInteraction,
): Record<string, FormDraftValue> {
  return Object.fromEntries(
    Object.entries(interaction.schema.properties).map(([name, field]) => [
      name,
      defaultDraftValue(field),
    ]),
  );
}

function defaultDraftValue(field: McpFormFieldSchema): FormDraftValue {
  if (field.type === "boolean") return field.default ?? false;
  if (field.type === "array") return field.default ? [...field.default] : [];
  if (field.type !== "string") {
    return field.default === undefined ? "" : String(field.default);
  }
  return field.default ?? "";
}

function buildFormValues(
  interaction: McpFormElicitationInteraction,
  draft: Record<string, FormDraftValue>,
  touched: ReadonlySet<string>,
): {
  values?: Record<string, McpElicitationFormValue>;
  error?: string;
} {
  const values: Record<string, McpElicitationFormValue> = {};
  for (const [name, field] of Object.entries(interaction.schema.properties)) {
    const required = interaction.schema.required.includes(name);
    const hasDefault = Object.hasOwn(field, "default");
    const include = required || touched.has(name) || hasDefault;
    if (!include) continue;
    const value = draft[name] ?? defaultDraftValue(field);

    if (field.type === "number" || field.type === "integer") {
      if (typeof value !== "string" || value.trim() === "") {
        if (required) return { error: `${field.title ?? name} is required.` };
        continue;
      }
      const numberValue = Number(value);
      if (
        !Number.isFinite(numberValue) ||
        (field.type === "integer" && !Number.isSafeInteger(numberValue))
      ) {
        return { error: `${field.title ?? name} must be a number.` };
      }
      if (field.minimum !== undefined && numberValue < field.minimum) {
        return { error: `${field.title ?? name} must be at least ${field.minimum}.` };
      }
      if (field.maximum !== undefined && numberValue > field.maximum) {
        return { error: `${field.title ?? name} must be at most ${field.maximum}.` };
      }
      values[name] = numberValue;
      continue;
    }

    if (field.type === "array") {
      const selected = Array.isArray(value) ? value : [];
      if (field.minItems !== undefined && selected.length < field.minItems) {
        return {
          error: `${field.title ?? name} requires at least ${field.minItems} selection${field.minItems === 1 ? "" : "s"}.`,
        };
      }
      if (field.maxItems !== undefined && selected.length > field.maxItems) {
        return {
          error: `${field.title ?? name} allows at most ${field.maxItems} selection${field.maxItems === 1 ? "" : "s"}.`,
        };
      }
      values[name] = selected;
      continue;
    }

    if (field.type === "boolean") {
      values[name] = value === true;
      continue;
    }

    const stringValue = typeof value === "string" ? value : "";
    if (!required && stringValue === "") continue;
    const stringLength = [...stringValue].length;
    if ("minLength" in field && field.minLength !== undefined && stringLength < field.minLength) {
      return { error: `${field.title ?? name} must contain at least ${field.minLength} characters.` };
    }
    if ("maxLength" in field && field.maxLength !== undefined && stringLength > field.maxLength) {
      return { error: `${field.title ?? name} must contain at most ${field.maxLength} characters.` };
    }
    values[name] = stringValue;
  }
  return { values };
}

function safeExternalUrl(value: string): string | null {
  if (/[^\x20-\x7e]/.test(value) || /\s/.test(value)) return null;
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username ||
      parsed.password ||
      parsed.hash
    ) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

function safeIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "-");
}

function riskClassName(risk: McpApprovalInteraction["toolRisk"]): string {
  return cn(
    "rounded-full px-2 py-0.5 font-medium",
    risk === "read-only"
      ? "bg-blue-500/10 text-blue-700 dark:text-blue-300"
      : "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  );
}

function riskLabel(risk: McpApprovalInteraction["toolRisk"]): string {
  return `${risk.replace("-", " ")} tool`;
}

function approvalStatusLabel(interaction: McpApprovalInteraction): string {
  if (interaction.status === "approved-once") return "Allowed once.";
  if (interaction.status === "approved-run") return "Allowed for this run.";
  if (interaction.status === "denied") return "Denied.";
  return `Request ${interaction.status}.`;
}

function elicitationStatusLabel(
  interaction: McpFormElicitationInteraction | McpUrlElicitationInteraction,
): string {
  if (interaction.status === "accepted") return "Response accepted.";
  if (interaction.status === "declined") return "Request declined.";
  if (interaction.status === "cancelled") return "Request cancelled.";
  return `Request ${interaction.status}.`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The response could not be sent.";
}
