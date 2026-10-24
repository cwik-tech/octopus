import assert from "node:assert/strict";
import test from "node:test";

import { buildToolRegistry } from "../../server/tools/tool-registry.js";
import { youtubeToolModule } from "../../server/tools/youtube.js";

test("the youtube module registers with the binary-resolution reason the desktop host passes", () => {
  const registry = buildToolRegistry(
    {
      moduleOptions: {
        youtube: {
          endpoint: { token: "unused-youtube" },
          binariesUnavailableReason: "Bundled ffprobe checksum does not match.",
        },
      },
    },
    [youtubeToolModule],
  );

  assert.deepEqual(
    registry.map((entry) => entry.name),
    ["youtube"],
  );
});
