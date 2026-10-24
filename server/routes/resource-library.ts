import { builtInUpdateSourceSchema } from "../../contracts/builtin-update.js";
import { resourceMigrationApprovalSchema } from "../../contracts/resource-migration.js";
import { resourcePackageCommitSchema, resourcePackageExportSchema, resourcePackagePreviewRequestSchema } from '../../contracts/resource-package.js';
import type * as http from "node:http";
import type { URL } from "node:url";

import {
  resourceLibraryArchiveSkillRequestSchema,
  resourceLibraryAttachSkillRequestSchema,
  resourceLibraryCreateSkillRequestSchema,
  resourceLibraryDetachSkillRequestSchema,
  resourceLibraryRestoreSkillRequestSchema,
  resourceLibrarySaveSkillRequestSchema,
  resourceLibrarySelectRevisionRequestSchema,
  type ResourceLibraryFileInput,
} from "../../contracts/schemas/resource-library-requests.js";
import type { ResourceLibraryService } from "../../services/resource-library-service.js";
import { ResourceLibraryConflictError } from "../../domains/resource-library/resource-library-store.js";
import type { ResourceSkillFiles } from "../../domains/resource-library/skill-files.js";
import { normalizeResourcePath } from "../../domains/resource-library/skill-files.js";
import { createRequestAbort, parseApiRequest, readJsonBody, writeJson } from "../http.js";

export async function handleResourceLibraryRoutes(params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  service?: ResourceLibraryService;
}): Promise<boolean> {
  const { req, res, url, service } = params;
  if (
    url.pathname !== "/resource-library" &&
    !url.pathname.startsWith("/resource-library/")
  ) {
    return false;
  }
  if (!service) {
    writeJson(res, 501, { error: "Resource Library is not configured on this server" });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/resource-library") {
    writeJson(res, 200, await service.getBrowserSnapshot());
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/resource-library/migration/approve') {
    const body = parseApiRequest(resourceMigrationApprovalSchema, await readJsonBody(req));
    const request = createRequestAbort(req, res);
    try { await writeMutation(res, 200, () => service.approveMigration(body, { signal: request.signal })); }
    finally { request.dispose(); }
    return true;
  }

  if (req.method === 'POST' && ['/resource-library/packages/preview', '/resource-library/packages/import', '/resource-library/packages/export', '/resource-library/packages/builtin-update'].includes(url.pathname)) {
    const request = createRequestAbort(req, res);
    try {
      if (!(await service.initialize())) { writeJson(res, 409, { error: 'Review and approve the Library migration before importing or exporting resources.' }); return true; }
      const payload = await readJsonBody(req, 90 * 1024 * 1024);
      if (url.pathname.endsWith('/builtin-update')) {
        const source = parseApiRequest(builtInUpdateSourceSchema, payload);
        await writeMutation(res, 200, async () => { const result = await service.exportBuiltinUpdate(source); return { filename: result.filename, contentBase64: result.bytes.toString('base64') }; });
      } else if (url.pathname.endsWith('/preview')) {
        const body = parseApiRequest(resourcePackagePreviewRequestSchema, payload);
        await writeMutation(res, 200, () => service.packages.preview({ bytes: Buffer.from(body.contentBase64, 'base64'), filename: body.filename, signal: request.signal }));
      } else if (url.pathname.endsWith('/import')) {
        const body = parseApiRequest(resourcePackageCommitSchema, payload);
        await writeMutation(res, 200, () => service.packages.commit({ ...body, bytes: Buffer.from(body.contentBase64, 'base64'), signal: request.signal }));
      } else {
        const body = parseApiRequest(resourcePackageExportSchema, payload);
        await writeMutation(res, 200, async () => {
          const result = await service.packages.export(body, { signal: request.signal });
          return { filename: result.filename, contentBase64: result.bytes.toString('base64') };
        });
      }
    } finally { request.dispose(); }
    return true;
  }

  const filesMatch = url.pathname.match(
    /^\/resource-library\/skills\/([^/]+)\/revisions\/([^/]+)\/files$/,
  );
  if (req.method === "GET" && filesMatch) {
    try {
      const skillId = decodeURIComponent(filesMatch[1] ?? "");
      const revisionId = decodeURIComponent(filesMatch[2] ?? "");
      writeJson(res, 200, await service.readRevisionFiles(skillId, revisionId));
    } catch (error) {
      writeJson(res, 404, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/resource-library/skills") {
    const body = parseApiRequest(
      resourceLibraryCreateSkillRequestSchema,
      await readJsonBody(req),
    );
    await writeMutation(res, 201, () =>
      service.createSkill({ ...body, files: resourceFiles(body.files) })
    );
    return true;
  }

  const saveMatch = url.pathname.match(/^\/resource-library\/skills\/([^/]+)\/revisions$/);
  if (req.method === "POST" && saveMatch) {
    const body = parseApiRequest(
      resourceLibrarySaveSkillRequestSchema,
      await readJsonBody(req),
    );
    await writeMutation(res, 200, () =>
      service.saveSkillRevision({
        ...body,
        skillId: decodeURIComponent(saveMatch[1] ?? ""),
        files: resourceFiles(body.files),
      })
    );
    return true;
  }

  const restoreMatch = url.pathname.match(/^\/resource-library\/skills\/([^/]+)\/restore$/);
  if (req.method === "POST" && restoreMatch) {
    const body = parseApiRequest(
      resourceLibraryRestoreSkillRequestSchema,
      await readJsonBody(req),
    );
    await writeMutation(res, 200, () =>
      service.restoreSkillRevision({
        ...body,
        skillId: decodeURIComponent(restoreMatch[1] ?? ""),
      })
    );
    return true;
  }

  const archiveMatch = url.pathname.match(/^\/resource-library\/skills\/([^/]+)\/archive$/);
  if (req.method === "PATCH" && archiveMatch) {
    const body = parseApiRequest(
      resourceLibraryArchiveSkillRequestSchema,
      await readJsonBody(req),
    );
    await writeMutation(res, 200, () =>
      service.setSkillArchived({
        ...body,
        skillId: decodeURIComponent(archiveMatch[1] ?? ""),
      })
    );
    return true;
  }

  const attachMatch = url.pathname.match(/^\/resource-library\/agents\/([^/]+)\/attachments$/);
  if (req.method === "POST" && attachMatch) {
    const body = parseApiRequest(
      resourceLibraryAttachSkillRequestSchema,
      await readJsonBody(req),
    );
    await writeMutation(res, 200, () =>
      service.attachSkill({
        ...body,
        agentId: decodeURIComponent(attachMatch[1] ?? ""),
      })
    );
    return true;
  }

  const detachMatch = url.pathname.match(
    /^\/resource-library\/agents\/([^/]+)\/attachments\/([^/]+)$/,
  );
  if (req.method === "DELETE" && detachMatch) {
    const body = parseApiRequest(
      resourceLibraryDetachSkillRequestSchema,
      await readJsonBody(req),
    );
    await writeMutation(res, 200, () =>
      service.detachSkill({
        ...body,
        agentId: decodeURIComponent(detachMatch[1] ?? ""),
        alias: decodeURIComponent(detachMatch[2] ?? ""),
      })
    );
    return true;
  }

  const revisionMatch = url.pathname.match(/^\/resource-library\/agents\/([^/]+)\/revision$/);
  if (req.method === "POST" && revisionMatch) {
    const body = parseApiRequest(
      resourceLibrarySelectRevisionRequestSchema,
      await readJsonBody(req),
    );
    await writeMutation(res, 200, () =>
      service.selectAgentSkillRevision({
        ...body,
        agentId: decodeURIComponent(revisionMatch[1] ?? ""),
      })
    );
    return true;
  }

  return false;
}

function resourceFiles(inputs: readonly ResourceLibraryFileInput[]): ResourceSkillFiles {
  const files = new Map<string, { contents: Buffer; mode: number; executable: boolean }>();
  for (const input of inputs) {
    const relativePath = normalizeResourcePath(input.path);
    if (files.has(relativePath)) throw new Error(`Duplicate resource path: ${relativePath}`);
    files.set(relativePath, {
      contents: Buffer.from(input.contentBase64, "base64"),
      mode: input.executable ? 0o755 : 0o644,
      executable: input.executable,
    });
  }
  return files;
}

async function writeMutation<T>(
  res: http.ServerResponse,
  statusCode: number,
  operation: () => Promise<T>,
): Promise<void> {
  try {
    writeJson(res, statusCode, await operation());
  } catch (error) {
    if (error instanceof ResourceLibraryConflictError) {
      writeJson(res, 409, { error: error.message, code: error.code });
      return;
    }
    writeJson(res, 400, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
