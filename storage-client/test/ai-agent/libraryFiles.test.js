import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildFileAccessPolicy,
  buildFileAccessExplanation,
  buildOrganizeFilesResult,
  buildTextExcerptResult
} from "../../src/bot/tools/libraryFiles.js";

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nas-agent-library-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function createApi(root, files, extraDependencies = {}) {
  return {
    storageRoot: root,
    clientId: "client",
    dependencies: {
      listLibraryFiles: async () => ({
        clientId: "client",
        directories: [],
        files
      }),
      ...extraDependencies
    }
  };
}

test("text excerpt reads bounded content without exposing absolute paths", async () => {
  await withTempDir(async (root) => {
    await fs.mkdir(path.join(root, "docs"), { recursive: true });
    const text = "0123456789abcdefghijklmnopqrstuvwxyz";
    await fs.writeFile(path.join(root, "docs", "note.md"), text, "utf8");
    const api = createApi(root, [
      {
        id: "client:docs/note.md",
        clientId: "client",
        path: "docs/note.md",
        name: "note.md",
        size: text.length,
        mimeType: "text/markdown",
        updatedAt: "2026-07-01T00:00:00.000Z"
      }
    ]);

    const result = await buildTextExcerptResult(api, {
      path: "docs/note.md",
      startChar: 4,
      maxChars: 10
    });

    assert.equal(result.excerpt.text, text.slice(4, 14));
    assert.equal(result.policy.rawAbsolutePathExposed, false);
    assert.equal(result.policy.storageRootOnly, true);
    assert.equal(result.policy.allowRawTextRead, true);
    assert.equal(result.policy.allowBinaryRead, false);
    assert.equal(result.policy.maxInlineTextChars, 20_000);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(root.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
  });
});

test("file access explanation exposes policy boundaries and tool list", async () => {
  await withTempDir(async (root) => {
    const api = createApi(root, [
      {
        id: "client:Videos/demo.mp4",
        clientId: "client",
        path: "Videos/demo.mp4",
        name: "demo.mp4",
        size: 100,
        mimeType: "video/mp4",
        updatedAt: "2026-07-01T00:00:00.000Z"
      }
    ]);

    const result = await buildFileAccessExplanation(api, { kind: "tools" });
    assert.equal(result.policy.root, root);
    assert.deepEqual(result.policy.allowedRoots, [root]);
    assert.ok(result.policy.hiddenDirs.includes(".nas-bot"));
    assert.ok(result.policy.hiddenDirectories.includes(".nas-bot"));
    assert.equal(result.policy.maxInlineTextChars, 20_000);
    assert.equal(result.policy.allowRawTextRead, true);
    assert.equal(result.policy.allowBinaryRead, false);
    assert.equal(result.policy.rawAbsolutePathExposed, false);
    assert.equal(result.policy.binaryReadAllowed, false);
    assert.equal(result.policy.writeRequiresConfirmation, true);
    assert.ok(result.blockedLayers.some((item) => item.includes("STORAGE_ROOT")));
    assert.ok(result.detail.includes("search_library_files"));
    assert.ok(result.detail.includes("organize_files"));
  });
});

test("file access policy matches the agent FileAccessPolicy contract", async () => {
  await withTempDir(async (root) => {
    const policy = buildFileAccessPolicy(createApi(root, []));
    assert.equal(policy.root, root);
    assert.deepEqual(policy.allowedRoots, [root]);
    assert.deepEqual(policy.accessBy, ["fileId", "relativePath"]);
    assert.equal(policy.allowBinaryRead, false);
    assert.equal(policy.storageRootOnly, true);
    assert.equal(policy.writeRequiresConfirmation, true);
    assert.ok(policy.maxListResults > 0);
    assert.ok(policy.maxInlineTextChars > 0);
    assert.ok(policy.maxBatchFiles > 0);
  });
});

test("organize_files blocks unsafe targets and requires confirmation for real moves", async () => {
  await withTempDir(async (root) => {
    const sourceRelative = "downloads/video.mp4";
    await fs.mkdir(path.join(root, "downloads"), { recursive: true });
    await fs.writeFile(path.join(root, sourceRelative), "video", "utf8");
    const files = [
      {
        id: `client:${sourceRelative}`,
        clientId: "client",
        path: sourceRelative,
        name: "video.mp4",
        size: 5,
        mimeType: "video/mp4",
        updatedAt: "2026-07-01T00:00:00.000Z",
        tags: ["raw"],
        aiSummary: "A demo video"
      }
    ];
    const api = createApi(root, files);

    const unsafe = await buildOrganizeFilesResult(api, {
      actions: [
        { path: sourceRelative, targetPath: "../escape.mp4" },
        { path: sourceRelative, targetPath: ".nas-bot/hidden.mp4" }
      ]
    });
    assert.equal(unsafe.blocked, true);
    assert.equal(unsafe.executableCount, 0);
    assert.deepEqual(unsafe.actions.map((item) => item.status), ["invalid", "invalid"]);

    const needsConfirmation = await buildOrganizeFilesResult(api, {
      path: sourceRelative,
      targetFolder: "organized",
      dryRun: false
    });
    assert.equal(needsConfirmation.blocked, true);
    assert.equal(needsConfirmation.requiresConfirmation, true);
    assert.equal(needsConfirmation.actions[0].status, "dry-run");
    assert.equal(fsSync.existsSync(path.join(root, sourceRelative)), true);
  });
});

test("organize_files moves inside storage root and migrates metadata after confirmation", async () => {
  await withTempDir(async (root) => {
    const sourceRelative = "downloads/video.mp4";
    const targetRelative = "organized/video.mp4";
    await fs.mkdir(path.join(root, "downloads"), { recursive: true });
    await fs.writeFile(path.join(root, sourceRelative), "video", "utf8");
    const metadataWrites = [];
    const api = createApi(root, [
      {
        id: `client:${sourceRelative}`,
        clientId: "client",
        path: sourceRelative,
        name: "video.mp4",
        size: 5,
        mimeType: "video/mp4",
        updatedAt: "2026-07-01T00:00:00.000Z",
        tags: ["raw"],
        aiSummary: "A demo video"
      }
    ], {
      upsertFileMeta: async (fileId, patch) => {
        metadataWrites.push({ fileId, patch });
      }
    });

    const result = await buildOrganizeFilesResult(api, {
      path: sourceRelative,
      targetPath: targetRelative,
      dryRun: false,
      confirmed: true
    });

    assert.equal(result.blocked, false);
    assert.equal(result.dryRun, false);
    assert.equal(result.actions[0].status, "moved");
    assert.equal(result.audit.storageRootOnly, true);
    assert.equal(fsSync.existsSync(path.join(root, sourceRelative)), false);
    assert.equal(fsSync.existsSync(path.join(root, targetRelative)), true);
    assert.deepEqual(metadataWrites, [
      {
        fileId: `client:${targetRelative}`,
        patch: {
          tags: ["raw"],
          aiSummary: "A demo video"
        }
      }
    ]);
  });
});
