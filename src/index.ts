#!/usr/bin/env node

import crypto from "node:crypto";
import http from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { ChatgptWebuiClient } from "./chatgpt-webui-client.js";

const serverInfo = {
  name: "chatgpt-webui-mcp",
  version: "0.1.6",
} as const;

const askInputSchema = {
  prompt: z.string().describe("Prompt to send."),
  model: z
    .string()
    .optional()
    .describe(
      "Model slug override. Examples: gpt-5-2, gpt-5-2-pro, gpt-5-1-instant, research. Ignored when deep_research=true.",
    ),
  model_mode: z
    .enum(["auto", "instant", "thinking", "pro"])
    .optional()
    .describe("Quick model mode selector that maps to GPT-5.2 variants."),
  reasoning_effort: z
    .enum(["none", "standard", "extended"])
    .optional()
    .describe("UI reasoning control. Mainly relevant for thinking-capable models."),
  deep_research: z
    .boolean()
    .optional()
    .describe("Enable Deep Research flow. When true, model selection switches to research mode."),
  deep_research_site_mode: z
    .enum(["search_web", "specific_sites"])
    .optional()
    .describe("Optional Deep Research sites mode override."),
  create_image: z
    .boolean()
    .optional()
    .describe("Enable image-generation mode in ChatGPT UI."),
  wait_timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Max wait for response completion in milliseconds (supports long GPT-5.2 Pro runs)."),
  workspace: z
    .string()
    .optional()
    .describe("Preferred workspace label if ChatGPT shows workspace selection (e.g. PRO, Personal)."),
  conversation_id: z
    .string()
    .optional()
    .describe("Optional conversation id to continue an existing chat."),
  parent_message_id: z
    .string()
    .optional()
    .describe("Optional parent message id for continued conversation state."),
};

type AskToolInput = {
  prompt: string;
  model?: string;
  model_mode?: "auto" | "instant" | "thinking" | "pro";
  reasoning_effort?: "none" | "standard" | "extended";
  deep_research?: boolean;
  deep_research_site_mode?: "search_web" | "specific_sites";
  create_image?: boolean;
  wait_timeout_ms?: number;
  workspace?: string;
  conversation_id?: string;
  parent_message_id?: string;
};

type AskJobState = "queued" | "running" | "succeeded" | "failed";

type AskJob = {
  id: string;
  state: AskJobState;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  input: AskToolInput;
  result: Awaited<ReturnType<ChatgptWebuiClient["ask"]>> | null;
  error: string | null;
};

const askJobs = new Map<string, AskJob>();
const DEFAULT_ASK_ASYNC_JOB_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ASK_ASYNC_JOB_MAX = 150;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    return fallback;
  }

  return value;
}

const ASK_ASYNC_JOB_TTL_MS = parsePositiveInt(process.env.CHATGPT_ASYNC_JOB_TTL_MS, DEFAULT_ASK_ASYNC_JOB_TTL_MS);
const ASK_ASYNC_JOB_MAX = parsePositiveInt(process.env.CHATGPT_ASYNC_JOB_MAX, DEFAULT_ASK_ASYNC_JOB_MAX);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toAskClientInput(input: AskToolInput): Parameters<ChatgptWebuiClient["ask"]>[0] {
  return {
    prompt: input.prompt,
    model: input.model,
    modelMode: input.model_mode,
    reasoningEffort: input.reasoning_effort,
    deepResearch: input.deep_research,
    deepResearchSiteMode: input.deep_research_site_mode,
    createImage: input.create_image,
    waitTimeoutMs: input.wait_timeout_ms,
    workspace: input.workspace,
    conversationId: input.conversation_id,
    parentMessageId: input.parent_message_id,
  };
}

function formatAskResult(result: Awaited<ReturnType<ChatgptWebuiClient["ask"]>>) {
  return {
    text: result.text,
    conversation_id: result.conversationId,
    parent_message_id: result.parentMessageId,
    model: result.model,
    image_urls: result.imageUrls ?? [],
    image_data_url: result.imageDataUrl,
    images: result.images ?? [],
  };
}

function cleanupAskJobs(): void {
  const now = Date.now();

  for (const [jobId, job] of askJobs.entries()) {
    if (job.finishedAt && now - job.finishedAt > ASK_ASYNC_JOB_TTL_MS) {
      askJobs.delete(jobId);
    }
  }

  if (askJobs.size <= ASK_ASYNC_JOB_MAX) {
    return;
  }

  const evictable = Array.from(askJobs.values())
    .filter((job) => job.state === "succeeded" || job.state === "failed")
    .sort((a, b) => (a.finishedAt ?? a.createdAt) - (b.finishedAt ?? b.createdAt));

  while (askJobs.size > ASK_ASYNC_JOB_MAX && evictable.length > 0) {
    const next = evictable.shift();
    if (!next) {
      break;
    }

    askJobs.delete(next.id);
  }
}

async function runAskJob(jobId: string): Promise<void> {
  const job = askJobs.get(jobId);
  if (!job || job.state !== "queued") {
    return;
  }

  job.state = "running";
  job.startedAt = Date.now();

  try {
    const result = await withClient(async (client) => client.ask(toAskClientInput(job.input)));
    job.result = result;
    job.state = "succeeded";
  } catch (error) {
    job.error = error instanceof Error ? error.message : String(error);
    job.state = "failed";
  } finally {
    job.finishedAt = Date.now();
    cleanupAskJobs();
  }
}

function getAskJob(jobId: string): AskJob {
  const job = askJobs.get(jobId);
  if (!job) {
    throw new Error(`ask_job_not_found: ${jobId}`);
  }

  return job;
}

async function waitForAskJob(job: AskJob, waitTimeoutMs: number, pollIntervalMs: number): Promise<AskJob> {
  const startedAt = Date.now();
  while (job.state === "queued" || job.state === "running") {
    if (Date.now() - startedAt >= waitTimeoutMs) {
      return job;
    }

    await sleep(pollIntervalMs);
  }

  return job;
}

function shouldRunInBackground(input: AskToolInput): boolean {
  const model = String(input.model ?? "").toLowerCase();
  if (input.deep_research || input.deep_research_site_mode) {
    return true;
  }

  if (input.create_image) {
    return true;
  }

  if (input.model_mode === "pro" || input.model_mode === "thinking") {
    return true;
  }

  if (/\b(pro|thinking|research)\b/.test(model)) {
    return true;
  }

  return (input.wait_timeout_ms ?? 0) > 300000;
}

function createAskJob(input: AskToolInput): AskJob {
  cleanupAskJobs();

  const jobId = crypto.randomUUID();
  const job: AskJob = {
    id: jobId,
    state: "queued",
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    input,
    result: null,
    error: null,
  };

  askJobs.set(jobId, job);
  void runAskJob(jobId);
  return job;
}

function normalizeCommand(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function parseModeFromCommand(command: string): "auto" | "wait" | "background" | null {
  const lower = command.toLowerCase();
  if (/\b(background|async|in\s+the\s+background|dont\s+wait)\b/i.test(lower)) {
    return "background";
  }
  if (/\b(wait|blocking|sync|synchronously)\b/i.test(lower)) {
    return "wait";
  }
  return null;
}

function parseAskInputFromCommand(commandRaw: string): {
  ask: AskToolInput;
  modeHint: "auto" | "wait" | "background" | null;
} {
  const command = normalizeCommand(commandRaw);
  const lower = command.toLowerCase();

  const deepResearch = /\bdeep\s*research\b|\bdeepresearch\b/i.test(lower);
  const deepResearchSiteMode: AskToolInput["deep_research_site_mode"] = /\bspecific\s+sites\b/i.test(lower)
    ? "specific_sites"
    : /\bsearch\s+the\s+web\b|\bsearch\s+web\b/i.test(lower)
      ? "search_web"
      : undefined;

  const createImage = /\b(create|generate|make)\s+(an?\s+)?images?\b|\bimage\s+generation\b/i.test(lower);

  const reasoningEffort: AskToolInput["reasoning_effort"] =
    /\bno\s+thinking\b|\bdisable\s+thinking\b/i.test(lower)
      ? "none"
      : /\bextended\s+(thinking|reasoning)\b|\bext\s+thinking\b/i.test(lower)
        ? "extended"
        : /\bstandard\s+thinking\b|\bnormal\s+thinking\b/i.test(lower)
          ? "standard"
          : undefined;

  const hasPro = /\bpro\b/i.test(lower);
  const hasInstant = /\binstant\b/i.test(lower);
  const hasThinking = /\bthinking\b/i.test(lower);
  const hasAuto = /\bauto\b/i.test(lower);

  let model: string | undefined;
  let modelMode: AskToolInput["model_mode"] | undefined;

  if (/\b5\.1\b/i.test(lower)) {
    if (hasPro) model = "gpt-5-1-pro";
    else if (hasInstant) model = "gpt-5-1-instant";
    else if (hasThinking) model = "gpt-5-1-thinking";
    else model = "gpt-5-1";
  } else if (/\b5\.2\b/i.test(lower) || /\bgpt\s*-?5\.2\b/i.test(lower)) {
    if (hasPro) modelMode = "pro";
    else if (hasInstant) modelMode = "instant";
    else if (hasThinking) modelMode = "thinking";
    else if (hasAuto) modelMode = "auto";
  } else {
    if (hasPro) modelMode = "pro";
    else if (hasInstant) modelMode = "instant";
    else if (hasThinking) modelMode = "thinking";
    else if (hasAuto) modelMode = "auto";
  }

  // prompt extraction
  let prompt = command;
  const colonIndex = command.indexOf(":");
  if (colonIndex >= 0 && colonIndex < command.length - 1) {
    prompt = command.slice(colonIndex + 1).trim();
  } else {
    const onMatch = command.match(/\b(?:on|about)\b\s+(.+)$/i);
    if (onMatch?.[1]) {
      prompt = onMatch[1].trim();
    }
  }

  // trim common prefixes if user didn't use ':'
  prompt = prompt
    .replace(/^with\s+chatgpt\s+webui\b/i, "")
    .replace(/^chatgpt\s+webui\b/i, "")
    .replace(/^do\s+deep\s*research\b/i, "")
    .replace(/^deep\s*research\b/i, "")
    .trim();

  const modeHint = parseModeFromCommand(command);

  return {
    ask: {
      prompt,
      model,
      model_mode: modelMode,
      reasoning_effort: reasoningEffort,
      deep_research: deepResearch || undefined,
      deep_research_site_mode: deepResearchSiteMode,
      create_image: createImage || undefined,
    },
    modeHint,
  };
}

function createClient(): ChatgptWebuiClient {
  return new ChatgptWebuiClient();
}

async function withClient<T>(run: (client: ChatgptWebuiClient) => Promise<T>): Promise<T> {
  const client = createClient();
  try {
    return await run(client);
  } finally {
    client.close();
  }
}

function registerTools(server: McpServer): void {
  const makeTextContent = (text: string) => [{ type: "text" as const, text }];

  const promptHandler = async (
    input: AskToolInput & {
      mode?: "auto" | "wait" | "background";
      wait_for_ms?: number;
      poll_interval_ms?: number;
    },
  ) => {
    const { mode = "auto", wait_for_ms, poll_interval_ms, ...askInput } = input;
    const resolvedMode = mode === "auto" ? (shouldRunInBackground(askInput) ? "background" : "wait") : mode;

    if (resolvedMode === "wait") {
      const result = await withClient(async (client) => client.ask(toAskClientInput(askInput)));
      const formatted = formatAskResult(result);
      return {
        content: makeTextContent(formatted.text),
        structuredContent: {
          mode: resolvedMode,
          state: "succeeded",
          ...formatted,
        },
      };
    }

    const job = createAskJob(askInput);
    const pollIntervalMs = poll_interval_ms ?? 2000;

    if (wait_for_ms && wait_for_ms > 0) {
      const settled = await waitForAskJob(job, wait_for_ms, pollIntervalMs);
      if (settled.state === "succeeded" && settled.result) {
        const formatted = formatAskResult(settled.result);
        return {
          content: makeTextContent(formatted.text),
          structuredContent: {
            mode: resolvedMode,
            run_id: settled.id,
            state: settled.state,
            ...formatted,
          },
        };
      }

      if (settled.state === "failed") {
        return {
          isError: true,
          content: makeTextContent(settled.error ?? "ask_job_failed"),
          structuredContent: {
            mode: resolvedMode,
            run_id: settled.id,
            state: settled.state,
            error: settled.error,
          },
        };
      }
    }

    return {
      content: makeTextContent(JSON.stringify({ run_id: job.id, state: job.state }, null, 2)),
      structuredContent: {
        mode: resolvedMode,
        run_id: job.id,
        state: job.state,
        created_at: job.createdAt,
      },
    };
  };

  server.registerTool(
    "chatgpt_webui_session",
    {
      description: "Validate ChatGPT session token and return session details.",
      inputSchema: {},
    },
    async () => {
      const session = await withClient(async (client) => client.getSession());
      return {
        content: [{ type: "text", text: JSON.stringify(session, null, 2) }],
        structuredContent: session,
      };
    },
  );

  server.registerTool(
    "chatgpt_webui_models",
    {
      description: "List available ChatGPT WebUI models for the current account.",
      inputSchema: {},
    },
    async () => {
      const models = await withClient(async (client) => client.getModels());
      return {
        content: [{ type: "text", text: JSON.stringify(models, null, 2) }],
        structuredContent: { models },
      };
    },
  );

  server.registerTool(
    "chatgpt_webui_ask",
    {
      description:
        "Send a prompt to ChatGPT WebUI using session token auth and return assistant text.",
      inputSchema: askInputSchema,
    },
    async (input: AskToolInput) => {
      const result = await withClient(async (client) => client.ask(toAskClientInput(input)));
      const formatted = formatAskResult(result);
      return {
        content: [{ type: "text", text: formatted.text }],
        structuredContent: formatted,
      };
    },
  );

  server.registerTool(
    "chatgpt_webui_ask_async_start",
    {
      description:
        "Start a background ChatGPT ask job and return immediately with a job id. Use this for long-running tasks like Deep Research and Pro runs.",
      inputSchema: askInputSchema,
    },
    async (input: AskToolInput) => {
      const job = createAskJob(input);
      return {
        content: [{ type: "text", text: JSON.stringify({ job_id: job.id, state: job.state }, null, 2) }],
        structuredContent: {
          job_id: job.id,
          state: job.state,
          created_at: job.createdAt,
        },
      };
    },
  );

  server.registerTool(
    "chatgpt_webui_ask_async_status",
    {
      description: "Get status for a background ask job.",
      inputSchema: {
        job_id: z.string().describe("Job id returned by chatgpt_webui_ask_async_start."),
      },
    },
    async ({ job_id }) => {
      const job = getAskJob(job_id);
      const payload = {
        job_id: job.id,
        state: job.state,
        created_at: job.createdAt,
        started_at: job.startedAt,
        finished_at: job.finishedAt,
        error: job.error,
        result_preview: job.result?.text ? job.result.text.slice(0, 500) : null,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      };
    },
  );

  server.registerTool(
    "chatgpt_webui_ask_async_result",
    {
      description:
        "Get result for a background ask job. Optionally wait for completion by providing wait_timeout_ms.",
      inputSchema: {
        job_id: z.string().describe("Job id returned by chatgpt_webui_ask_async_start."),
        wait_timeout_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Optional max wait for completion before returning current state."),
        poll_interval_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Polling interval while waiting. Default: 2000ms."),
      },
    },
    async ({ job_id, wait_timeout_ms, poll_interval_ms }) => {
      const pollIntervalMs = poll_interval_ms ?? 2000;
      let job = getAskJob(job_id);

      if (wait_timeout_ms) {
        job = await waitForAskJob(job, wait_timeout_ms, pollIntervalMs);
      }

      if (job.state === "failed") {
        const payload = {
          job_id: job.id,
          state: job.state,
          error: job.error,
        };

        return {
          isError: true,
          content: [{ type: "text", text: job.error ?? "ask_job_failed" }],
          structuredContent: payload,
        };
      }

      if (job.state !== "succeeded" || !job.result) {
        const payload = {
          job_id: job.id,
          state: job.state,
          created_at: job.createdAt,
          started_at: job.startedAt,
          finished_at: job.finishedAt,
        };

        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
        };
      }

      const formatted = formatAskResult(job.result);
      return {
        content: [{ type: "text", text: formatted.text }],
        structuredContent: {
          job_id: job.id,
          state: job.state,
          ...formatted,
        },
      };
    },
  );

  server.registerTool(
    "chatgpt_webui_prompt",
    {
      description:
        "Unified prompt entrypoint. mode=auto uses background runs for long tasks (Deep Research, Pro/Thinking, image generation) and direct wait for short tasks.",
      inputSchema: {
        ...askInputSchema,
        mode: z
          .enum(["auto", "wait", "background"])
          .optional()
          .describe("Execution mode. auto chooses best mode. wait blocks for result. background returns run_id."),
        wait_for_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Optional extra wait window for background mode before returning running state."),
        poll_interval_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Polling interval when wait_for_ms is set. Default 2000ms."),
      },
    },
    async (input: AskToolInput & { mode?: "auto" | "wait" | "background"; wait_for_ms?: number; poll_interval_ms?: number }) => {
      return await promptHandler(input);
    },
  );

  server.registerTool(
    "chatgpt_webui_run",
    {
      description:
        "Unified run checker. Use run_id from chatgpt_webui_prompt background mode (or job_id from legacy async tools).",
      inputSchema: {
        run_id: z.string().optional().describe("Run id from chatgpt_webui_prompt."),
        job_id: z.string().optional().describe("Legacy alias for run_id."),
        wait_timeout_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Optional max wait for completion before returning running state."),
        poll_interval_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Polling interval while waiting. Default: 2000ms."),
      },
    },
    async ({ run_id, job_id, wait_timeout_ms, poll_interval_ms }) => {
      const resolvedRunId = String(run_id ?? job_id ?? "").trim();
      if (!resolvedRunId) {
        return {
          isError: true,
          content: [{ type: "text", text: "missing_run_id" }],
        };
      }

      const pollIntervalMs = poll_interval_ms ?? 2000;
      let job: AskJob;
      try {
        job = getAskJob(resolvedRunId);
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        };
      }

      if (wait_timeout_ms) {
        job = await waitForAskJob(job, wait_timeout_ms, pollIntervalMs);
      }

      if (job.state === "failed") {
        return {
          isError: true,
          content: [{ type: "text", text: job.error ?? "ask_job_failed" }],
          structuredContent: {
            run_id: job.id,
            state: job.state,
            error: job.error,
          },
        };
      }

      if (job.state !== "succeeded" || !job.result) {
        return {
          content: [{ type: "text", text: JSON.stringify({ run_id: job.id, state: job.state }, null, 2) }],
          structuredContent: {
            run_id: job.id,
            state: job.state,
            created_at: job.createdAt,
            started_at: job.startedAt,
            finished_at: job.finishedAt,
          },
        };
      }

      const formatted = formatAskResult(job.result);
      return {
        content: [{ type: "text", text: formatted.text }],
        structuredContent: {
          run_id: job.id,
          state: job.state,
          ...formatted,
        },
      };
    },
  );

  server.registerTool(
    "chatgpt_webui_command",
    {
      description:
        "Natural-language command wrapper. Converts phrases like 'with chatgpt webui on gpt 5.2 pro extended thinking: ...' into a chatgpt_webui_prompt call.",
      inputSchema: {
        command: z.string().describe("Natural language command string."),
        mode: z
          .enum(["auto", "wait", "background"])
          .optional()
          .describe("Optional override. If omitted, inferred from command and defaults."),
        wait_for_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Optional wait window for background mode before returning running state."),
        poll_interval_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Polling interval when wait_for_ms is set. Default 2000ms."),
      },
    },
    async ({ command, mode, wait_for_ms, poll_interval_ms }) => {
      const parsed = parseAskInputFromCommand(command);
      const modeFromText = parsed.modeHint;
      const resolvedMode: "auto" | "wait" | "background" = mode ?? modeFromText ?? "auto";

      return await promptHandler({
        ...parsed.ask,
        mode: resolvedMode,
        wait_for_ms,
        poll_interval_ms,
      });
    },
  );
}

function createMcpServer(): McpServer {
  const server = new McpServer(serverInfo);
  registerTools(server);
  return server;
}

async function main(): Promise<void> {
  const transportType = String(process.env.MCP_TRANSPORT ?? "stdio").trim().toLowerCase();

  if (transportType === "sse") {
    const host = String(process.env.MCP_SSE_HOST ?? "127.0.0.1").trim();
    const port = Number(process.env.MCP_SSE_PORT ?? 8791);

    const transportsBySessionId = new Map<string, SSEServerTransport>();
    const serversBySessionId = new Map<string, McpServer>();

    const httpServer = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", `http://${host}:${port}`);

        if (req.method === "GET" && url.pathname === "/sse") {
          const transport = new SSEServerTransport("/messages", res);
          const sessionId = transport.sessionId;
          const server = createMcpServer();

          let closed = false;
          const closeSession = async (): Promise<void> => {
            if (closed) {
              return;
            }

            closed = true;
            transportsBySessionId.delete(sessionId);
            serversBySessionId.delete(sessionId);
            transport.onclose = undefined;
            transport.onerror = undefined;
            try {
              await server.close();
            } catch {
              // ignore close errors
            }
          };

          transport.onclose = () => {
            void closeSession();
          };

          transport.onerror = () => {
            void closeSession();
          };

          transportsBySessionId.set(sessionId, transport);
          serversBySessionId.set(sessionId, server);

          await server.connect(transport);
          return;
        }

        if (req.method === "POST" && url.pathname === "/messages") {
          const sessionId = String(url.searchParams.get("sessionId") ?? "").trim();
          const transport = sessionId ? transportsBySessionId.get(sessionId) ?? null : null;

          if (!transport) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "sse_session_not_initialized", sessionId }));
            return;
          }

          await transport.handlePostMessage(req, res);
          return;
        }

        if (req.method === "GET" && url.pathname === "/health") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, transport: "sse" }));
          return;
        }

        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
      } catch (error) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(error) }));
      }
    });

    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(port, host, () => resolve());
    });

    console.error(`chatgpt-webui-mcp server running on sse http://${host}:${port}/sse`);
    return;
  }

  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("chatgpt-webui-mcp server running on stdio");
}

main().catch((error) => {
  console.error("chatgpt-webui-mcp fatal:", error);
  process.exit(1);
});
