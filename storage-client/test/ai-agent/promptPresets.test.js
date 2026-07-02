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
  assert.doesNotMatch(prompt, /analyze_storage_video/);
});

test("music prompts focus on invoke_music_control and QQ cookie degradation", () => {
  const prompt = buildNasAgentTaskPresetPrompt({
    prompt: "播放周杰伦的晴天，然后看一下队列"
  });

  assert.match(prompt, /Control music playback/);
  assert.match(prompt, /invoke_music_control/);
  assert.match(prompt, /QQ cookie degraded/);
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
});
