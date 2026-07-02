import test from "node:test";
import assert from "node:assert/strict";

import {
  buildNasAgentTaskPresetPrompt,
  selectNasAgentTaskPresets
} from "../../src/bot/plugins/ai-chat/prompts/taskPresets.js";

test("video summary prompts include file search and invoke_video_analyze workflow", () => {
  const prompt = buildNasAgentTaskPresetPrompt({
    prompt: "找最近下载的视频，挑出没总结的并生成摘要"
  });

  assert.match(prompt, /Find NAS files/);
  assert.match(prompt, /Analyze or summarize media/);
  assert.match(prompt, /search_library_files/);
  assert.match(prompt, /read_media_summary/);
  assert.match(prompt, /invoke_video_analyze/);
  assert.match(prompt, /source/);
  assert.match(prompt, /Bilibili/);
  assert.match(prompt, /hasAiSummary=false/);
  assert.match(prompt, /waitUntilPhase=transcribe|waitUntilPhase/);
  assert.match(prompt, /status\/phase/);
  assert.doesNotMatch(prompt, /analyze_storage_video/);
});

test("Bilibili video summary prompts use invoke_video_analyze source", () => {
  const prompt = buildNasAgentTaskPresetPrompt({
    prompt: "总结 BV1xx411c7mD 这个 B 站视频"
  });

  assert.match(prompt, /Analyze or summarize media/);
  assert.match(prompt, /invoke_video_analyze/);
  assert.match(prompt, /source/);
  assert.match(prompt, /Bilibili/);
  assert.match(prompt, /jobId\/status\/phase/);
});

test("task playbooks inject matched capability examples only", () => {
  const prompt = buildNasAgentTaskPresetPrompt({
    prompt: "总结这个视频并保存摘要",
    descriptors: [
      {
        id: "search_library_files",
        examples: ["查 Movies 目录里没有摘要的 mp4"]
      },
      {
        id: "read_media_summary",
        examples: ["读取 D:\\Secret\\movie.mp4 的已有摘要"]
      },
      {
        id: "invoke_video_analyze",
        examples: ["总结这个视频并保存摘要，key=sk-should-not-leak-123456"]
      },
      {
        id: "invoke_music_control",
        examples: ["播放周杰伦的晴天"]
      }
    ]
  });

  assert.match(prompt, /Capability examples matched to this task/);
  assert.match(prompt, /search_library_files: 查 Movies 目录里没有摘要的 mp4/);
  assert.match(prompt, /read_media_summary: 读取 \[local-path\] 的已有摘要/);
  assert.match(prompt, /invoke_video_analyze: 总结这个视频并保存摘要，key=sk-\[redacted\]/);
  assert.doesNotMatch(prompt, /invoke_music_control/);
  assert.doesNotMatch(prompt, /D:\\Secret/);
  assert.doesNotMatch(prompt, /sk-should-not-leak/);
});

test("music prompts focus on invoke_music_control and QQ cookie degradation", () => {
  const prompt = buildNasAgentTaskPresetPrompt({
    prompt: "播放周杰伦的晴天，然后看一下队列"
  });

  assert.match(prompt, /Control music playback/);
  assert.match(prompt, /invoke_music_control/);
  assert.match(prompt, /QQ cookie degraded/);
});

test("image prompts route chat attachments and NAS images through vision tools", () => {
  const prompt = buildNasAgentTaskPresetPrompt({
    prompt: "看看这张截图，再分析 NAS 里最近的图片",
    descriptors: [
      {
        id: "describe_image",
        examples: ["看看这张图片有什么"]
      },
      {
        id: "analyze_file_content",
        examples: ["分析这个 NAS 图片文件"]
      }
    ]
  });

  assert.match(prompt, /Analyze a NAS file/);
  assert.match(prompt, /describe_image/);
  assert.match(prompt, /search_library_files kind=image/);
  assert.match(prompt, /analyze_file_content mode=image/);
  assert.match(prompt, /Capability examples matched to this task/);
  assert.match(prompt, /describe_image: 看看这张图片有什么/);
  assert.match(prompt, /analyze_file_content: 分析这个 NAS 图片文件/);
});

test("document read prompts prefer bounded excerpts before analysis", () => {
  const prompt = buildNasAgentTaskPresetPrompt({
    prompt: "读取这个 PDF 文档的前 2000 字并总结"
  });

  assert.match(prompt, /Read NAS documents or text excerpts/);
  assert.doesNotMatch(prompt, /Analyze or summarize media/);
  assert.match(prompt, /diagnose_file_access/);
  assert.match(prompt, /read_text_excerpt/);
  assert.match(prompt, /maxChars/);
  assert.match(prompt, /startChar/);
  assert.match(prompt, /analyze_file_content/);
  assert.match(prompt, /不要跳过片段读取/);
});

test("download prompts include concrete downloader adapters", () => {
  const prompt = buildNasAgentTaskPresetPrompt({
    prompt: "去 B 站找一个教程下载到库里，也可能给你一个 magnet"
  });

  assert.match(prompt, /Download into library/);
  assert.match(prompt, /search_bilibili_video/);
  assert.match(prompt, /invoke_bilibili_downloader/);
  assert.match(prompt, /invoke_torrent_downloader/);
  assert.match(prompt, /invoke_aria2_downloader/);
  assert.match(prompt, /waitUntilPhase=download/);
  assert.match(prompt, /status\/phase/);
});

test("diagnostic prompts require job status and agent trace tools", () => {
  const prompt = buildNasAgentTaskPresetPrompt({
    prompt: "刚才那个视频分析 job 为什么失败了，日志在哪"
  });

  assert.match(prompt, /Diagnose bot or agent failures/);
  assert.match(prompt, /get_bot_job_status/);
  assert.match(prompt, /read_bot_job_log/);
  assert.match(prompt, /read_agent_trace/);
});

test("includeAll exposes every preset with the always-on operating rules first", () => {
  const presets = selectNasAgentTaskPresets("", { includeAll: true });
  assert.equal(presets[0].id, "agent-operating-rules");
  assert.ok(presets.some((preset) => preset.id === "metadata-and-organization"));
  assert.ok(presets.some((preset) => preset.id === "file-access"));

  const prompt = buildNasAgentTaskPresetPrompt({ includeAll: true });
  assert.match(prompt, /organize_files/);
  assert.match(prompt, /explain_file_access/);
  assert.match(prompt, /diagnose_file_access/);
  assert.match(prompt, /High risk|高风险|confirmed=true/);
  assert.match(prompt, /waitUntilPhase/);
});

test("cleanup prompts route deletes through trash_files", () => {
  const prompt = buildNasAgentTaskPresetPrompt({
    prompt: "清理这些临时文件，删除前先让我确认"
  });

  assert.match(prompt, /Update metadata or organize files/);
  assert.match(prompt, /trash_files/);
  assert.match(prompt, /隐藏回收站/);
  assert.match(prompt, /不做永久删除/);
  assert.match(prompt, /dryRun=true/);
  assert.match(prompt, /confirmed=true/);
});
