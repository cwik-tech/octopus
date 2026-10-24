import { createHash } from "node:crypto";

export function configuredProviderBrokerIdentity(
  brokerUrl: string | undefined,
): string | undefined {
  const normalized = brokerUrl?.trim();
  if (!normalized) return undefined;
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}
