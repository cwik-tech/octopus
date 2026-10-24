import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { WebshareSettings } from "@/components/settings/webshare-settings";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("saves encrypted-credential inputs without redisplaying secret values", async () => {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  let configured = false;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: url.pathname, method: init?.method ?? "GET", body });
    if (init?.method === "PATCH") configured = true;
    return jsonResponse({
      schemaVersion: 1,
      proxyEnabled: configured,
      credentialMode: "username-password",
      proxyHost: "p.webshare.io",
      proxyPort: 80,
      countries: ["us", "gb"],
      username: configured ? "workspace-user" : "",
      source: configured ? "persisted" : "default",
      apiTokenConfigured: false,
      passwordConfigured: configured,
      proxyStatus: "unverified",
    });
  }));

  render(<WebshareSettings />);
  expect(await screen.findByDisplayValue("p.webshare.io")).toBeInTheDocument();

  const user = userEvent.setup();
  await user.click(screen.getByRole("switch", { name: "Use Webshare proxy" }));
  await user.type(screen.getByLabelText("Username"), "workspace-user");
  await user.type(screen.getByLabelText("Password"), "private-password");
  await user.click(screen.getByRole("button", { name: "Save settings" }));

  await waitFor(() => expect(calls).toContainEqual({
    path: "/api/settings/youtube",
    method: "PATCH",
    body: {
      proxyEnabled: true,
      credentialMode: "username-password",
      proxyHost: "p.webshare.io",
      proxyPort: 80,
      countries: ["us", "gb"],
      username: "workspace-user",
      password: "private-password",
    },
  }));
  expect(screen.getByLabelText("Password")).toHaveValue("");
  expect(screen.getByPlaceholderText("Saved; leave blank to keep")).toBeInTheDocument();
});

it("recovers from an initial load failure through an explicit retry", async () => {
  let attempts = 0;
  vi.stubGlobal("fetch", vi.fn(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("Settings service unavailable");
    return jsonResponse(defaultSnapshot());
  }));
  render(<WebshareSettings />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Settings service unavailable");
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Retry loading settings" }));
  expect(await screen.findByDisplayValue("p.webshare.io")).toBeEnabled();
  expect(attempts).toBe(2);
});

it("renders environment-managed settings as read-only", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
    ...defaultSnapshot(),
    source: "environment",
    proxyEnabled: true,
    credentialMode: "api-token",
    apiTokenConfigured: true,
  })));
  render(<WebshareSettings />);
  expect(await screen.findByText(/come from environment variables/i)).toBeInTheDocument();
  expect(screen.getByLabelText("Proxy host")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
});

it("submits explicit secret clearing and preserves the selected credential mode", async () => {
  const calls: Array<{ method: string; body?: Record<string, unknown> | undefined }> = [];
  vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ method: init?.method ?? "GET", body });
    return jsonResponse({
      ...defaultSnapshot(),
      source: "persisted",
      credentialMode: "api-token",
      apiTokenConfigured: init?.method === "PATCH" ? false : true,
    });
  }));
  render(<WebshareSettings />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Clear saved API token" }));
  await user.click(screen.getByRole("button", { name: "Save settings" }));
  await waitFor(() => expect(calls).toContainEqual({
    method: "PATCH",
    body: {
      proxyEnabled: false,
      credentialMode: "api-token",
      proxyHost: "p.webshare.io",
      proxyPort: 80,
      countries: ["us"],
      username: "",
      clearApiToken: true,
    },
  }));
});

it("does not validate a stale saved snapshot while draft changes are unsaved", async () => {
  const fetchMock = vi.fn(async () => jsonResponse({
    ...defaultSnapshot(),
    source: "persisted",
    proxyEnabled: true,
    credentialMode: "api-token",
    apiTokenConfigured: true,
  }));
  vi.stubGlobal("fetch", fetchMock);
  render(<WebshareSettings />);
  const host = await screen.findByLabelText("Proxy host");
  const user = userEvent.setup();
  await user.clear(host);
  await user.type(host, "proxy.example.com");
  expect(screen.getByRole("button", { name: "Test connection" })).toBeDisabled();
  expect(screen.getByText("Save changes before testing.")).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function defaultSnapshot() {
  return {
    schemaVersion: 1 as const,
    proxyEnabled: false,
    credentialMode: "username-password" as const,
    proxyHost: "p.webshare.io",
    proxyPort: 80,
    countries: ["us"],
    username: "",
    source: "default" as const,
    apiTokenConfigured: false,
    passwordConfigured: false,
    proxyStatus: "unverified" as const,
  };
}
