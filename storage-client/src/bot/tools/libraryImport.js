import fs from "node:fs";
import path from "node:path";
import mime from "mime-types";

function normalizeRelativePath(value = "") {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
}

function sanitizeFileName(value = "", fallback = "download.bin") {
  const cleaned = String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^\.+$/, "");
  return cleaned || fallback;
}

async function moveFileWithFallback(sourcePath, targetPath) {
  try {
    await fs.promises.rename(sourcePath, targetPath);
    return;
  } catch (error) {
    if (error?.code !== "EXDEV") {
      throw error;
    }
  }

  await fs.promises.copyFile(sourcePath, targetPath);
  await fs.promises.rm(sourcePath, { force: true });
}

async function ensureUniqueTargetPath(targetPath) {
  const parsed = path.parse(targetPath);
  let candidate = targetPath;
  let counter = 1;
  while (true) {
    try {
      await fs.promises.access(candidate);
      candidate = path.join(parsed.dir, `${parsed.name} (${counter})${parsed.ext}`);
      counter += 1;
    } catch (error) {
      if (error?.code === "ENOENT") {
        return candidate;
      }
      throw error;
    }
  }
}

export async function importFileIntoLibrary(options = {}) {
  const storageRoot = path.resolve(options.storageRoot || process.cwd());
  const sourcePath = path.resolve(options.sourcePath || "");
  if (!sourcePath) {
    throw new Error("sourcePath is required");
  }
  const targetFolder = normalizeRelativePath(options.targetFolder || "");
  const preferredName = sanitizeFileName(options.fileName || path.basename(sourcePath), path.basename(sourcePath) || "download.bin");
  const targetDir = targetFolder ? path.join(storageRoot, targetFolder) : storageRoot;
  await fs.promises.mkdir(targetDir, { recursive: true });
  const uniqueTargetPath = await ensureUniqueTargetPath(path.join(targetDir, preferredName));
  await moveFileWithFallback(sourcePath, uniqueTargetPath);
  const stat = await fs.promises.stat(uniqueTargetPath);
  const relativePath = normalizeRelativePath(path.relative(storageRoot, uniqueTargetPath));
  return {
    absolutePath: uniqueTargetPath,
    relativePath,
    fileName: path.basename(uniqueTargetPath),
    size: Number(stat.size || 0),
    mimeType: mime.lookup(uniqueTargetPath) || "application/octet-stream"
  };
}

export async function triggerLibraryRescan(options = {}) {
  if (typeof options.syncFiles === "function") {
    await options.syncFiles();
  }
}
