import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  DESKTOP_EDITABLE_PROJECT_ENTRIES,
  resolveDesktopProjectRootPath,
  seedDesktopProjectRoot,
} from "../../electron/project-root.js";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeSeedFixture(appRootPath: string): void {
  for (const directory of ["agents", "skills", "teams", "workflows"]) {
    fs.mkdirSync(path.join(appRootPath, directory), { recursive: true });
    fs.writeFileSync(
      path.join(appRootPath, directory, `${directory}.txt`),
      `bundled ${directory}\n`,
    );
  }
  fs.writeFileSync(path.join(appRootPath, "teams.yaml"), "team: bundled\n");
  fs.writeFileSync(path.join(appRootPath, "start.yaml"), "entry: bundled\n");
}

test("desktop project root uses the live repo in development and user data when packaged", () => {
  const appRootPath = path.join(os.tmpdir(), "pipeline-app-root");
  const userDataPath = path.join(os.tmpdir(), "pipeline-user-data");

  assert.equal(
    resolveDesktopProjectRootPath({
      appRootPath,
      isPackaged: false,
      userDataPath,
    }),
    appRootPath,
  );
  assert.equal(
    resolveDesktopProjectRootPath({
      appRootPath,
      isPackaged: true,
      userDataPath,
    }),
    path.join(userDataPath, "project"),
  );

  const overridePath = path.join(os.tmpdir(), "pipeline-project-override");
  assert.equal(
    resolveDesktopProjectRootPath({
      appRootPath,
      isPackaged: false,
      projectRootOverride: overridePath,
      userDataPath,
    }),
    overridePath,
  );
});

test("desktop project seeding copies defaults without overwriting user changes", async () => {
  const appRootPath = makeTempDir("desktop-seed-source-");
  const projectRootPath = makeTempDir("desktop-seed-target-");
  writeSeedFixture(appRootPath);

  try {
    const initial = await seedDesktopProjectRoot({
      appRootPath,
      projectRootPath,
    });
    assert.equal(initial.copiedFiles, 6);
    assert.equal(initial.skippedFiles, 0);
    for (const entry of DESKTOP_EDITABLE_PROJECT_ENTRIES) {
      assert.equal(fs.existsSync(path.join(projectRootPath, entry)), true);
    }

    const userTeamConfig = path.join(projectRootPath, "teams.yaml");
    fs.writeFileSync(userTeamConfig, "team: user-edited\n");
    fs.writeFileSync(
      path.join(projectRootPath, "agents", "user-agent.md"),
      "user-only agent\n",
    );
    fs.writeFileSync(
      path.join(appRootPath, "workflows", "new-default.yaml"),
      "workflow: new-default\n",
    );

    const update = await seedDesktopProjectRoot({
      appRootPath,
      projectRootPath,
    });
    assert.equal(update.copiedFiles, 1);
    assert.equal(update.skippedFiles, 6);
    assert.equal(fs.readFileSync(userTeamConfig, "utf8"), "team: user-edited\n");
    assert.equal(
      fs.readFileSync(
        path.join(projectRootPath, "agents", "user-agent.md"),
        "utf8",
      ),
      "user-only agent\n",
    );
    assert.equal(
      fs.existsSync(path.join(projectRootPath, "workflows", "new-default.yaml")),
      true,
    );
  } finally {
    fs.rmSync(appRootPath, { recursive: true, force: true });
    fs.rmSync(projectRootPath, { recursive: true, force: true });
  }
});

test("desktop project seeding is a no-op for the development repo", async () => {
  const appRootPath = makeTempDir("desktop-seed-live-repo-");
  try {
    const result = await seedDesktopProjectRoot({
      appRootPath,
      projectRootPath: appRootPath,
    });
    assert.deepEqual(result, { copiedFiles: 0, skippedFiles: 0 });
  } finally {
    fs.rmSync(appRootPath, { recursive: true, force: true });
  }
});
