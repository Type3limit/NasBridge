import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const MAX_DOCUMENT_TEXT_CHARS = 200_000;
export const MAX_DOCUMENT_READ_BYTES = 16 * 1024 * 1024;

const PDF_EXTS = new Set([".pdf"]);
const OOXML_EXTS = new Set([".docx", ".docm", ".pptx", ".pptm", ".xlsx", ".xlsm"]);
const DOCUMENT_EXTS = new Set([...PDF_EXTS, ...OOXML_EXTS]);

function clampInteger(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}

function getExtension(filePath = "") {
  return path.extname(String(filePath || "")).toLowerCase();
}

export function isExtractableDocumentPath(filePath = "", mimeType = "") {
  const ext = getExtension(filePath);
  const mime = String(mimeType || "").toLowerCase();
  return (
    DOCUMENT_EXTS.has(ext)
    || mime.includes("pdf")
    || mime.includes("officedocument")
  );
}

function decodeXmlEntities(value = "") {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (match, hex) => {
      const codePoint = Number.parseInt(hex, 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    })
    .replace(/&#(\d+);/g, (match, dec) => {
      const codePoint = Number.parseInt(dec, 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    })
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

function normalizeExtractedText(value = "") {
  return String(value || "")
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sliceExcerpt(text = "", options = {}) {
  const maxChars = clampInteger(options.maxChars || 8_000, 1, Number(options.maxAllowedChars || 20_000) || 20_000);
  const startChar = clampInteger(options.startChar || options.offset || 0, 0, Number.MAX_SAFE_INTEGER);
  const normalized = String(text || "");
  const excerpt = normalized.slice(startChar, startChar + maxChars);
  return {
    text: excerpt,
    startChar,
    nextStartChar: startChar + excerpt.length,
    length: normalized.length,
    truncated: startChar + excerpt.length < normalized.length
  };
}

async function readFileHead(filePath = "", maxBytes = MAX_DOCUMENT_READ_BYTES) {
  const stat = await fs.promises.stat(filePath);
  if (stat.size <= maxBytes) {
    return { buffer: await fs.promises.readFile(filePath), truncated: false, fileSize: stat.size };
  }
  const handle = await fs.promises.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return { buffer: buffer.subarray(0, bytesRead), truncated: true, fileSize: stat.size };
  } finally {
    await handle.close();
  }
}

async function pathExists(filePath = "") {
  const normalized = String(filePath || "").trim();
  if (!normalized) {
    return false;
  }
  try {
    const stat = await fs.promises.stat(normalized);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function resolvePdfToTextCommand(options = {}) {
  const configured = String(
    options.pdfToTextPath
    || process.env.PDF_TO_TEXT_PATH
    || process.env.PDFTOTEXT_PATH
    || process.env.POPPLER_PDFTOTEXT_PATH
    || ""
  ).trim();
  if (configured) {
    return await pathExists(configured) ? configured : "";
  }
  return "pdftotext";
}

async function extractPdfWithPdftotext(filePath = "", options = {}) {
  const command = await resolvePdfToTextCommand(options);
  if (!command) {
    return null;
  }
  try {
    const { stdout } = await execFileAsync(command, ["-enc", "UTF-8", "-layout", filePath, "-"], {
      timeout: clampInteger(options.timeoutMs || 10_000, 1000, 60_000),
      maxBuffer: clampInteger(options.maxBuffer || 5 * 1024 * 1024, 256 * 1024, 32 * 1024 * 1024),
      windowsHide: true
    });
    const text = normalizeExtractedText(stdout);
    return text ? { text, extractor: "pdftotext", sourceTruncated: false } : null;
  } catch {
    return null;
  }
}

function decodePdfLiteralString(value = "") {
  let output = "";
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char !== "\\") {
      output += char;
      continue;
    }
    const next = value[i + 1] || "";
    if (!next) {
      break;
    }
    if (next === "n") output += "\n";
    else if (next === "r") output += "\r";
    else if (next === "t") output += "\t";
    else if (next === "b") output += "\b";
    else if (next === "f") output += "\f";
    else if (next === "(" || next === ")" || next === "\\") output += next;
    else if (/[0-7]/.test(next)) {
      let octal = next;
      for (let j = 2; j <= 3 && /[0-7]/.test(value[i + j] || ""); j += 1) {
        octal += value[i + j];
      }
      output += String.fromCharCode(Number.parseInt(octal, 8));
      i += octal.length - 1;
    } else {
      output += next;
    }
    i += 1;
  }
  return output;
}

function readPdfLiteralAt(text = "", start = 0) {
  if (text[start] !== "(") {
    return null;
  }
  let depth = 1;
  let escaped = false;
  let value = "";
  for (let i = start + 1; i < text.length; i += 1) {
    const char = text[i];
    if (escaped) {
      value += `\\${char}`;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "(") {
      depth += 1;
      value += char;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return { value: decodePdfLiteralString(value), end: i + 1 };
      }
      value += char;
      continue;
    }
    value += char;
  }
  return null;
}

function decodePdfHexString(hex = "") {
  const clean = String(hex || "").replace(/[^0-9a-f]/gi, "");
  if (!clean) {
    return "";
  }
  const padded = clean.length % 2 ? `${clean}0` : clean;
  const bytes = Buffer.from(padded, "hex");
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let output = "";
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      output += String.fromCharCode(bytes.readUInt16BE(i));
    }
    return output;
  }
  return bytes.toString("utf8");
}

function extractTextTokensFromPdfSection(section = "") {
  const tokens = [];
  for (let i = 0; i < section.length; i += 1) {
    const char = section[i];
    if (char === "(") {
      const literal = readPdfLiteralAt(section, i);
      if (literal) {
        tokens.push(literal.value);
        i = literal.end - 1;
      }
      continue;
    }
    if (char === "<" && section[i + 1] !== "<") {
      const end = section.indexOf(">", i + 1);
      if (end > i) {
        tokens.push(decodePdfHexString(section.slice(i + 1, end)));
        i = end;
      }
    }
  }
  return tokens;
}

function extractPdfTextFromContent(content = "") {
  const sections = [];
  const btRegex = /BT([\s\S]*?)ET/g;
  let match = null;
  while ((match = btRegex.exec(content))) {
    sections.push(match[1]);
  }
  const sources = sections.length ? sections : [content];
  return normalizeExtractedText(
    sources
      .flatMap((section) => extractTextTokensFromPdfSection(section))
      .filter(Boolean)
      .join(" ")
  );
}

function collectPdfStreams(buffer = Buffer.alloc(0)) {
  const latin1 = buffer.toString("latin1");
  const streams = [];
  const streamRegex = /<<(?:.|\r|\n)*?>>\s*stream\r?\n?/g;
  let match = null;
  while ((match = streamRegex.exec(latin1))) {
    const dict = match[0];
    const start = match.index + match[0].length;
    const end = latin1.indexOf("endstream", start);
    if (end < start) {
      continue;
    }
    let dataStart = start;
    let dataEnd = end;
    if (buffer[dataEnd - 1] === 0x0a) dataEnd -= 1;
    if (buffer[dataEnd - 1] === 0x0d) dataEnd -= 1;
    let data = buffer.subarray(dataStart, dataEnd);
    if (/FlateDecode/i.test(dict)) {
      try {
        data = zlib.inflateSync(data);
      } catch {
        try {
          data = zlib.inflateRawSync(data);
        } catch {
          data = Buffer.alloc(0);
        }
      }
    }
    if (data.length) {
      streams.push(data.toString("latin1"));
    }
    streamRegex.lastIndex = end + "endstream".length;
  }
  return streams;
}

async function extractPdfWithFallback(filePath = "", options = {}) {
  const { buffer, truncated } = await readFileHead(filePath, clampInteger(options.maxReadBytes || MAX_DOCUMENT_READ_BYTES, 1024, MAX_DOCUMENT_READ_BYTES));
  const streamText = collectPdfStreams(buffer)
    .map((stream) => extractPdfTextFromContent(stream))
    .filter(Boolean)
    .join("\n\n");
  const text = streamText || extractPdfTextFromContent(buffer.toString("latin1"));
  const normalized = normalizeExtractedText(text);
  return normalized ? { text: normalized, extractor: "pdf-fallback", sourceTruncated: truncated } : null;
}

function findEndOfCentralDirectory(buffer = Buffer.alloc(0)) {
  for (let i = buffer.length - 22; i >= 0 && i >= buffer.length - 66_000; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      return i;
    }
  }
  return -1;
}

function readZipEntries(buffer = Buffer.alloc(0)) {
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) {
    return [];
  }
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < entryCount && offset + 46 <= buffer.length; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      break;
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const nameEncoding = flags & 0x0800 ? "utf8" : "latin1";
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString(nameEncoding).replace(/\\/g, "/");
    offset += 46 + nameLength + extraLength + commentLength;

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      continue;
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) {
      continue;
    }
    const compressed = buffer.subarray(dataStart, dataEnd);
    let data = null;
    if (method === 0) {
      data = compressed;
    } else if (method === 8) {
      try {
        data = zlib.inflateRawSync(compressed);
      } catch {
        data = null;
      }
    }
    if (data) {
      entries.push({ name, data });
    }
  }
  return entries;
}

function selectOoxmlXmlEntries(entries = [], ext = "") {
  const files = entries.filter((entry) => entry.name.endsWith(".xml"));
  if (ext === ".docx" || ext === ".docm") {
    return files.filter((entry) => (
      entry.name === "word/document.xml"
      || /^word\/(footnotes|endnotes)\.xml$/i.test(entry.name)
      || /^word\/(header|footer)\d*\.xml$/i.test(entry.name)
    ));
  }
  if (ext === ".pptx" || ext === ".pptm") {
    return files.filter((entry) => /^ppt\/(slides|notesSlides)\/.+\.xml$/i.test(entry.name));
  }
  if (ext === ".xlsx" || ext === ".xlsm") {
    return files.filter((entry) => (
      entry.name === "xl/sharedStrings.xml"
      || /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry.name)
    ));
  }
  return [];
}

function extractXmlVisibleText(xml = "") {
  const textPieces = [];
  const tagRegex = /<(?:[A-Za-z0-9_]+:)?(?:t|v)(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?(?:t|v)>/g;
  let match = null;
  while ((match = tagRegex.exec(xml))) {
    const text = decodeXmlEntities(String(match[1] || "").replace(/<[^>]+>/g, ""));
    if (text.trim()) {
      textPieces.push(text);
    }
  }
  if (textPieces.length) {
    return normalizeExtractedText(textPieces.join(" "));
  }
  return normalizeExtractedText(decodeXmlEntities(xml.replace(/<[^>]+>/g, " ")));
}

async function extractOoxmlText(filePath = "", options = {}) {
  const ext = getExtension(filePath);
  const { buffer, truncated } = await readFileHead(filePath, clampInteger(options.maxReadBytes || MAX_DOCUMENT_READ_BYTES, 1024, MAX_DOCUMENT_READ_BYTES));
  const entries = selectOoxmlXmlEntries(readZipEntries(buffer), ext);
  const text = entries
    .map((entry) => extractXmlVisibleText(entry.data.toString("utf8")))
    .filter(Boolean)
    .join("\n\n");
  const normalized = normalizeExtractedText(text);
  return normalized ? { text: normalized, extractor: "ooxml", sourceTruncated: truncated } : null;
}

async function extractPdfText(filePath = "", options = {}) {
  const byTool = await extractPdfWithPdftotext(filePath, options);
  if (byTool) {
    return byTool;
  }
  return extractPdfWithFallback(filePath, options);
}

export async function extractDocumentTextExcerpt(filePath = "", options = {}) {
  const ext = getExtension(options.relativePath || filePath);
  let extracted = null;
  if (PDF_EXTS.has(ext) || String(options.mimeType || "").toLowerCase().includes("pdf")) {
    extracted = await extractPdfText(filePath, options);
  } else if (OOXML_EXTS.has(ext) || String(options.mimeType || "").toLowerCase().includes("officedocument")) {
    extracted = await extractOoxmlText(filePath, options);
  }
  if (!extracted || !String(extracted.text || "").trim()) {
    throw new Error(`document text extraction produced no text for ${path.basename(options.relativePath || filePath)}`);
  }
  const maxDocumentChars = clampInteger(options.maxDocumentChars || MAX_DOCUMENT_TEXT_CHARS, 1_000, MAX_DOCUMENT_TEXT_CHARS);
  const bounded = String(extracted.text || "").slice(0, maxDocumentChars);
  const excerpt = sliceExcerpt(bounded, options);
  return {
    ...excerpt,
    source: "document",
    extractor: extracted.extractor,
    format: ext.replace(/^\./, "") || "document",
    sourceTruncated: extracted.sourceTruncated === true || String(extracted.text || "").length > bounded.length,
    truncated: excerpt.truncated || extracted.sourceTruncated === true || String(extracted.text || "").length > bounded.length
  };
}

export async function getDocumentTextExtractionHealth(options = {}) {
  const configured = String(
    options.pdfToTextPath
    || process.env.PDF_TO_TEXT_PATH
    || process.env.PDFTOTEXT_PATH
    || process.env.POPPLER_PDFTOTEXT_PATH
    || ""
  ).trim();
  if (configured && !await pathExists(configured)) {
    return {
      id: "document-text",
      label: "文档文本抽取",
      status: "warn",
      detail: "PDF pdftotext 路径已配置但文件不存在；Office Open XML 使用内置抽取，PDF 使用有限 fallback"
    };
  }
  return {
    id: "document-text",
    label: "文档文本抽取",
    status: "ok",
    detail: configured
      ? "PDF 使用 pdftotext；Office Open XML 使用内置抽取"
      : "Office Open XML 使用内置抽取；PDF 未配置 pdftotext 时使用有限 fallback"
  };
}
