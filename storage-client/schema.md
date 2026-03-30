# Storage Client Bot Plugin Schema

## 1. Goal

This document defines the bot plugin architecture that runs on the storage client side.

The design target is:

- Keep the public server lightweight.
- Keep large bandwidth tasks away from the server.
- Reuse the existing chat host model and local file system on the storage client.
- Make future bot additions consistent, auditable, and safe.

This schema is the source of truth for future bot-related design and implementation in the storage client.

## 2. Why Storage Client

Bots MUST execute on the storage client instead of the public server for these reasons:

- Large file downloads, video parsing, ffmpeg work, and multimodal model inputs should stay close to local disk.
- The public server is currently a control plane with low bandwidth and should remain signaling/API oriented.
- Chat history and chat attachments already land on the storage client.
- A bot that downloads or generates a file can write it directly into STORAGE_ROOT and trigger local indexing, without relaying bytes through browser or server.

## 3. Non-Goals

This schema does NOT require:

- Running arbitrary user-supplied scripts.
- Executing bot workloads on the public server.
- Turning the browser into a long-running bot worker.
- Allowing AI bots to call every local tool without explicit permission control.

## 4. Design Principles

- Control plane over lightweight messages, data plane over local disk or existing P2P channels.
- Bot invocation MUST be explicit, normally via chat mention such as @bili or @ai.
- Bot outputs MUST be represented as jobs with stable state transitions.
- Bot plugins MUST declare permissions before they can run.
- Long-running tasks MUST be asynchronous and cancellable.
- Chat-facing bot responses MUST be append-only events, consistent with the current chat history model.
- Future plugins MUST fit into the same runtime contract.

## 5. Terms

- Browser: the web app session.
- Server: the public control server.
- Storage Client: the machine that owns STORAGE_ROOT and executes plugins.
- Chat Host Client: the storage client identified by hostClientId for the current chat room.
- Bot Runtime: the in-process runtime inside storage-client that manages plugins and jobs.
- Bot Plugin: a capability provider such as bilibili downloader or AI assistant.
- Bot Job: one concrete invocation of a plugin.

## 6. Current System Integration

The bot design extends the existing architecture:

- Browser already appends chat history through the storage client using append-chat-message.
- Browser already uploads chat attachments to the storage client.
- Server already broadcasts lightweight room events through WebSocket.
- Storage client already owns file write, rename, delete, preview, and chat history append responsibilities.

Therefore bot invocation SHOULD follow this rule:

- Browser detects an @bot mention and sends a control message to the chat host storage client.
- Storage client executes the bot locally.
- Storage client appends bot output to chat history locally.
- Storage client publishes lightweight room events through server WebSocket.
- Browser refreshes resource list through existing APIs after bot-created files are indexed.

## 7. Proposed Storage Client Modules

The implementation SHOULD be organized under these modules.

### 7.1 Runtime Core

- storage-client/src/bot/runtime.js
  - Owns startup, shutdown, registry wiring, and top-level dispatch.
- storage-client/src/bot/registry.js
  - Registers plugins and resolves aliases such as @bili, @ai.
- storage-client/src/bot/queue.js
  - Owns concurrency limits, cancellation, retry rules, and scheduling.
- storage-client/src/bot/jobStore.js
  - Persists job metadata and execution logs.
- storage-client/src/bot/context.js
  - Builds chat context, attachment references, and resource references for plugins.
- storage-client/src/bot/permissions.js
  - Validates plugin-declared permissions before execution.
- storage-client/src/bot/events.js
  - Emits structured bot job events and chat output events.

### 7.2 Plugin Surface

- storage-client/src/bot/plugins/base.js
  - Shared types and helpers.
- storage-client/src/bot/plugins/bilibili.js
  - BV/link parse, metadata fetch, media download, local import.
- storage-client/src/bot/plugins/ai-chat.js
  - Chat summarization, explanation, and structured tool calling.
- storage-client/src/bot/plugins/multimodal-image.js
  - Optional image understanding plugin.

### 7.3 Shared Tools

- storage-client/src/bot/tools/chatHistory.js
  - Read recent chat history slices.
- storage-client/src/bot/tools/chatAssets.js
  - Resolve local attachment files.
- storage-client/src/bot/tools/libraryImport.js
  - Write downloaded/generated files into STORAGE_ROOT and trigger reindex.
- storage-client/src/bot/tools/httpFetch.js
  - Controlled outbound HTTP with size and host restrictions.
- storage-client/src/bot/tools/llmClient.js
  - Text or multimodal model access.
- storage-client/src/bot/tools/mediaProbe.js
  - ffprobe metadata, thumbnail extraction, format checks.

### 7.4 Existing Integration Points

The current storage-client main loop in [storage-client/src/index.js](storage-client/src/index.js#L2055) SHOULD integrate the Bot Runtime in three places:

- During startup: initialize Bot Runtime after client registration succeeds.
- In control DataChannel message handling: route bot invocation and bot job control messages.
- In server WebSocket handling: allow bot-originated room events to be published.

## 8. Local Data Layout

Bot state MUST NOT pollute user-visible library content.

Recommended internal layout under the storage client app data area:

```text
.nas-bot/
  jobs/
    <jobId>.json
  logs/
    <jobId>.log
  cache/
    bilibili/
    ai/
  temp/
    <jobId>/
  manifests/
    plugins.json
```

Rules:

- Temporary downloads MUST go under temp.
- Final imported files MUST move into STORAGE_ROOT user-visible paths.
- Jobs and logs MUST survive process restarts.
- Cache directories SHOULD be size-limited and periodically cleaned.

## 9. Bot Catalog Schema

Each plugin MUST expose a manifest compatible with this shape:

```json
{
  "botId": "bilibili.downloader",
  "version": "1.0.0",
  "displayName": "Bilibili Downloader",
  "aliases": ["bili", "bilibili"],
  "description": "Download a Bilibili video by BV id or URL and import it into the local library.",
  "entrypoint": "./plugins/bilibili.js",
  "kind": "task",
  "capabilities": ["download.remote-media", "import.library", "reply.chat"],
  "permissions": {
    "readChatHistory": false,
    "readChatAttachments": false,
    "readLibrary": false,
    "writeLibrary": true,
    "outboundHttp": true,
    "spawnProcess": true,
    "llm": false,
    "multimodal": false
  },
  "limits": {
    "maxConcurrentJobs": 1,
    "timeoutMs": 3600000,
    "maxDownloadBytes": 21474836480,
    "maxTempBytes": 32212254720
  },
  "triggers": {
    "mentionNames": ["bili", "bilibili"],
    "matchMode": "explicit-mention"
  },
  "inputSchema": {
    "type": "object",
    "required": ["source"],
    "properties": {
      "source": {
        "type": "string",
        "description": "BV id or Bilibili URL"
      },
      "targetFolder": {
        "type": "string"
      }
    }
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "importedFiles": {
        "type": "array"
      },
      "chatReply": {
        "type": "object"
      }
    }
  }
}
```

Rules:

- botId MUST be globally unique.
- aliases MUST be unique within a storage client.
- permissions MUST be explicit and default-deny.
- limits MUST exist for every plugin.
- inputSchema MUST be machine-validated before execution.

## 10. Bot Invocation Context Schema

Every job MUST be created from a normalized invocation context.

```json
{
  "jobId": "botjob_01JXYZ...",
  "botId": "bilibili.downloader",
  "trigger": {
    "type": "chat-mention",
    "rawText": "@bili BV1xx...",
    "parsedArgs": {
      "source": "BV1xx..."
    }
  },
  "requester": {
    "userId": "user_123",
    "displayName": "Alice",
    "role": "user"
  },
  "chat": {
    "hostClientId": "client_123",
    "dayKey": "2026-03-11",
    "historyPath": ".nas-chat-room/history/2026-03-11.jsonl",
    "messageId": "msg_123",
    "replyMode": "append-chat-history"
  },
  "attachments": [
    {
      "id": "client:path",
      "clientId": "client_123",
      "path": ".nas-chat-room/attachments/...",
      "name": "image.png",
      "mimeType": "image/png",
      "size": 12345
    }
  ],
  "options": {
    "allowToolCalls": false,
    "interactive": false
  },
  "createdAt": "2026-03-11T10:00:00.000Z"
}
```

Rules:

- chat.hostClientId MUST match the current storage client before execution starts.
- chat.historyPath MUST identify where the bot should append its reply.
- requester identity MUST be carried through into logs and audit metadata.
- attachments are references, not inlined file bytes.

## 11. Bot Job Schema

Bot jobs MUST be persisted with this logical shape:

```json
{
  "jobId": "botjob_01JXYZ...",
  "botId": "ai.chat",
  "status": "running",
  "phase": "tool-call",
  "progress": {
    "label": "Calling image description tool",
    "percent": 55
  },
  "requester": {
    "userId": "user_123",
    "displayName": "Alice"
  },
  "chat": {
    "hostClientId": "client_123",
    "historyPath": ".nas-chat-room/history/2026-03-11.jsonl",
    "messageId": "msg_123"
  },
  "input": {
    "rawText": "@ai summarize the last 20 messages"
  },
  "result": {
    "replyMessageId": "botmsg_456",
    "importedFiles": [],
    "artifacts": []
  },
  "error": null,
  "audit": {
    "permissionsUsed": ["readChatHistory", "llm"],
    "toolCalls": []
  },
  "createdAt": "2026-03-11T10:00:00.000Z",
  "startedAt": "2026-03-11T10:00:02.000Z",
  "finishedAt": null,
  "updatedAt": "2026-03-11T10:00:10.000Z"
}
```

Allowed job status values:

- queued
- validating
- running
- waiting-user-confirmation
- succeeded
- failed
- cancelled
- expired

Allowed job phase examples:

- parse-input
- load-context
- download-remote
- analyze
- tool-call
- import-library
- append-chat-reply
- sync-index

Rules:

- Status transitions MUST be monotonic and auditable.
- finishedAt MUST be set for succeeded, failed, cancelled, and expired jobs.
- result.importedFiles SHOULD contain final library file ids or relative paths.

## 12. Browser to Storage Client DataChannel Protocol

The existing control channel already supports delete-file, rename-file, and append-chat-message. Bot control SHOULD extend the same control channel.

### 12.1 get-bot-catalog

Purpose:

- Fetch the available bot list for the current storage client.

Request:

```json
{
  "type": "get-bot-catalog",
  "requestId": "req_123"
}
```

Response:

```json
{
  "type": "bot-catalog-result",
  "requestId": "req_123",
  "bots": [
    {
      "botId": "bilibili.downloader",
      "displayName": "Bilibili Downloader",
      "aliases": ["bili", "bilibili"],
      "description": "Download Bilibili videos into local library.",
      "kind": "task"
    }
  ]
}
```

### 12.2 invoke-bot

Purpose:

- Create a bot job on the current chat host storage client.

Request:

```json
{
  "type": "invoke-bot",
  "requestId": "req_124",
  "botId": "bilibili.downloader",
  "trigger": {
    "type": "chat-mention",
    "rawText": "@bili BV1xx...",
    "parsedArgs": {
      "source": "BV1xx...",
      "targetFolder": "videos/bilibili"
    }
  },
  "requester": {
    "userId": "user_123",
    "displayName": "Alice"
  },
  "chat": {
    "hostClientId": "client_123",
    "dayKey": "2026-03-11",
    "historyPath": ".nas-chat-room/history/2026-03-11.jsonl",
    "messageId": "msg_123"
  },
  "attachments": [],
  "options": {
    "allowToolCalls": false
  }
}
```

Ack response:

```json
{
  "type": "bot-job-accepted",
  "requestId": "req_124",
  "job": {
    "jobId": "botjob_01JXYZ",
    "botId": "bilibili.downloader",
    "status": "queued"
  }
}
```

Reject response:

```json
{
  "type": "error",
  "requestId": "req_124",
  "message": "bot not found"
}
```

### 12.3 get-bot-job

Purpose:

- Fetch current job state after reconnect or page refresh.

Request:

```json
{
  "type": "get-bot-job",
  "requestId": "req_125",
  "jobId": "botjob_01JXYZ"
}
```

Response:

```json
{
  "type": "bot-job-result",
  "requestId": "req_125",
  "job": {
    "jobId": "botjob_01JXYZ",
    "botId": "bilibili.downloader",
    "status": "running",
    "phase": "download-remote"
  }
}
```

### 12.4 cancel-bot-job

Purpose:

- Request cancellation of a running or queued job.

Request:

```json
{
  "type": "cancel-bot-job",
  "requestId": "req_126",
  "jobId": "botjob_01JXYZ"
}
```

Response:

```json
{
  "type": "bot-job-cancelled",
  "requestId": "req_126",
  "jobId": "botjob_01JXYZ",
  "status": "cancelled"
}
```

## 13. Storage Client to Browser Job Event Stream

Bot jobs SHOULD produce lightweight progress updates over the existing room message path so all browser sessions in the room can observe progress and result rendering with one stable message id.

Recommended event model:

- chat-room-message with bot metadata
- stable message id per job for in-place updates

### 13.1 Unified Bot Room Message

Purpose:

- Represent bot progress, status, and result using the same chat message stream already used by regular room messages.
- Allow the browser to replace the same message by id as the job evolves from queued -> running -> succeeded or failed.

Payload:

```json
{
  "type": "chat-room-message",
  "payload": {
    "id": "bot-status:botjob_01JXYZ",
    "text": "",
    "createdAt": "2026-03-11T10:01:00.000Z",
    "dayKey": "2026-03-11",
    "historyPath": ".nas-chat-room/history/2026-03-11.jsonl",
    "hostClientId": "client_123",
    "attachments": [
      {
        "id": "bot-asset:botjob_01JXYZ",
        "name": "Example [BV1xx].mp4",
        "mimeType": "video/mp4",
        "size": 123456789,
        "path": "downloads/bilibili/Example [BV1xx].mp4",
        "clientId": "client_123",
        "kind": "video"
      }
    ],
    "author": {
      "id": "bot:bilibili.downloader",
      "displayName": "Bilibili Downloader",
      "avatarUrl": "",
      "avatarClientId": "",
      "avatarPath": "",
      "avatarFileId": ""
    },
    "bot": {
      "botId": "bilibili.downloader",
      "jobId": "botjob_01JXYZ"
    },
    "card": {
      "type": "media-result",
      "status": "succeeded",
      "title": "Example Video Title",
      "subtitle": "Uploader Name · downloads/bilibili/Example [BV1xx].mp4",
      "body": "已入库到 downloads/bilibili/Example [BV1xx].mp4",
      "progress": null,
      "imageUrl": "https://i0.hdslb.com/bfs/archive/example-cover.jpg",
      "imageAlt": "Example Video Title",
      "mediaAttachmentId": "bot-asset:botjob_01JXYZ",
      "sourceLabel": "https://www.bilibili.com/video/BV1xx",
      "sourceUrl": "https://www.bilibili.com/video/BV1xx",
      "actions": [
        {
          "type": "open-attachment",
          "label": "打开资源",
          "attachmentId": "bot-asset:botjob_01JXYZ"
        },
        {
          "type": "open-url",
          "label": "打开来源",
          "url": "https://www.bilibili.com/video/BV1xx"
        }
      ]
    }
  }
}
```

Rules:

- The server SHOULD accept bot-authored chat-room-message only from authenticated client-role sockets.
- The browser SHOULD merge bot messages by message id so the same card can be updated in place.
- Progress cards SHOULD use the same id as the final result card for a given job.
- Result cards SHOULD clear the progress bar and replace it with result-specific content when the job enters succeeded, failed, or cancelled.

### 13.2 message.card Schema

Purpose:

- Provide a reusable card payload for bots such as downloader, AI assistant, media analyzer, and multimodal tools.

Logical shape:

```json
{
  "type": "bot-status",
  "status": "running",
  "title": "Bilibili Downloader",
  "subtitle": "解析视频信息",
  "body": "正在下载媒体流",
  "progress": 42,
  "imageUrl": "https://example.com/cover.jpg",
  "imageAlt": "cover",
  "mediaAttachmentId": "bot-asset:botjob_01JXYZ",
  "sourceLabel": "https://example.com/source",
  "sourceUrl": "https://example.com/source",
  "actions": [
    {
      "type": "open-attachment",
      "label": "打开资源",
      "attachmentId": "bot-asset:botjob_01JXYZ"
    },
    {
      "type": "open-url",
      "label": "打开来源",
      "url": "https://example.com/source"
    }
  ]
}
```

Field rules:

- type identifies the renderer intent, such as bot-status, media-result, ai-answer, or image-analysis.
- status MAY be queued, running, succeeded, failed, cancelled, or info.
- title SHOULD be short and stable.
- subtitle SHOULD hold one-line metadata such as uploader, model name, or target path.
- body MAY contain multi-line details.
- progress SHOULD only be present for queued or running states.
- imageUrl MAY point to a remote cover or thumbnail.
- mediaAttachmentId SHOULD reference one attachment already present on the same message.
- actions MUST be lightweight UI intents and MUST NOT embed executable code.
- open-attachment actions SHOULD reference attachments already on the same message.
- open-url actions SHOULD open external source pages in a new tab.

## 14. Chat Mention Parsing Contract

Mention parsing SHOULD happen in the browser before invoke-bot is sent.

Suggested rules:

- Bot invocation requires explicit mention at the beginning of the command segment.
- Examples:
  - @bili BV1xxxx
  - @bilibili https://www.bilibili.com/video/BV1xxxx
  - @ai summarize the last 30 messages
  - @ai describe the last uploaded image
- A single chat message MAY invoke more than one bot in the future, but v1 SHOULD allow at most one bot invocation per message.

If the browser cannot confidently parse the mention, it SHOULD still send the plain chat message and skip bot invocation.

## 15. Library Import Contract

Any bot that creates files MUST import them through a common local library import helper.

Required steps:

1. Write output to a temp path.
2. Validate final filename and MIME type.
3. Move file into a target library folder under STORAGE_ROOT.
4. Trigger local rescan for the affected path or full filesync fallback.
5. Emit a success or failure bot-room-message.

Imported file metadata SHOULD include:

- relativePath
- fileName
- mimeType
- size
- importedByBotId
- importedFromJobId
- sourceUrl if available

## 16. AI Tool Call Contract

AI bots MUST NOT receive unrestricted local execution.

AI-capable plugins SHOULD only use explicitly registered tools.

Recommended tool schema:

```json
{
  "toolName": "read_chat_history",
  "description": "Read the most recent chat messages for the current room.",
  "inputSchema": {
    "type": "object",
    "required": ["limit"],
    "properties": {
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      }
    }
  },
  "permissionsRequired": ["readChatHistory"]
}
```

Initial allowlist for AI bots SHOULD be limited to:

- read_chat_history
- read_chat_attachment
- import_bilibili_video
- describe_image
- summarize_file
- rescan_library_path

High-risk tools SHOULD require one of these protections:

- admin-only requester
- per-plugin allowlist
- user confirmation event before execution

## 17. Bilibili Downloader Bot Contract

Bot id:

- bilibili.downloader

Input:

- optional action: login/status/logout/relogin
- source: BV id or Bilibili URL
- optional targetFolder
- optional page: 1-based 分 P 序号
- optional quality: 期望清晰度，例如 1080p、720p、4k、80

Behavior:

1. Validate source format.
2. Resolve canonical media metadata.
3. Download to temp.
4. Optionally fetch cover and subtitle sidecars.
5. Import final files into STORAGE_ROOT.
6. Trigger library rescan.
7. Append bot reply into chat.

Permissions required:

- outboundHttp
- spawnProcess or downloader subprocess
- writeLibrary
- replyChat

Suggested reply content:

- title
- duration if known
- imported path
- final size
- failure reason if any

Important rule:

- The bot MUST download directly on the storage client. It MUST NOT route media bytes through the browser or public server.

## 18. AI Chat Bot Contract

Bot id:

- ai.chat

Input:

- prompt text derived from the mention command
- optional reference attachments
- optional context window settings

Behavior:

1. Load compact recent room context.
2. Resolve explicit attachment references if needed.
3. Optionally call allowlisted tools.
4. Produce a chat reply.
5. Append reply to local chat history.
6. Emit bot-room-message event.

Permissions required:

- readChatHistory
- optional readChatAttachments
- llm
- optional multimodal
- replyChat

Context rule:

- AI bots SHOULD send compact summaries and recent turns instead of the entire raw room history.

This aligns with the existing repository note that AI context should stay compact.

## 19. Security Model

Every plugin MUST run under a permission gate.

Permission names:

- readChatHistory
- readChatAttachments
- readLibrary
- writeLibrary
- outboundHttp
- spawnProcess
- llm
- multimodal
- replyChat
- publishJobEvents

Security requirements:

- Permissions are default-deny.
- Plugin manifest permissions MUST be checked before execution.
- Plugins with spawnProcess MUST use a controlled command allowlist.
- outboundHttp SHOULD support host allowlist or denylist.
- AI tool calls MUST be validated against per-tool schemas.
- User-facing bot messages MUST NOT leak local absolute paths.

## 20. Resource and Scheduling Policy

The Bot Runtime MUST protect the storage client from overload.

Recommended defaults:

- Global bot concurrency: 2
- AI bot concurrency: 1
- Remote downloader concurrency: 1
- Default job timeout: 15 minutes for AI, 60 minutes for video download
- Per-job temp disk quota
- Graceful cancellation token for long-running plugins

Scheduling rules:

- Heavy media jobs SHOULD not run in parallel without explicit capacity.
- Plugins MAY define per-bot maxConcurrentJobs.
- Queue order SHOULD be FIFO within priority class.

## 21. Failure Handling

If a bot fails:

- The job MUST move to failed.
- The error SHOULD be normalized into a safe user-facing message.
- A bot-room-message MAY be appended with a concise failure reason.
- Temp files MUST be cleaned unless configured for debugging.

Error categories SHOULD include:

- validation-error
- permission-denied
- network-error
- downloader-error
- llm-error
- import-error
- timeout
- cancelled

## 22. Restart and Recovery

After storage-client restart:

- queued jobs MAY be resumed or marked expired by policy.
- running jobs from the previous process SHOULD be marked failed or interrupted unless the plugin explicitly supports resume.
- get-bot-job MUST still be able to return persisted job history.

## 23. Minimal Server Changes Required

The server SHOULD remain lightweight.

Required changes are limited to:

- Accept and rebroadcast bot-job-event from client-role sockets.
- Accept and rebroadcast bot-room-message from client-role sockets.
- Optionally expose bot metadata via API later, but this is not required for v1.

The server SHOULD NOT:

- Execute bot workloads.
- Download media on behalf of bots.
- Build AI context from full chat history.

## 24. Minimal Browser Changes Required

The browser SHOULD:

- Detect bot mentions when sending a chat message.
- Send invoke-bot over the existing control bridge to hostClientId.
- Subscribe to bot-job-event and bot-room-message through the current server message listener.
- Show lightweight job status in the chat UI.

The browser SHOULD NOT:

- Execute long-running bot work.
- Relay downloaded media for bot import.

## 25. Suggested v1 Scope

The first implementation SHOULD include only:

- Bot Runtime core
- Job store
- get-bot-catalog
- invoke-bot
- cancel-bot-job
- bot-job-event
- bot-room-message
- bilibili.downloader plugin
- ai.chat plugin without unrestricted tool execution

Deferred to later versions:

- Multiple simultaneous bot mentions in one message
- Full plugin hot reload
- User-installed third-party plugins
- Arbitrary code sandboxing
- Complex multi-agent orchestration

## 26. Schema Versioning

The Bot Runtime SHOULD carry an explicit schema version.

Example:

```json
{
  "schemaVersion": "bot-schema.v1"
}
```

Rules:

- Breaking protocol changes MUST bump the schema version.
- New optional fields MAY be added without a version bump if old clients can ignore them safely.

## 27. Final Decision Summary

The authoritative v1 decision is:

- Bot plugins live on the storage client.
- Bot invocation enters through the existing chat and control path.
- Bot jobs are explicit, persistent, cancellable units.
- Bot progress and bot replies are lightweight server-broadcast events.
- File-heavy outputs are written locally and imported directly into STORAGE_ROOT.
- AI bots are tool-driven only through explicit allowlists and permission gates.

Any future bot implementation SHOULD conform to this schema before code is added.