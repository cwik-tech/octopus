---
name: microsoft-fabric-api-operations
description: >
  Call the Microsoft Fabric REST API safely: Microsoft Entra ID authentication (service principal vs delegated user), token scopes, workspace and item CRUD, long-running operation polling, and throttling handling. Use when automating Fabric with the REST API, creating Entra app registrations for Fabric, getting access tokens for api.fabric.microsoft.com, listing or creating workspaces and items, polling Fabric operations, or handling 429 throttling.
---

# Microsoft Fabric API Operations

## Outcome

Issue authenticated, least-privilege calls against `https://api.fabric.microsoft.com/v1`, complete long-running operations to a terminal state, and survive throttling without losing work.

## Authentication and setup

1. All requests go to the base URL `https://api.fabric.microsoft.com/v1` with `Authorization: Bearer <token>`. Tokens come from Microsoft Entra ID; the scope is `https://api.fabric.microsoft.com/.default` (plus item-type-specific scopes where the reference requires them — check the Scopes article for the API you call).
2. Choose the identity before writing code:
   - Delegated user (interactive or scripts): public client flow, user needs a Fabric license and workspace role.
   - Service principal (automation): Entra app registration with client secret or certificate. The Fabric admin must enable the tenant setting "Service principals can use Fabric APIs", and each API's reference page states whether it supports service principals — verify before designing around one.
3. Never write client secrets, certificates, or tokens into files, prompts, logs, or artifacts. Read them from environment variables or a secret store. Example token acquisition (client credentials): POST to `https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/token` with `grant_type=client_credentials`, `client_id=$FABRIC_CLIENT_ID`, `client_secret=$FABRIC_CLIENT_SECRET`, `scope=https://api.fabric.microsoft.com/.default`. Tokens expire in ~1 hour; cache and refresh, never persist.
4. Verify access before operating: `GET /v1/workspaces` must return 200 with the expected workspaces. A 401/403 means token, tenant-setting, or capacity problems — resolve before any mutating call.

## Core request patterns

- Workspaces: `GET /v1/workspaces`, `POST /v1/workspaces {displayName, capacityId}`, `GET /v1/workspaces/{id}`.
- Items: `GET /v1/workspaces/{workspaceId}/items`, `POST /v1/workspaces/{workspaceId}/items {displayName, type, description?}`, `GET /v1/workspaces/{workspaceId}/items/{itemId}`, `PATCH` to rename, `DELETE` to remove. `type` values include `Lakehouse`, `Notebook`, `DataPipeline`, `CopyJob`, `SemanticModel`.
- Item definitions: `POST /v1/workspaces/{wsId}/items/{itemId}/getDefinition` returns the parts (base64 files); `POST .../updateDefinition` replaces them. Both are long-running operations.
- List endpoints paginate: follow `continuationUri` in the response until it is absent; never assume one page.

## Long-running operations

1. Mutating creates/updates may return `201` (done) or `202 Accepted` with a `Location` header and `Retry-After`.
2. On 202, poll `GET <Location>` until the body `status` is `Succeeded`, `Failed`, or `Cancelled`. Honor `Retry-After` between polls; back off exponentially if throttled.
3. On `Succeeded` for item creation, fetch the created resource from the operation's `Location`-derived result URL before reporting success.

## Throttling and errors

- Fabric returns `429 TooManyRequests` with a `Retry-After` header (seconds). Retry only after that delay, with jitter, capped at a few attempts. Do not parallelize burst writes; space mutating calls.
- Other statuses: 400 = payload/schema (validate against the reference's request body), 401 = expired or wrong-scope token (re-acquire), 403 = identity lacks the workspace role or the tenant blocks service principals, 404 = wrong workspace/item ID or unsupported item type, 409 = name conflict.

## Permissions and safety

- Least privilege: workspace roles map to capability — Viewer reads, Member writes items, Admin manages the workspace. Request only the API scopes the calls need.
- Read-only (`GET` lists and gets, `getDefinition`) is unrestricted. Mutating calls (`POST`, `PATCH`, `DELETE`, `updateDefinition`, job runs) require a written plan naming workspace ID, item type, and payload summary, plus explicit user approval. `DELETE` additionally requires stating what breaks downstream and confirming the item ID twice.
- Workflow: inspect (`GET` the workspace/item) → plan → execute → verify (re-`GET` the item; poll LROs to terminal state) → roll back (re-`PATCH`/re-create from the saved definition).

## Troubleshooting

- 401 immediately after getting a token: wrong scope string (must be `https://api.fabric.microsoft.com/.default`) or a v1-endpoint token; re-acquire with the v2.0 endpoint.
- 403 for a service principal that works as a user: tenant setting "Service principals can use Fabric APIs" is off, or the specific API does not support service principals — check the API reference page.
- Create returns 202 and never finishes: you must poll the `Location` header; the item is not usable until the operation succeeds.
- Bursts of 429: capacity is throttled; honor `Retry-After`, serialize writes, and retry with jitter.
- Empty list responses: pagination — follow `continuationUri` until absent before concluding nothing exists.

## References

- Fabric REST API documentation: https://learn.microsoft.com/en-us/rest/api/fabric/articles/
- Using the Fabric APIs: https://learn.microsoft.com/en-us/rest/api/fabric/articles/get-started/using-fabric-apis
- Create an Entra app: https://learn.microsoft.com/en-us/rest/api/fabric/articles/get-started/create-entra-app
- Identity support: https://learn.microsoft.com/en-us/rest/api/fabric/articles/identity-support
- Scopes: https://learn.microsoft.com/en-us/rest/api/fabric/articles/scopes
- Long-running operations: https://learn.microsoft.com/en-us/rest/api/fabric/articles/long-running-operation
- Throttling: https://learn.microsoft.com/en-us/rest/api/fabric/articles/throttling
- Pagination: https://learn.microsoft.com/en-us/rest/api/fabric/articles/pagination
- Create Item: https://learn.microsoft.com/en-us/rest/api/fabric/core/items/create-item
- Item definition overview: https://learn.microsoft.com/en-us/rest/api/fabric/articles/item-management/definitions/item-definition-overview

## Shared resources

Load only if the task needs them; the skill is self-contained without them.

- `../../references/security-control-baseline.md`

## Completion check

A fresh `GET` confirms the intended workspace/item state, every LRO reached a terminal status, no 429 was retried inside its `Retry-After` window, and no secret or token appears in any file, prompt, log, or artifact.
