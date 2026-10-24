import type * as http from "node:http";
import type { URL } from "node:url";

import type { RouteCredentialScope } from "../contracts/route-credentials.js";

export type { RouteCredentialScope };

export type RouteStage = "pre-auth-capability" | "api";

export type RouteAuthorization =
  | "public"
  | "api"
  | "api-or-broker"
  | "capability";

/**
 * How a route entry answers, for the inventory that describes the API.
 *
 * `mixed` exists because a prefix route stands in front of many endpoints and
 * they need not agree. Labelling such a route `none` denies the streams it
 * contains; labelling it `sse` claims its plain-JSON endpoints stream. Neither
 * is true, and dispatch reads none of the three, so the only cost of being
 * wrong here is a reader believing it.
 */
export type RouteStreaming = "none" | "sse" | "mixed";

export type RoutePathDescription =
  | { readonly kind: "exact"; readonly path: string }
  | { readonly kind: "prefix"; readonly prefix: string }
  | { readonly kind: "pattern"; readonly pattern: string };

export interface RouteContext<Services = unknown> {
  readonly req: http.IncomingMessage;
  readonly res: http.ServerResponse;
  readonly url: URL;
  readonly services: Services;
  /**
   * Which credential admitted this request, once the transport has decided.
   *
   * Absent before authentication runs, and absent for the whole request on a
   * server configured with no token — which authenticates nobody. A route that
   * changes durable state is expected to treat that absence as a refusal
   * rather than as permission.
   */
  readonly credentialScope?: RouteCredentialScope;
}

export type RouteHandler<Services = unknown> = (
  context: RouteContext<Services>,
) => boolean | Promise<boolean>;

export interface RouteRegistration<Services = unknown> {
  readonly id: string;
  readonly stage: RouteStage;
  readonly authorization: RouteAuthorization;
  readonly streaming: RouteStreaming;
  readonly methods: readonly string[];
  readonly path: RoutePathDescription;
  readonly handler: RouteHandler<Services>;
}

export interface RouteInventoryEntry {
  readonly order: number;
  readonly id: string;
  readonly stage: RouteStage;
  readonly authorization: RouteAuthorization;
  readonly streaming: RouteStreaming;
  readonly methods: readonly string[];
  readonly path: RoutePathDescription;
}

export async function dispatchRoutes<Services>(params: {
  readonly routes: readonly RouteRegistration<Services>[];
  readonly stage: RouteStage;
  readonly context: RouteContext<Services>;
}): Promise<boolean> {
  for (const route of params.routes) {
    if (route.stage !== params.stage) continue;
    if (await route.handler(params.context)) return true;
  }
  return false;
}

export function projectRouteInventory<Services>(
  routes: readonly RouteRegistration<Services>[],
): readonly RouteInventoryEntry[] {
  const inventory = routes.map((route, order): RouteInventoryEntry =>
    Object.freeze({
      order,
      id: route.id,
      stage: route.stage,
      authorization: route.authorization,
      streaming: route.streaming,
      methods: Object.freeze([...route.methods]),
      path: Object.freeze({ ...route.path }),
    }),
  );
  return Object.freeze(inventory);
}
