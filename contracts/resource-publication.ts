/** A writer runs under the Library lock, before its per-Agent mutation lock. */
export interface ResourceAgentPublication {
  publishAgent<T>(agentId: string, writer: () => Promise<T>): Promise<T>;
}

/** Own the Library boundary before entering any Team or Agent file lock. */
export interface ResourceAgentPublisher extends ResourceAgentPublication {
  publishResources<T>(writer: (owned: ResourceAgentPublication) => Promise<T>): Promise<T>;
}

/** Legacy callers without a Library retain their existing filesystem behavior. */
export function publishResourceMutation<T>(
  publisher: ResourceAgentPublisher | undefined,
  writer: (owned: ResourceAgentPublication | undefined) => Promise<T>,
): Promise<T> {
  return publisher ? publisher.publishResources(writer) : writer(undefined);
}
