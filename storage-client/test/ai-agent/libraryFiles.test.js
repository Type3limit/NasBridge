import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildDiagnoseFileAccessResult,
  buildFileAccessPolicy,
  buildFileAccessExplanation,
  buildPublicFileAccessPolicy,
  buildLibraryListResult,
  buildLibraryMetadataResult,
  buildMediaSummaryResult,
  buildOrganizeFilesResult,
  buildTextExcerptResult,
  buildUpdateFileMetadataResult
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

function writeUInt32(buffer, value, offset) {
  buffer.writeUInt32LE(value >>> 0, offset);
}

function createStoredZip(entries = []) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(String(entry.name || ""), "utf8");
    const data = Buffer.from(String(entry.content || ""), "utf8");
    const local = Buffer.alloc(30 + name.length);
    writeUInt32(local, 0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    writeUInt32(local, 0, 14);
    writeUInt32(local, data.length, 18);
    writeUInt32(local, data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    localParts.push(local, data);

    const central = Buffer.alloc(46 + name.length);
    writeUInt32(central, 0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    writeUInt32(central, 0, 16);
    writeUInt32(central, data.length, 20);
    writeUInt32(central, data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    writeUInt32(central, offset, 42);
    name.copy(central, 46);
    centralParts.push(central);

    offset += local.length + data.length;
  }
  const centralOffset = offset;
  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  writeUInt32(eocd, 0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  writeUInt32(eocd, central.length, 12);
  writeUInt32(eocd, centralOffset, 16);
  return Buffer.concat([...localParts, central, eocd]);
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
    assert.equal(result.policy.root, "STORAGE_ROOT");
    assert.deepEqual(result.policy.allowedRoots, ["STORAGE_ROOT"]);
    assert.equal(result.policy.storageRootConfigured, true);
    assert.equal(result.policy.rawAbsolutePathExposed, false);
    assert.equal(result.policy.storageRootOnly, true);
    assert.equal(result.policy.allowRawTextRead, true);
    assert.equal(result.policy.allowBinaryRead, false);
    assert.equal(result.policy.maxInlineTextChars, 20_000);
    const absoluteFilePath = path.join(root, "Videos", "demo.mp4");
    assert.doesNotMatch(JSON.stringify(result), new RegExp(absoluteFilePath.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
  });
});

test("text excerpt extracts PDF content through the document layer", async () => {
  await withTempDir(async (root) => {
    await fs.mkdir(path.join(root, "docs"), { recursive: true });
    const pdf = [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj",
      "4 0 obj << /Length 72 >>",
      "stream",
      "BT /F1 12 Tf 72 720 Td (Hello PDF excerpt from NAS agent) Tj ET",
      "endstream",
      "endobj",
      "%%EOF"
    ].join("\n");
    await fs.writeFile(path.join(root, "docs", "paper.pdf"), pdf, "latin1");
    const api = createApi(root, [
      {
        id: "client:docs/paper.pdf",
        clientId: "client",
        path: "docs/paper.pdf",
        name: "paper.pdf",
        size: Buffer.byteLength(pdf),
        mimeType: "application/pdf",
        updatedAt: "2026-07-01T00:00:00.000Z"
      }
    ]);

    const result = await buildTextExcerptResult(api, {
      path: "docs/paper.pdf",
      maxChars: 16
    });

    assert.equal(result.excerpt.source, "document");
    assert.equal(result.excerpt.format, "pdf");
    assert.match(result.excerpt.extractor, /pdf/);
    assert.equal(result.excerpt.text, "Hello PDF excerp");
    assert.equal(result.excerpt.truncated, true);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(root.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));

    const metadata = await buildLibraryMetadataResult(api, { path: "docs/paper.pdf" });
    assert.equal(metadata.files[0].contentAccess.documentTextExtractable, true);
    assert.equal(metadata.files[0].contentAccess.textReadable, true);
    assert.ok(metadata.files[0].contentAccess.recommendedTools.includes("read_text_excerpt"));
  });
});

test("text excerpt extracts Office Open XML document text", async () => {
  await withTempDir(async (root) => {
    await fs.mkdir(path.join(root, "docs"), { recursive: true });
    const docx = createStoredZip([
      {
        name: "word/document.xml",
        content: [
          "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
          "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">",
          "<w:body><w:p><w:r><w:t>Alpha NAS document</w:t></w:r></w:p>",
          "<w:p><w:r><w:t>Beta excerpt text</w:t></w:r></w:p></w:body></w:document>"
        ].join("")
      }
    ]);
    await fs.writeFile(path.join(root, "docs", "report.docx"), docx);
    const api = createApi(root, [
      {
        id: "client:docs/report.docx",
        clientId: "client",
        path: "docs/report.docx",
        name: "report.docx",
        size: docx.length,
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        updatedAt: "2026-07-01T00:00:00.000Z"
      }
    ]);

    const result = await buildTextExcerptResult(api, {
      fileId: "client:docs/report.docx",
      startChar: 6,
      maxChars: 12
    });

    assert.equal(result.excerpt.source, "document");
    assert.equal(result.excerpt.extractor, "ooxml");
    assert.equal(result.excerpt.format, "docx");
    assert.equal(result.excerpt.text, "NAS document");
    assert.equal(result.policy.allowBinaryRead, false);
  });
});

test("media summary includes ffprobe-derived technical metadata without exposing absolute paths", async () => {
  await withTempDir(async (root) => {
    await fs.mkdir(path.join(root, "Videos"), { recursive: true });
    const relativePath = "Videos/demo.mp4";
    await fs.writeFile(path.join(root, relativePath), "not-real-video", "utf8");
    const probeCalls = [];
    const api = createApi(root, [
      {
        id: `client:${relativePath}`,
        clientId: "client",
        path: relativePath,
        name: "demo.mp4",
        size: 14,
        mimeType: "video/mp4",
        updatedAt: "2026-07-01T00:00:00.000Z",
        aiSummary: "A demo summary",
        tags: ["demo"]
      }
    ], {
      probeMediaFile: async ({ file, absolutePath, relativePath: probedPath }) => {
        probeCalls.push({ fileId: file.id, absolutePath, relativePath: probedPath });
        return {
          durationSeconds: 125.25,
          durationLabel: "2:05",
          formatName: "mov,mp4,m4a,3gp,3g2,mj2",
          bitRate: 3200000,
          resolution: "1920x1080",
          width: 1920,
          height: 1080,
          videoTrackCount: 1,
          audioTrackCount: 2,
          subtitleTrackCount: 1,
          primaryVideo: { codecName: "h264", width: 1920, height: 1080 },
          primaryAudio: { codecName: "aac", channels: 2, language: "jpn" },
          videoStreams: [{ index: 0, codecName: "h264", width: 1920, height: 1080 }],
          audioStreams: [
            { index: 1, codecName: "aac", channels: 2, language: "jpn" },
            { index: 2, codecName: "aac", channels: 2, language: "eng" }
          ],
          subtitleStreams: [{ index: 3, codecName: "mov_text", language: "eng" }]
        };
      }
    });

    const result = await buildMediaSummaryResult(api, {
      path: relativePath
    });

    assert.equal(probeCalls.length, 1);
    assert.equal(probeCalls[0].relativePath, relativePath);
    assert.equal(result.media.probeAvailable, true);
    assert.equal(result.media.durationSeconds, 125.25);
    assert.equal(result.media.durationLabel, "2:05");
    assert.equal(result.media.resolution, "1920x1080");
    assert.equal(result.media.videoTrackCount, 1);
    assert.equal(result.media.audioTrackCount, 2);
    assert.equal(result.media.subtitleTrackCount, 1);
    assert.equal(result.media.probe.primaryAudio.language, "jpn");
    assert.equal(result.aiSummary, "A demo summary");
    assert.doesNotMatch(JSON.stringify(result), new RegExp(root.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
  });
});

test("media summary redacts absolute paths from probe errors", async () => {
  await withTempDir(async (root) => {
    await fs.mkdir(path.join(root, "Videos"), { recursive: true });
    const relativePath = "Videos/broken.mp4";
    const absolutePath = path.join(root, relativePath);
    await fs.writeFile(absolutePath, "broken", "utf8");
    const api = createApi(root, [
      {
        id: `client:${relativePath}`,
        clientId: "client",
        path: relativePath,
        name: "broken.mp4",
        size: 6,
        mimeType: "video/mp4",
        updatedAt: "2026-07-01T00:00:00.000Z"
      }
    ], {
      probeMediaFile: async () => {
        throw new Error(`ffprobe failed for ${absolutePath}`);
      }
    });

    const result = await buildMediaSummaryResult(api, { path: relativePath });

    assert.equal(result.media.probeAvailable, false);
    assert.match(result.media.probeError, /\[storage-path\]/);
    assert.doesNotMatch(result.media.probeError, new RegExp(root.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
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
    assert.equal(result.storageRoot, "STORAGE_ROOT");
    assert.equal(result.storageRootConfigured, true);
    assert.equal(result.currentStatus.storageRoot, "STORAGE_ROOT");
    assert.equal(result.currentStatus.storageRootConfigured, true);
    assert.equal(result.currentStatus.exists, true);
    assert.equal(result.currentStatus.readable, true);
    assert.equal(result.currentStatus.status, "ok");
    assert.equal(result.currentStatus.indexSource, "dependency");
    assert.equal(result.currentStatus.visibleFiles, 1);
    assert.equal(result.currentStatus.visibleDirectories, 0);
    assert.equal(result.currentStatus.countsByKind.video, 1);
    assert.ok(result.currentStatus.hiddenDirsExcluded >= 1);
    assert.equal(result.currentStatus.policy.storageRootOnly, true);
    assert.equal(result.currentStatus.policy.allowBinaryRead, false);
    assert.equal(result.currentStatus.policy.rawAbsolutePathExposed, false);
    assert.equal(result.currentStatus.policy.writeRequiresConfirmation, true);
    assert.equal(result.policy.root, "STORAGE_ROOT");
    assert.deepEqual(result.policy.allowedRoots, ["STORAGE_ROOT"]);
    assert.equal(result.policy.storageRootConfigured, true);
    assert.ok(result.policy.hiddenDirs.includes(".nas-bot"));
    assert.ok(result.policy.hiddenDirectories.includes(".nas-bot"));
    assert.equal(result.policy.maxInlineTextChars, 20_000);
    assert.equal(result.policy.allowRawTextRead, true);
    assert.equal(result.policy.allowBinaryRead, false);
    assert.equal(result.policy.rawAbsolutePathExposed, false);
    assert.equal(result.policy.binaryReadAllowed, false);
    assert.equal(result.policy.writeRequiresConfirmation, true);
    assert.match(result.summary, /索引、fileId 和相对路径/);
    assert.equal(result.canAccess.indexedFiles, true);
    assert.equal(result.canAccess.fileMetadata, true);
    assert.equal(result.canAccess.textExcerpts, true);
    assert.equal(result.canAccess.mediaDerivedContent, true);
    assert.equal(result.canAccess.directBinaryRawContent, false);
    assert.equal(result.canAccess.arbitraryLocalPaths, false);
    assert.equal(result.canAccess.outsideStorageRoot, false);
    assert.ok(result.blockedLayers.some((item) => item.includes("STORAGE_ROOT")));
    assert.ok(result.recommendedFirstSteps.some((item) => item.includes("diagnose_file_access")));
    assert.ok(result.recommendedFirstSteps.some((item) => item.includes("invoke_video_analyze")));
    assert.ok(result.detail.includes("search_library_files"));
    assert.ok(result.detail.includes("diagnose_file_access"));
    assert.ok(result.detail.includes("organize_files"));
    assert.ok(result.actionPlan.some((action) => action.tool === "search_library_files" && action.contentLayer === "index"));
    assert.ok(result.actionPlan.some((action) => action.tool === "read_text_excerpt" && action.contentLayer === "excerpt"));
    const organizeAction = result.actionPlan.find((action) => action.tool === "organize_files");
    assert.equal(organizeAction.riskLevel, "high");
    assert.equal(organizeAction.requiresConfirmation, true);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(root.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
  });
});

test("diagnose_file_access explains concrete file layers without exposing absolute paths", async () => {
  await withTempDir(async (root) => {
    const files = [
      {
        id: "client:Videos/demo.mp4",
        clientId: "client",
        path: "Videos/demo.mp4",
        name: "demo.mp4",
        size: 100,
        mimeType: "video/mp4",
        updatedAt: "2026-07-01T00:00:00.000Z"
      },
      {
        id: "client:Videos/demo.srt",
        clientId: "client",
        path: "Videos/demo.srt",
        name: "demo.srt",
        size: 20,
        mimeType: "text/plain",
        updatedAt: "2026-07-01T00:00:00.000Z"
      }
    ];
    const result = await buildDiagnoseFileAccessResult(createApi(root, files), {
      fileId: "client:Videos/demo.mp4"
    });

    assert.equal(result.found, true);
    assert.equal(result.policy.root, "STORAGE_ROOT");
    assert.deepEqual(result.policy.allowedRoots, ["STORAGE_ROOT"]);
    assert.equal(result.file.path, "Videos/demo.mp4");
    assert.equal(result.safety.storageRootOnly, true);
    assert.equal(result.safety.absolutePathExposed, false);
    assert.equal(result.safety.binaryRawContentAllowed, false);
    assert.equal(result.contentAccess.videoOrAudio, true);
    assert.equal(result.contentAccess.subtitleAvailable, true);
    assert.equal(result.contentAccess.analyzeMode, "media");
    assert.ok(result.layers.find((layer) => layer.id === "excerpt")?.available);
    assert.ok(result.recommendedTools.includes("read_text_excerpt"));
    assert.ok(result.recommendedTools.includes("read_media_summary"));
    assert.ok(result.recommendedTools.includes("invoke_video_analyze"));
    const actionTools = result.actionPlan.map((action) => action.tool);
    assert.ok(actionTools.includes("read_file_metadata"));
    assert.ok(actionTools.includes("read_media_summary"));
    assert.ok(actionTools.includes("read_text_excerpt"));
    assert.ok(actionTools.includes("invoke_video_analyze"));
    assert.equal(result.actionPlan.find((action) => action.tool === "read_text_excerpt")?.input.source, "subtitle");
    assert.equal(result.actionPlan.find((action) => action.tool === "invoke_video_analyze")?.input.waitForCompletion, false);
    assert.ok(result.nextActions.some((item) => item.includes("字幕")));
    assert.doesNotMatch(JSON.stringify(result), new RegExp(root.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
  });
});

test("diagnose_file_access includes health dependency blockers for unanalyzed media", async () => {
  await withTempDir(async (root) => {
    const api = {
      ...createApi(root, [
        {
          id: "client:Videos/raw.mp4",
          clientId: "client",
          path: "Videos/raw.mp4",
          name: "raw.mp4",
          size: 100,
          mimeType: "video/mp4",
          updatedAt: "2026-07-01T00:00:00.000Z"
        }
      ]),
      healthSnapshot: {
        overall: "warn",
        checks: [
          { id: "ai-model", label: "AI 模型", status: "ok", detail: "text model ok" },
          { id: "ffmpeg", label: "ffmpeg", status: "ok", detail: "available" },
          { id: "ffprobe", label: "ffprobe", status: "ok", detail: "available" },
          {
            id: "whisper",
            label: "Whisper",
            status: "warn",
            detail: "C:\\secret\\whisper.exe 缺少模型文件",
            repairHint: "配置 WHISPER_CPP_PATH=C:\\secret\\whisper.exe 和 WHISPER_MODEL_PATH 后重启 storage-client"
          },
          { id: "storage-root", label: "NAS 文件访问", status: "ok", detail: `${root} 可读写` }
        ]
      }
    };

    const result = await buildDiagnoseFileAccessResult(api, {
      fileId: "client:Videos/raw.mp4"
    });

    assert.equal(result.dependencies.analysis.healthAvailable, true);
    assert.equal(result.dependencies.analysis.ready, false);
    assert.equal(result.dependencies.analysis.status, "warn");
    assert.deepEqual(result.dependencies.analysis.required, ["ai-model", "ffmpeg", "ffprobe", "whisper", "storage-root"]);
    assert.equal(result.dependencies.analysis.blockers[0].id, "whisper");
    assert.match(result.dependencies.analysis.blockers[0].detail, /\[local-path\]/);
    assert.match(result.dependencies.analysis.blockers[0].repairHint, /WHISPER_CPP_PATH=\[local-path\]/);
    assert.match(result.dependencies.analysis.repairHints[0], /WHISPER_MODEL_PATH/);
    assert.ok(result.blockers.some((item) => item.id === "dependency-whisper"));
    assert.match(result.blockers.find((item) => item.id === "dependency-whisper")?.repairHint || "", /WHISPER_CPP_PATH/);
    assert.equal(result.layers.find((layer) => layer.id === "analysis")?.available, false);
    assert.equal(result.actionPlan[0].tool, "diagnose_file_access");
    assert.equal(result.actionPlan[0].blocked, true);
    assert.ok(result.actionPlan[0].blockerIds.includes("dependency-whisper"));
    assert.match(result.nextActions[0], /Whisper|依赖/);
    assert.match(result.nextActions[0], /建议：Whisper/);
    assert.doesNotMatch(JSON.stringify(result), /C:\\secret/);
  });
});

test("diagnose_file_access reports missing files as searchable instead of reading outside the index", async () => {
  await withTempDir(async (root) => {
    const result = await buildDiagnoseFileAccessResult(createApi(root, []), {
      path: "missing.mp4"
    });

    assert.equal(result.found, false);
    assert.equal(result.blockers[0].id, "file-not-found");
    assert.deepEqual(result.recommendedTools, ["search_library_files", "list_storage_files"]);
    assert.deepEqual(result.actionPlan.map((action) => action.tool), ["search_library_files", "list_storage_files"]);
    assert.match(result.nextActions[0], /search_library_files/);
  });
});

test("image metadata recommends visual analysis rather than video analyze", async () => {
  await withTempDir(async (root) => {
    const api = createApi(root, [
      {
        id: "client:Images/photo.png",
        clientId: "client",
        path: "Images/photo.png",
        name: "photo.png",
        size: 100,
        mimeType: "image/png",
        updatedAt: "2026-07-01T00:00:00.000Z"
      }
    ]);

    const result = await buildLibraryMetadataResult(api, {
      fileId: "client:Images/photo.png"
    });

    assert.equal(result.files[0].contentAccess.image, true);
    assert.equal(result.files[0].contentAccess.videoOrAudio, false);
    assert.ok(result.files[0].contentAccess.recommendedTools.includes("analyze_file_content"));
    assert.ok(!result.files[0].contentAccess.recommendedTools.includes("invoke_video_analyze"));
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

    const publicPolicy = buildPublicFileAccessPolicy(createApi(root, []));
    assert.equal(publicPolicy.root, "STORAGE_ROOT");
    assert.deepEqual(publicPolicy.allowedRoots, ["STORAGE_ROOT"]);
    assert.equal(publicPolicy.rootLabel, "STORAGE_ROOT");
    assert.equal(publicPolicy.storageRootConfigured, true);
    assert.equal(publicPolicy.absolutePathExposed, false);
  });
});

test("library search results include agent next steps and action plans", async () => {
  await withTempDir(async (root) => {
    const files = [
      {
        id: "client:Videos/a.mp4",
        clientId: "client",
        path: "Videos/a.mp4",
        name: "a.mp4",
        size: 100,
        mimeType: "video/mp4",
        updatedAt: "2026-07-02T00:00:00.000Z",
        aiSummary: "A summary"
      },
      {
        id: "client:Videos/b.mp4",
        clientId: "client",
        path: "Videos/b.mp4",
        name: "b.mp4",
        size: 100,
        mimeType: "video/mp4",
        updatedAt: "2026-07-01T00:00:00.000Z"
      },
      {
        id: "client:Docs/readme.md",
        clientId: "client",
        path: "Docs/readme.md",
        name: "readme.md",
        size: 20,
        mimeType: "text/markdown",
        updatedAt: "2026-07-01T00:00:00.000Z"
      }
    ];
    const api = createApi(root, files);

    const single = await buildLibraryListResult(api, {
      query: "a.mp4",
      kind: "video",
      limit: 5
    });
    assert.equal(single.selection.status, "single-match");
    assert.equal(single.selection.confidence, "high");
    assert.match(single.nextActions[0], /read_file_metadata/);
    assert.deepEqual(single.actionPlan.map((action) => action.tool), ["read_file_metadata", "diagnose_file_access"]);
    assert.equal(single.actionPlan[0].input.fileId, "client:Videos/a.mp4");

    const multiple = await buildLibraryListResult(api, {
      kind: "video",
      limit: 5
    });
    assert.equal(multiple.selection.status, "multiple-matches");
    assert.match(multiple.nextActions[0], /找到 2 个候选/);
    assert.equal(multiple.actionPlan[0].tool, "read_file_metadata");
    assert.deepEqual(multiple.actionPlan[0].input.fileIds, ["client:Videos/a.mp4", "client:Videos/b.mp4"]);
    assert.equal(multiple.actionPlan[1].tool, "diagnose_file_access");

    const empty = await buildLibraryListResult(api, {
      query: "missing",
      kind: "video"
    });
    assert.equal(empty.selection.status, "no-results");
    assert.match(empty.nextActions[0], /放宽/);
    assert.equal(empty.actionPlan[0].tool, "search_library_files");
    assert.doesNotMatch(JSON.stringify({ single, multiple, empty }), new RegExp(root.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
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
    assert.equal(needsConfirmation.confirmation.operation, "organize_files");
    assert.equal(needsConfirmation.confirmation.riskLevel, "high");
    assert.equal(needsConfirmation.confirmation.impact.targetFileCount, 1);
    assert.deepEqual(needsConfirmation.confirmation.impact.changedFields, ["path"]);
    assert.match(needsConfirmation.confirmation.recoverability, /移回/);
    assert.equal(needsConfirmation.confirmation.confirmWith.confirmed, true);
    assert.equal(needsConfirmation.confirmation.confirmWith.dryRun, false);
    assert.equal(needsConfirmation.actions[0].status, "dry-run");
    assert.equal(fsSync.existsSync(path.join(root, sourceRelative)), true);
  });
});

test("update_file_metadata returns confirmation preview for batch writes", async () => {
  await withTempDir(async (root) => {
    const metadataWrites = [];
    const files = [
      {
        id: "client:a.md",
        clientId: "client",
        path: "a.md",
        name: "a.md",
        size: 1,
        mimeType: "text/markdown",
        updatedAt: "2026-07-01T00:00:00.000Z",
        tags: ["old"]
      },
      {
        id: "client:b.md",
        clientId: "client",
        path: "b.md",
        name: "b.md",
        size: 1,
        mimeType: "text/markdown",
        updatedAt: "2026-07-01T00:00:00.000Z",
        tags: []
      }
    ];
    const api = createApi(root, files, {
      upsertFileMeta: async (fileId, patch) => {
        metadataWrites.push({ fileId, patch });
      }
    });

    const preview = await buildUpdateFileMetadataResult(api, {
      fileIds: ["client:a.md", "client:b.md"],
      addTags: ["reviewed"]
    });

    assert.equal(preview.operation, "update_file_metadata");
    assert.equal(preview.riskLevel, "medium");
    assert.equal(preview.dryRun, true);
    assert.equal(preview.blocked, true);
    assert.equal(preview.requiresConfirmation, true);
    assert.equal(preview.confirmation.impact.targetFileCount, 2);
    assert.deepEqual(preview.confirmation.impact.changedFields, ["tags"]);
    assert.match(preview.confirmation.estimatedDuration, /分钟/);
    assert.equal(preview.confirmation.confirmWith.confirmed, true);
    assert.equal(preview.results.every((item) => item.status === "dry-run"), true);
    assert.deepEqual(metadataWrites, []);

    const executed = await buildUpdateFileMetadataResult(api, {
      fileIds: ["client:a.md", "client:b.md"],
      addTags: ["reviewed"],
      confirmed: true
    });

    assert.equal(executed.dryRun, false);
    assert.equal(executed.blocked, false);
    assert.equal(executed.requiresConfirmation, false);
    assert.equal(executed.confirmation, null);
    assert.equal(executed.results.every((item) => item.status === "updated"), true);
    assert.deepEqual(metadataWrites.map((item) => item.fileId), ["client:a.md", "client:b.md"]);
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
