const { execFile } = require("node:child_process");
const { access } = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

function resolvePackagedFileParserPath(context) {
  const resourcesPath = context.packager.getResourcesDir(context.appOutDir);
  return path.join(resourcesPath, "app", "file-parser");
}

async function prunePackagedFileParser(
  parserPath,
  runCommand = execFileAsync,
) {
  await access(path.join(parserPath, "package.json"));
  await access(path.join(parserPath, "node_modules"));

  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  await runCommand(
    npmCommand,
    [
      "prune",
      "--omit=dev",
      "--ignore-scripts",
      "--offline",
      "--no-audit",
      "--no-fund",
    ],
    {
      cwd: parserPath,
      env: {
        ...process.env,
        npm_config_update_notifier: "false",
      },
      maxBuffer: 1024 * 1024,
    },
  );
}

async function afterPack(context) {
  await prunePackagedFileParser(resolvePackagedFileParserPath(context));
}

module.exports = afterPack;
module.exports.afterPack = afterPack;
module.exports.prunePackagedFileParser = prunePackagedFileParser;
module.exports.resolvePackagedFileParserPath = resolvePackagedFileParserPath;
