import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  canonicalDevelopmentRepositoryRoot,
  DEVELOPMENT_DESKTOP_RESTART_ACTION,
  DEVELOPMENT_DESKTOP_RESTART_ENABLED_ENV,
  DEVELOPMENT_DESKTOP_RESTART_ROOT_ENV,
  developmentDesktopRestartRequestFromEnvironment,
  isAcceptedDevelopmentDesktopRestartRequest,
} from "../../services/development/development-desktop-restart.js";

test("development restart environment creates a canonical request only when enabled", () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "development-restart-request-"),
  );

  try {
    const equivalentRoot = path.join(repositoryRoot, "uncreated", "..");
    assert.deepEqual(
      developmentDesktopRestartRequestFromEnvironment({
        [DEVELOPMENT_DESKTOP_RESTART_ENABLED_ENV]: "1",
        [DEVELOPMENT_DESKTOP_RESTART_ROOT_ENV]: `  ${equivalentRoot}  `,
      }),
      {
        action: DEVELOPMENT_DESKTOP_RESTART_ACTION,
        repositoryRoot: canonicalDevelopmentRepositoryRoot(repositoryRoot),
      },
    );

    assert.equal(
      developmentDesktopRestartRequestFromEnvironment({
        [DEVELOPMENT_DESKTOP_RESTART_ROOT_ENV]: repositoryRoot,
      }),
      undefined,
    );
    assert.equal(
      developmentDesktopRestartRequestFromEnvironment({
        [DEVELOPMENT_DESKTOP_RESTART_ENABLED_ENV]: "true",
        [DEVELOPMENT_DESKTOP_RESTART_ROOT_ENV]: repositoryRoot,
      }),
      undefined,
    );
    assert.equal(
      developmentDesktopRestartRequestFromEnvironment({
        [DEVELOPMENT_DESKTOP_RESTART_ENABLED_ENV]: "1",
        [DEVELOPMENT_DESKTOP_RESTART_ROOT_ENV]: "   ",
      }),
      undefined,
    );
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("development restart accepts the same canonical root only in development", () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "development-restart-same-root-"),
  );

  try {
    const request = {
      action: DEVELOPMENT_DESKTOP_RESTART_ACTION,
      repositoryRoot: path.join(repositoryRoot, "."),
    };
    assert.equal(
      isAcceptedDevelopmentDesktopRestartRequest({
        additionalData: request,
        currentRepositoryRoot: path.join(repositoryRoot, "nested", ".."),
        isPackaged: false,
      }),
      true,
    );
    assert.equal(
      isAcceptedDevelopmentDesktopRestartRequest({
        additionalData: request,
        currentRepositoryRoot: repositoryRoot,
        isPackaged: true,
      }),
      false,
    );
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("development restart rejects malformed requests and a different worktree", () => {
  const currentRepositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "development-restart-current-"),
  );
  const differentRepositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "development-restart-different-"),
  );

  try {
    const malformedRequests: unknown[] = [
      undefined,
      null,
      [],
      {},
      { repositoryRoot: currentRepositoryRoot },
      {
        action: "replace-something-else",
        repositoryRoot: currentRepositoryRoot,
      },
      {
        action: DEVELOPMENT_DESKTOP_RESTART_ACTION,
        repositoryRoot: 42,
      },
      {
        action: DEVELOPMENT_DESKTOP_RESTART_ACTION,
        repositoryRoot: "   ",
      },
    ];

    for (const additionalData of malformedRequests) {
      assert.equal(
        isAcceptedDevelopmentDesktopRestartRequest({
          additionalData,
          currentRepositoryRoot,
          isPackaged: false,
        }),
        false,
      );
    }

    assert.equal(
      isAcceptedDevelopmentDesktopRestartRequest({
        additionalData: {
          action: DEVELOPMENT_DESKTOP_RESTART_ACTION,
          repositoryRoot: differentRepositoryRoot,
        },
        currentRepositoryRoot,
        isPackaged: false,
      }),
      false,
    );
  } finally {
    fs.rmSync(currentRepositoryRoot, { recursive: true, force: true });
    fs.rmSync(differentRepositoryRoot, { recursive: true, force: true });
  }
});

test("development restart treats a symlinked repository alias as the same root", (t) => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "development-restart-real-root-"),
  );
  const aliasHolder = fs.mkdtempSync(
    path.join(os.tmpdir(), "development-restart-alias-"),
  );
  const aliasRoot = path.join(aliasHolder, "repository");

  try {
    try {
      fs.symlinkSync(
        repositoryRoot,
        aliasRoot,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") {
        t.skip(`Directory symlinks are unavailable on this platform (${code}).`);
        return;
      }
      throw error;
    }

    const request = developmentDesktopRestartRequestFromEnvironment({
      [DEVELOPMENT_DESKTOP_RESTART_ENABLED_ENV]: "1",
      [DEVELOPMENT_DESKTOP_RESTART_ROOT_ENV]: aliasRoot,
    });
    assert.deepEqual(request, {
      action: DEVELOPMENT_DESKTOP_RESTART_ACTION,
      repositoryRoot: canonicalDevelopmentRepositoryRoot(repositoryRoot),
    });
    assert.equal(
      isAcceptedDevelopmentDesktopRestartRequest({
        additionalData: {
          action: DEVELOPMENT_DESKTOP_RESTART_ACTION,
          repositoryRoot: aliasRoot,
        },
        currentRepositoryRoot: repositoryRoot,
        isPackaged: false,
      }),
      true,
    );
  } finally {
    fs.rmSync(aliasHolder, { recursive: true, force: true });
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});
