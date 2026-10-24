import type * as z from "zod/v4";

export type ServiceErrorCode =
  | "bad_request"
  | "conflict"
  | "not_configured"
  | "not_found"
  | "internal";

export class ServiceError extends Error {
  constructor(
    readonly code: ServiceErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function parseServiceRequest<T>(
  schema: z.ZodType<T>,
  payload: unknown,
): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new ServiceError(
      "bad_request",
      result.error.issues[0]?.message ?? "Request body is invalid",
    );
  }
  return result.data;
}

export function statusCodeForServiceError(error: ServiceError): number {
  switch (error.code) {
    case "bad_request":
      return 400;
    case "conflict":
      return 409;
    case "not_found":
      return 404;
    case "not_configured":
    case "internal":
      return 500;
  }
}
