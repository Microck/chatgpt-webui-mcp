import crypto from "node:crypto";
import { readFileSync } from "node:fs";

export type ChatgptWebuiClientOptions = {
  baseUrl?: string;
  sessionToken?: string;
  transport?: "camofox" | "httpcloak";
};

export type AskInput = {
  prompt: string;
  model?: string;
  modelMode?: "auto" | "instant" | "thinking" | "pro";
  reasoningEffort?: "none" | "standard" | "extended";
  deepResearch?: boolean;
  deepResearchSiteMode?: "search_web" | "specific_sites";
  createImage?: boolean;
  waitTimeoutMs?: number;
  workspace?: string;
  conversationId?: string;
  parentMessageId?: string;
};

export type AskOutput = {
  text: string;
  conversationId: string | null;
  parentMessageId: string | null;
  model: string | null;
  imageUrls?: string[];
  imageDataUrl?: string;
  images?: Array<{
    assetPointer: string;
    estuaryUrl: string;
    mimeType?: string;
    bytes?: number;
    dataUrl?: string;
  }>;
};

type SessionPayload = {
  accessToken?: string;
  user?: {
    id?: string;
    name?: string;
    email?: string;
  };
  expires?: string;
};

type ConversationEvent = {
  conversation_id?: string;
  message?: {
    id?: string;
    author?: {
      role?: string;
    };
    metadata?: {
      model_slug?: string;
    };
    content?: {
      parts?: unknown[];
    };
  };
  error?: string;
};

const DEFAULT_BASE_URL = "https://chatgpt.com";
const DEFAULT_MODEL = "auto";
const CHAT_REQUIREMENTS_PATH = "/backend-api/sentinel/chat-requirements";
const DEFAULT_TRANSPORT = "camofox";
const DEFAULT_CAMOFOX_BASE_URL = "http://127.0.0.1:9377";
const DEFAULT_CAMOFOX_USER_ID = "chatgpt-webui-mcp";
const DEFAULT_CAMOFOX_SESSION_KEY = "chatgpt-webui";
const DEFAULT_CAMOFOX_WAIT_TIMEOUT_MS = 7200000;
const DEFAULT_CAMOFOX_WORKSPACE = "PRO";
const DEFAULT_IMAGE_SCREENSHOT_FALLBACK = false;
const DEFAULT_IMAGE_SCREENSHOT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_IMAGE_DOWNLOAD_MAX_BYTES = 15 * 1024 * 1024;

function readTokenFromFile(filePath: string): string {
  const path = filePath.trim();
  if (!path) {
    return "";
  }

  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function normalizeTransport(raw: string | undefined): "camofox" {
  const normalized = String(raw ?? DEFAULT_TRANSPORT).trim().toLowerCase();
  if (normalized === "httpcloak") {
    throw new Error("httpcloak_transport_not_supported_use_camofox");
  }

  return "camofox";
}

function safeJsonParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function summarizeErrorPayload(raw: string): string {
  const parsed = safeJsonParse<{ detail?: string; message?: string; error?: string }>(raw);
  const detail = parsed?.detail ?? parsed?.message ?? parsed?.error;
  if (detail && typeof detail === "string") {
    return detail;
  }

  const compact = raw.replace(/\s+/g, " ").trim();
  return compact.slice(0, 300);
}

function parseFirstJsonDocumentFromSnapshot(snapshot: string): unknown | null {
  const lines = snapshot.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    const normalized = trimmed.replace(/^[-]\s+/, "");
    if (!/^text:\s*/i.test(normalized) && !/^paragraph:\s*/i.test(normalized)) {
      continue;
    }

    const rawValue = normalized.replace(/^(text|paragraph):\s*/i, "").trim();
    if (!rawValue) {
      continue;
    }

    // JSON endpoints in ChatGPT can render either:
    // - a JSON document literal
    // - a JSON-encoded string that itself contains JSON (double-encoded)
    const direct = safeJsonParse<unknown>(rawValue);
    if (direct && typeof direct === "object") {
      return direct;
    }

    const decoded = safeJsonParse<string>(rawValue);
    if (decoded) {
      const doc = safeJsonParse<unknown>(decoded);
      if (doc && typeof doc === "object") {
        return doc;
      }
    }
  }

  // Fallback: scan the raw snapshot for JSON object candidates.
  const starts: number[] = [];
  for (let i = 0; i < snapshot.length; i += 1) {
    if (snapshot[i] === "{") {
      starts.push(i);
      if (starts.length >= 120) {
        break;
      }
    }
  }

  for (const start of starts) {
    for (let end = snapshot.length; end > start + 1; end -= 1) {
      if (snapshot[end - 1] !== "}") {
        continue;
      }

      const candidate = snapshot.slice(start, end).trim();
      if (!candidate) {
        continue;
      }

      const parsed = safeJsonParse<unknown>(candidate);
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    }
  }

  return null;
}

function parseSseEvents(raw: string): ConversationEvent[] {
  const events: ConversationEvent[] = [];
  const lines = raw.split(/\r?\n/);

  for (const line of lines) {
    if (!line.startsWith("data:")) {
      continue;
    }

    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") {
      continue;
    }

    const parsed = safeJsonParse<ConversationEvent>(payload);
    if (parsed) {
      events.push(parsed);
    }
  }

  return events;
}

function parseOptionalBoolean(raw: string | undefined): boolean | undefined {
  if (raw === undefined) {
    return undefined;
  }

  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return undefined;
}

function parsePositiveNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }

  const normalized = raw.trim();
  if (!normalized) {
    return undefined;
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

function parseNonNegativeInteger(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }

  const normalized = raw.trim();
  if (!normalized) {
    return undefined;
  }

  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return undefined;
  }

  return parsed;
}

type BackendResponse = {
  ok: boolean;
  statusCode: number;
  text: string;
  headers: Headers;
};

type BackendBinaryResponse = {
  ok: boolean;
  statusCode: number;
  bytes: number;
  mimeType: string;
  base64: string;
  headers: Headers;
};

type ConversationPayload = {
  mapping?: Record<
    string,
    {
      message?: {
        author?: { role?: string };
        content?: { parts?: unknown[] };
      };
    }
  >;
};

function parseAssetPointerToEstuaryId(assetPointer: string): string | null {
  const value = assetPointer.trim();
  if (!value) {
    return null;
  }

  const match = value.match(/\b(file[-_][a-zA-Z0-9_-]+)\b/);
  if (!match || !match[1]) {
    return null;
  }

  const raw = match[1];
  if (raw.startsWith("file_")) {
    return `file-${raw.slice("file_".length)}`;
  }

  return raw;
}

function extractImageAssetPointersFromConversation(payload: ConversationPayload): string[] {
  const pointers = new Set<string>();
  const mapping = payload.mapping;
  if (mapping && typeof mapping === "object") {
    for (const node of Object.values(mapping)) {
      const parts = node?.message?.content?.parts;
      if (!Array.isArray(parts)) {
        continue;
      }

      for (const part of parts) {
        if (!part || typeof part !== "object") {
          continue;
        }

        const record = part as Record<string, unknown>;
        const contentType = String(record.content_type ?? "").trim();
        const assetPointerRaw =
          typeof record.asset_pointer === "string"
            ? record.asset_pointer
            : typeof (record as { assetPointer?: unknown }).assetPointer === "string"
              ? String((record as { assetPointer?: unknown }).assetPointer)
              : "";
        const assetPointer = assetPointerRaw.trim();

        if (contentType === "image_asset_pointer" && assetPointer) {
          pointers.add(assetPointer);
          continue;
        }

        // Some payloads omit content_type but still include the pointer.
        if (assetPointer && /\bfile[-_][a-zA-Z0-9]+\b/.test(assetPointer)) {
          pointers.add(assetPointer);
        }
      }
    }
  }

  // Fallback: schema drift happens; crawl the whole payload defensively.
  const seen = new Set<unknown>();
  const stack: unknown[] = [payload];
  let inspected = 0;
  const maxInspect = 150000;

  while (stack.length > 0 && inspected < maxInspect) {
    const current = stack.pop();
    inspected += 1;

    if (!current) {
      continue;
    }

    if (typeof current === "object") {
      if (seen.has(current)) {
        continue;
      }
      seen.add(current);
    }

    if (Array.isArray(current)) {
      for (const item of current) {
        stack.push(item);
      }
      continue;
    }

    if (typeof current !== "object") {
      continue;
    }

    const record = current as Record<string, unknown>;
    const assetPointerRaw =
      typeof record.asset_pointer === "string"
        ? record.asset_pointer
        : typeof record.assetPointer === "string"
          ? record.assetPointer
          : "";
    const assetPointer = String(assetPointerRaw ?? "").trim();
    if (assetPointer && /\bfile[-_][a-zA-Z0-9]+\b/.test(assetPointer)) {
      pointers.add(assetPointer);
    }

    for (const value of Object.values(record)) {
      stack.push(value);
    }
  }

  return Array.from(pointers);
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSnapshotForRef(snapshot: string, role: string, label: RegExp): string | null {
  const lines = snapshot.split(/\r?\n/);
  for (const line of lines) {
    const pattern = new RegExp(`${role}\\s+(?:\"([^\"]+)\"\\s+)?\\[(e\\d+)\\]`, "i");
    const match = line.match(pattern);
    if (!match) {
      continue;
    }

    const name = match[1] ?? "";
    const ref = match[2] ?? "";
    if (label.test(name)) {
      return ref;
    }
  }

  return null;
}

/**
 * Normalize whitespace for fuzzy prompt comparison: collapse runs of
 * whitespace to a single space and trim.
 */
function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Returns true when `candidate` looks like the user's prompt text (or a
 * substantial substring of it).  Uses normalized whitespace comparison and
 * also checks for substring containment in both directions so that minor
 * formatting differences in the accessibility snapshot don't defeat the
 * filter.
 */
function looksLikePromptText(candidate: string, promptNormalized: string): boolean {
  if (!promptNormalized) {
    return false;
  }
  const cn = collapseWhitespace(candidate);
  const pn = collapseWhitespace(promptNormalized);
  if (!cn || !pn) {
    return false;
  }
  // Exact match after whitespace normalization
  if (cn === pn) {
    return true;
  }
  // Candidate is a significant substring of the prompt (≥60% of prompt length)
  if (pn.length >= 20 && cn.length >= pn.length * 0.6 && pn.includes(cn)) {
    return true;
  }
  // Prompt is a significant substring of the candidate (user prompt rendered
  // with minor additions like trailing punctuation)
  if (pn.length >= 20 && pn.length >= cn.length * 0.6 && cn.includes(pn)) {
    return true;
  }
  return false;
}

function extractLikelyAssistantTextFromSnapshot(snapshot: string, prompt: string): string {
  const rawLines = snapshot.split(/\r?\n/);
  const lines = rawLines
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-]\s+/, ""));

  // --- Primary path: look for "ChatGPT said:" heading sections ---
  const assistantChunks: string[] = [];
  let insideUserBlock = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";

    // Track "You said:" blocks so we can skip them
    if (/^heading\s+"You said:"/i.test(line)) {
      insideUserBlock = true;
      continue;
    }

    if (/^heading\s+"ChatGPT said:"/i.test(line)) {
      insideUserBlock = false;

      // Collect content blocks from the assistant response.  The response
      // can contain paragraphs with inline formatting, sub-headings, lists,
      // blockquotes, code blocks, and separators.  We join inline fragments
      // with spaces within a paragraph and join blocks with newlines.
      const blocks: string[] = [];
      let currentParagraphParts: string[] = [];

      const flushParagraph = () => {
        if (currentParagraphParts.length > 0) {
          const joined = currentParagraphParts
            .join(" ")
            .replace(/\s+([.,;:!?)\]}])/g, "$1");
          blocks.push(joined);
          currentParagraphParts = [];
        }
      };

      for (let j = i + 1; j < lines.length; j += 1) {
        const candidate = lines[j] ?? "";

        // --- Stop conditions ---
        // Stop at the next conversation turn or major UI boundary
        if (/^heading\s+"You said:"/i.test(candidate)) {
          break;
        }
        // Stop at article/main/banner boundaries (next message or page section)
        if (/^(article|complementary|dialog|main|banner):/i.test(candidate)) {
          break;
        }
        // Stop at action buttons that mark the end of a response
        // (Copy, Good response, Bad response, Share, Switch model, More actions)
        if (/^button\s+"(Copy|Good response|Bad response|Share|Switch model|More actions)"/i.test(candidate)) {
          break;
        }

        // --- Skip conditions ---
        // Skip the thinking model's "Thought for Xs" collapsed button
        if (/^button\s+"Thought for\b/i.test(candidate)) {
          continue;
        }
        // Skip other non-content buttons (e.g. "Sources", expand/collapse)
        if (/^button\s+"/i.test(candidate)) {
          continue;
        }

        // --- Sub-headings within the response (h2, h3, etc.) ---
        const headingMatch = candidate.match(/^heading\s+"([^"]+)"/i);
        if (headingMatch) {
          flushParagraph();
          const headingText = headingMatch[1]?.trim();
          if (headingText) {
            blocks.push(`\n## ${headingText}`);
          }
          continue;
        }

        // --- Paragraph start ---
        if (/^paragraph:/i.test(candidate)) {
          flushParagraph();
          const value = candidate.replace(/^paragraph:\s*/i, "").trim();
          if (value) {
            const unquoted =
              value.startsWith('"') && value.endsWith('"')
                ? value.slice(1, -1)
                : value;
            if (unquoted && !/^Ask anything$/i.test(unquoted)) {
              currentParagraphParts.push(unquoted);
            }
          }
          continue;
        }

        // --- Standalone code blocks ---
        if (/^code:\s*/i.test(candidate)) {
          flushParagraph();
          let value = candidate.replace(/^code:\s*/i, "").trim();
          if (value.startsWith('"') && value.endsWith('"')) {
            value = value.slice(1, -1);
          }
          if (value) {
            blocks.push("```\n" + value + "\n```");
          }
          continue;
        }

        // --- Blockquote start ---
        if (/^blockquote:/i.test(candidate)) {
          flushParagraph();
          // Blockquote children (paragraphs, etc.) will be captured
          // by subsequent iterations; we just flush here.
          continue;
        }

        // --- List / listitem (structural, children captured below) ---
        if (/^(list|listitem):/i.test(candidate)) {
          flushParagraph();
          continue;
        }

        // --- Separator ---
        if (/^separator\b/i.test(candidate)) {
          flushParagraph();
          blocks.push("---");
          continue;
        }

        // --- Inline text or formatting element ---
        const inlineMatch = candidate.match(
          /^(text|strong|emphasis|em|code|mark|del|ins|sub|sup|abbr|time|span|link):\s*/i,
        );
        if (inlineMatch) {
          let value = candidate.slice(inlineMatch[0].length).trim();
          if (value.startsWith('"') && value.endsWith('"')) {
            value = value.slice(1, -1);
          }
          if (value && !/^Ask anything$/i.test(value)) {
            currentParagraphParts.push(value);
          }
        }
      }

      flushParagraph();

      if (blocks.length > 0) {
        assistantChunks.push(blocks.join("\n"));
      }
    }
  }

  if (assistantChunks.length > 0) {
    return assistantChunks[assistantChunks.length - 1] ?? "";
  }

  // --- Fallback path: no "ChatGPT said:" heading found ---
  // This can happen during generation or if ChatGPT changes the heading text.
  // We collect paragraph/text lines, but aggressively filter out the user's
  // prompt and UI noise.

  const promptNormalized = prompt.trim();
  const noisePatterns = [
    /^By messaging ChatGPT/i,
    /^Terms$/i,
    /^Privacy Policy$/i,
    /^Ask anything$/i,
    /^What can I help with\?$/i,
    /^Attach$/i,
    /^Search$/i,
    /^Study$/i,
    /^Create image$/i,
    /^Voice$/i,
    /^Send prompt$/i,
    /^Send message$/i,
    /^Get a detailed report$/i,
    /^Detailed report$/i,
    /^Sources$/i,
    /^Log in$/i,
    /^Sign up for free$/i,
    /^ChatGPT can make mistakes\./i,
  ];

  // We also track "You said:" vs "ChatGPT said:" boundaries in the fallback
  // path.  Lines appearing inside a "You said:" section are excluded even
  // when there is no matching "ChatGPT said:" heading (e.g. mid-generation).
  let fallbackInsideUserBlock = false;
  const extractedBeforePrompt: string[] = [];
  const extractedAfterPrompt: string[] = [];
  let seenPromptText = false;

  for (const line of lines) {
    // Track user/assistant heading boundaries even in fallback
    if (/^heading\s+"You said:"/i.test(line)) {
      fallbackInsideUserBlock = true;
      continue;
    }
    if (/^heading\s+"ChatGPT said:"/i.test(line)) {
      fallbackInsideUserBlock = false;
      continue;
    }
    // Any other heading ends a user block (e.g. navigation headings)
    if (/^heading\s+"/i.test(line)) {
      fallbackInsideUserBlock = false;
    }

    // Skip content inside user blocks
    if (fallbackInsideUserBlock) {
      continue;
    }

    // Match paragraph, text, AND inline formatting elements
    const fallbackInlineMatch = line.match(
      /^(paragraph|text|strong|emphasis|em|code|mark|del|ins|sub|sup|abbr|time|span|link):\s*/i,
    );
    if (!fallbackInlineMatch) {
      continue;
    }

    let value = line.slice(fallbackInlineMatch[0].length).trim();

    if (value.startsWith("\"") && value.endsWith("\"")) {
      value = value.slice(1, -1);
    }

    const normalized = value.trim();
    if (!normalized) {
      continue;
    }

    // Fuzzy prompt filtering (replaces the old exact-match check)
    if (looksLikePromptText(normalized, promptNormalized)) {
      seenPromptText = true;
      continue;
    }

    if (noisePatterns.some((pattern) => pattern.test(normalized))) {
      continue;
    }

    if (seenPromptText) {
      extractedAfterPrompt.push(normalized);
    } else {
      extractedBeforePrompt.push(normalized);
    }
  }

  // Prefer text that appeared AFTER the prompt (more likely to be the
  // assistant response).  Fall back to pre-prompt text only if there is
  // nothing after.
  const preferred = extractedAfterPrompt.length > 0
    ? extractedAfterPrompt
    : extractedBeforePrompt;

  if (preferred.length === 0) {
    return "";
  }

  // Return the last substantial block rather than the longest (the longest
  // heuristic was prone to returning the prompt itself when it was the
  // longest text on the page).
  return preferred[preferred.length - 1] ?? "";
}

type CamofoxSnapshotResponse = {
  url?: string;
  snapshot?: string;
  refsCount?: number;
  truncated?: boolean;
  hasMore?: boolean;
  nextOffset?: number;
};

type CamofoxLinksResponse = {
  links?: Array<{
    url?: string;
    text?: string;
  }>;
};

type CamofoxStatsResponse = {
  visitedUrls?: unknown;
};

type CamofoxDownloadsResponse = {
  downloads?: Array<{
    id?: string;
    url?: string;
    suggestedFilename?: string;
    mimeType?: string;
    bytes?: number;
    dataBase64?: string;
    failure?: string;
  }>;
};

type CamofoxDomImagesResponse = {
  images?: Array<{
    src?: string;
    alt?: string;
    mimeType?: string;
    bytes?: number;
    dataUrl?: string;
  }>;
};

type CamofoxMenuItem = {
  ref: string;
  label: string;
};

function isLikelyModelOptionLabel(label: string): boolean {
  return (
    /\b(auto|instant|thinking|pro)\b/i.test(label) ||
    /\b(gpt|o\d)\b/i.test(label) ||
    /deep\s+research/i.test(label) ||
    /legacy\s+models/i.test(label) ||
    /alpha\s+models/i.test(label)
  );
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function inferMimeTypeFromName(value: string): string | null {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (normalized.endsWith(".png")) return "image/png";
  if (normalized.endsWith(".jpg") || normalized.endsWith(".jpeg")) return "image/jpeg";
  if (normalized.endsWith(".webp")) return "image/webp";
  if (normalized.endsWith(".gif")) return "image/gif";
  if (normalized.endsWith(".svg")) return "image/svg+xml";
  return null;
}

function snapshotIndicatesGenerationInProgress(snapshot: string): boolean {
  return /button\s+"(?:Stop|Cancel)\b/i.test(snapshot);
}

function visitedUrlsContainImageCandidate(urls: string[]): boolean {
  return urls.some((url) => {
    const normalized = url.trim();
    if (!normalized) {
      return false;
    }

    return (
      /\.(png|jpe?g|webp|gif)(?:[?#]|$)/i.test(normalized) ||
      /(oaiusercontent|openaiusercontent|oaidalle|blob\.core\.windows\.net)/i.test(normalized) ||
      /\/backend-api\/(files|asset)\//i.test(normalized) ||
      /\/backend-api\/estuary\/content\?/i.test(normalized)
    );
  });
}

function snapshotIndicatesReadyForNextPrompt(snapshot: string): boolean {
  return (
    /button\s+"(?:Send prompt|Send message)"/i.test(snapshot) ||
    /textbox\s+/i.test(snapshot) ||
    /#prompt-textarea/i.test(snapshot)
  );
}

function snapshotFatalUiError(snapshot: string): string | null {
  if (/\bSomething went wrong\b/i.test(snapshot)) {
    return "something_went_wrong";
  }

  if (/\bUnable to load conversation\b/i.test(snapshot)) {
    return "unable_to_load_conversation";
  }

  if (/\bYou have been logged out\b/i.test(snapshot)) {
    return "session_logged_out";
  }

  if (/\bSession expired\b/i.test(snapshot)) {
    return "session_expired";
  }

  return null;
}

function snapshotIndicatesLoginRequired(snapshot: string): boolean {
  return /button\s+"Log in"/i.test(snapshot) && /button\s+"Sign up for free"/i.test(snapshot);
}

function extractImageUrlsFromLinks(links: Array<{ url?: string; text?: string }>): string[] {
  const output: string[] = [];
  const seen = new Set<string>();

  for (const link of links) {
    const url = String(link.url ?? "").trim();
    if (!url || seen.has(url)) {
      continue;
    }

    const isLikelyImageUrl =
      /\.(png|jpe?g|webp|gif)(?:[?#]|$)/i.test(url) ||
      /(oaiusercontent|openaiusercontent|oaidalle|blob\.core\.windows\.net)/i.test(url) ||
      /\/backend-api\/(files|asset)\//i.test(url) ||
      /\/backend-api\/estuary\/content\?/i.test(url);

    if (!isLikelyImageUrl) {
      continue;
    }

    seen.add(url);
    output.push(url);
  }

  return output;
}

function extractVisitedUrlsFromStats(stats: CamofoxStatsResponse): string[] {
  const raw = (stats as { visitedUrls?: unknown }).visitedUrls;
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function extractUrlsFromSnapshot(snapshot: string): string[] {
  const output: string[] = [];
  const seen = new Set<string>();

  for (const line of snapshot.split(/\r?\n/)) {
    const match = line.match(/\b\/url:\s+"?([^"\s]+)"?/i);
    if (!match) {
      continue;
    }

    const url = String(match[1] ?? "").trim();
    if (!url || seen.has(url)) {
      continue;
    }

    seen.add(url);
    output.push(url);
  }

  return output;
}

function extractAssetPointerLikeTokens(text: string): string[] {
  const matches = text.match(/file[-_][a-zA-Z0-9_-]+/g) ?? [];
  const out = new Set<string>();
  for (const value of matches) {
    const token = String(value).trim();
    if (token) {
      out.add(token);
    }
  }

  return Array.from(out);
}

function extractAssetPointerLikeTokensFromUrls(urls: string[]): string[] {
  const out = new Set<string>();
  for (const raw of urls) {
    const value = String(raw ?? "").trim();
    if (!value) {
      continue;
    }

    for (const token of extractAssetPointerLikeTokens(value)) {
      out.add(token);
    }

    try {
      const parsed = new URL(value);
      for (const [, queryValue] of parsed.searchParams.entries()) {
        for (const token of extractAssetPointerLikeTokens(queryValue)) {
          out.add(token);
        }
      }
    } catch {
      // not a valid URL; ignore
    }
  }

  return Array.from(out);
}

function parseCamofoxMenuItems(snapshot: string): CamofoxMenuItem[] {
  const items: CamofoxMenuItem[] = [];
  const lines = snapshot.split(/\r?\n/);
  const seenRefs = new Set<string>();

  const pushItem = (label: string, ref: string): void => {
    const normalizedLabel = normalizeWhitespace(label);
    if (!normalizedLabel || !ref || seenRefs.has(ref) || !isLikelyModelOptionLabel(normalizedLabel)) {
      return;
    }

    seenRefs.add(ref);
    items.push({ ref, label: normalizedLabel });
  };

  for (const line of lines) {
    const menuMatch = line.match(/menuitem\s+"([^"]+)"\s+\[(e\d+)\]/i);
    if (menuMatch) {
      pushItem(menuMatch[1] ?? "", menuMatch[2] ?? "");
    }

    const buttonMatch = line.match(/button\s+"([^"]+)"\s+\[(e\d+)\]/i);
    if (buttonMatch) {
      pushItem(buttonMatch[1] ?? "", buttonMatch[2] ?? "");
    }
  }

  return items;
}

function modelSlugToLabelMatchers(modelSlug: string): RegExp[] {
  const slug = modelSlug.trim().toLowerCase();

  const known: Record<string, RegExp[]> = {
    "gpt-5-2": [/^Auto\b/i, /GPT-5\.2$/i],
    "gpt-5-2-instant": [/^Instant\b/i, /GPT-5\.2\s+Instant/i],
    "gpt-5-2-thinking": [/^Thinking\b/i, /GPT-5\.2\s+Thinking/i],
    "gpt-5-2-pro": [/^Pro\b/i, /GPT-5\.2\s+Pro/i],
    "gpt-5-1": [/GPT-5\.1$/i],
    "gpt-5-1-instant": [/GPT-5\.1\s+Instant/i],
    "gpt-5-1-thinking": [/GPT-5\.1\s+Thinking/i],
    "gpt-5-1-pro": [/GPT-5\.1\s+Pro/i],
    research: [/Deep\s+Research/i],
  };

  if (known[slug]) {
    return known[slug];
  }

  const tokenMatcher = slug
    .split("-")
    .filter(Boolean)
    .join(".*");

  if (!tokenMatcher) {
    return [];
  }

  return [new RegExp(tokenMatcher.replace(/\./g, "\\."), "i")];
}

function modelSlugToSubmenuMatchers(modelSlug: string): RegExp[] {
  const slug = modelSlug.trim().toLowerCase();

  if (!slug) {
    return [];
  }

  if (slug.startsWith("gpt-5-1")) {
    return [/Legacy models/i];
  }

  if (/alpha|preview|o\d|gpt-4\./i.test(slug)) {
    return [/Alpha models/i, /Legacy models/i];
  }

  return [/Legacy models/i, /Alpha models/i];
}

function modeToDefaultModelSlug(mode: AskInput["modelMode"]): string | null {
  switch (mode) {
    case "auto":
      return "gpt-5-2";
    case "instant":
      return "gpt-5-2-instant";
    case "thinking":
      return "gpt-5-2-thinking";
    case "pro":
      return "gpt-5-2-pro";
    default:
      return null;
  }
}

function parseConversationIdFromUrl(url: string | undefined): string | null {
  if (!url) {
    return null;
  }

  const match = url.match(/\/c\/([^/?#]+)/i);
  if (!match || !match[1]) {
    return null;
  }

  return match[1];
}

function extractAssistantText(event: ConversationEvent): string {
  if (event.message?.author?.role !== "assistant") {
    return "";
  }

  const parts = event.message?.content?.parts;
  if (!Array.isArray(parts) || parts.length === 0) {
    return "";
  }

  const values = parts
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      return "";
    })
    .filter(Boolean);

  return values.join("\n").trim();
}

export class ChatgptWebuiClient {
  readonly #baseUrl: string;
  readonly #sessionToken: string;
  readonly #deviceId: string;
  readonly #transport: "camofox";
  readonly #camofoxBaseUrl: string;
  readonly #camofoxUserId: string;
  readonly #camofoxSessionKey: string;
  readonly #camofoxApiKey: string;
  readonly #camofoxWaitTimeoutMs: number;
  readonly #camofoxWorkspace: string;
  readonly #imageScreenshotFallback: boolean;
  readonly #imageScreenshotMaxBytes: number;
  readonly #imageDownloadMaxBytes: number;
  #accessToken: string | null;
  #accessTokenFetchedAt: number;

  constructor(options: ChatgptWebuiClientOptions = {}) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl ?? process.env.CHATGPT_WEBUI_BASE_URL ?? DEFAULT_BASE_URL);

    const tokenFromEnv = String(
      options.sessionToken ?? process.env.CHATGPT_SESSION_TOKEN ?? process.env.OPENAI_SESSION_TOKEN ?? "",
    ).trim();
    const tokenFilePath = String(process.env.CHATGPT_SESSION_TOKEN_FILE ?? "").trim();
    const tokenFromFile = tokenFromEnv ? "" : readTokenFromFile(tokenFilePath);
    const sessionToken = tokenFromEnv || tokenFromFile;

    this.#sessionToken = sessionToken;
    this.#deviceId = crypto.randomUUID();
    this.#transport = normalizeTransport(options.transport ?? process.env.CHATGPT_TRANSPORT);
    this.#camofoxBaseUrl = normalizeBaseUrl(
      process.env.CHATGPT_BROWSER_BASE_URL ??
        process.env.CHATGPT_CAMOFOX_BASE_URL ??
        process.env.CAMOFOX_BASE_URL ??
        DEFAULT_CAMOFOX_BASE_URL,
    );
    this.#camofoxUserId = String(
      process.env.CHATGPT_USER_ID ?? process.env.CHATGPT_CAMOFOX_USER_ID ?? DEFAULT_CAMOFOX_USER_ID,
    ).trim();
    this.#camofoxSessionKey = String(
      process.env.CHATGPT_SESSION_KEY ?? process.env.CHATGPT_CAMOFOX_SESSION_KEY ?? DEFAULT_CAMOFOX_SESSION_KEY,
    ).trim();
    this.#camofoxApiKey = String(
      process.env.CHATGPT_CAMOFOX_API_KEY ?? process.env.CAMOFOX_API_KEY ?? "",
    ).trim();
    const waitTimeoutFromEnv = parsePositiveNumber(
      process.env.CHATGPT_WAIT_TIMEOUT_MS ?? process.env.CHATGPT_CAMOFOX_WAIT_TIMEOUT_MS,
    );
    this.#camofoxWaitTimeoutMs =
      waitTimeoutFromEnv !== undefined ? Math.floor(waitTimeoutFromEnv) : DEFAULT_CAMOFOX_WAIT_TIMEOUT_MS;
    this.#camofoxWorkspace = String(
      process.env.CHATGPT_WORKSPACE ?? process.env.CHATGPT_CAMOFOX_WORKSPACE ?? DEFAULT_CAMOFOX_WORKSPACE,
    ).trim();
    this.#imageScreenshotFallback =
      parseOptionalBoolean(process.env.CHATGPT_IMAGE_SCREENSHOT_FALLBACK) ?? DEFAULT_IMAGE_SCREENSHOT_FALLBACK;
    this.#imageScreenshotMaxBytes =
      parseNonNegativeInteger(process.env.CHATGPT_IMAGE_SCREENSHOT_MAX_BYTES) ?? DEFAULT_IMAGE_SCREENSHOT_MAX_BYTES;
    this.#imageDownloadMaxBytes =
      parseNonNegativeInteger(process.env.CHATGPT_IMAGE_DOWNLOAD_MAX_BYTES) ?? DEFAULT_IMAGE_DOWNLOAD_MAX_BYTES;

    if (!this.#sessionToken) {
      throw new Error(
        "CHATGPT_SESSION_TOKEN is required (cookie value of __Secure-next-auth.session-token) or set CHATGPT_SESSION_TOKEN_FILE",
      );
    }

    this.#accessToken = null;
    this.#accessTokenFetchedAt = 0;
  }

  close(): void {
    // no-op (kept for API compatibility)
  }

  #headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...extra,
    };
  }

  #backendBaseHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...this.#headers(),
      Origin: this.#baseUrl,
      Referer: `${this.#baseUrl}/`,
      "Oai-Device-Id": this.#deviceId,
      Cookie: `__Secure-next-auth.session-token=${this.#sessionToken}`,
      ...extra,
    };
  }

  #bearerBaseHeaders(extra: Record<string, string> = {}): Record<string, string> {
    // Prefer a pure bearer-auth path for backend API calls.
    // Sending the session cookie from Node can trip Cloudflare protections in some environments.
    return {
      ...this.#headers(),
      Origin: this.#baseUrl,
      Referer: `${this.#baseUrl}/`,
      "Oai-Device-Id": this.#deviceId,
      ...extra,
    };
  }

  async #backendFetch(url: string, init: RequestInit & { json?: unknown } = {}): Promise<BackendResponse> {
    const headers = new Headers(init.headers);

    // Ensure cookie + required headers always present.
    for (const [key, value] of Object.entries(this.#backendBaseHeaders())) {
      if (!headers.has(key)) {
        headers.set(key, value);
      }
    }

    let body = init.body;
    if ("json" in init) {
      body = JSON.stringify(init.json ?? {});
      if (!headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }
    }

    const response = await fetch(url, {
      ...init,
      headers,
      body,
    });

    const text = await response.text();
    return {
      ok: response.ok,
      statusCode: response.status,
      text,
      headers: response.headers,
    };
  }

  async #backendFetchBinary(url: string, init: RequestInit = {}): Promise<BackendBinaryResponse> {
    const headers = new Headers(init.headers);
    for (const [key, value] of Object.entries(this.#backendBaseHeaders())) {
      if (!headers.has(key)) {
        headers.set(key, value);
      }
    }

    const response = await fetch(url, {
      ...init,
      headers,
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    const mimeType = response.headers.get("content-type") ?? "application/octet-stream";
    return {
      ok: response.ok,
      statusCode: response.status,
      bytes: buffer.byteLength,
      mimeType,
      base64: buffer.toString("base64"),
      headers: response.headers,
    };
  }

  async #bearerFetch(url: string, init: RequestInit & { json?: unknown } = {}): Promise<BackendResponse> {
    const headers = new Headers(init.headers);

    for (const [key, value] of Object.entries(this.#bearerBaseHeaders())) {
      if (!headers.has(key)) {
        headers.set(key, value);
      }
    }

    let body = init.body;
    if ("json" in init) {
      body = JSON.stringify(init.json ?? {});
      if (!headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }
    }

    const response = await fetch(url, {
      ...init,
      headers,
      body,
    });

    const text = await response.text();
    return {
      ok: response.ok,
      statusCode: response.status,
      text,
      headers: response.headers,
    };
  }

  async #bearerFetchBinary(url: string, init: RequestInit = {}): Promise<BackendBinaryResponse> {
    const headers = new Headers(init.headers);
    for (const [key, value] of Object.entries(this.#bearerBaseHeaders())) {
      if (!headers.has(key)) {
        headers.set(key, value);
      }
    }

    const response = await fetch(url, {
      ...init,
      headers,
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    const mimeType = response.headers.get("content-type") ?? "application/octet-stream";
    return {
      ok: response.ok,
      statusCode: response.status,
      bytes: buffer.byteLength,
      mimeType,
      base64: buffer.toString("base64"),
      headers: response.headers,
    };
  }

  async #getAccessToken(): Promise<string> {
    // access tokens tend to rotate; refresh every 10 minutes to be safe.
    const cacheTtlMs = 10 * 60 * 1000;
    if (this.#accessToken && Date.now() - this.#accessTokenFetchedAt < cacheTtlMs) {
      return this.#accessToken;
    }

    const doc = await this.#camofoxFetchJsonDocument(`${this.#baseUrl}/api/auth/session`);
    const payload = (doc as SessionPayload) ?? {};
    if (!payload.accessToken) {
      throw new Error("failed_to_get_access_token_from_session_cookie: missing_access_token");
    }

    this.#accessToken = String(payload.accessToken);
    this.#accessTokenFetchedAt = Date.now();
    return this.#accessToken;
  }

  async #getConversationPayload(conversationId: string): Promise<ConversationPayload> {
    const accessToken = await this.#getAccessToken();
    const response = await this.#bearerFetch(`${this.#baseUrl}/backend-api/conversation/${conversationId}`, {
      headers: this.#bearerBaseHeaders({ Authorization: `Bearer ${accessToken}` }),
    });

    const raw = response.text;
    const payload = safeJsonParse<ConversationPayload>(raw);
    if (!response.ok || !payload) {
      throw new Error(`conversation_fetch_failed_${response.statusCode}: ${summarizeErrorPayload(raw)}`);
    }

    return payload;
  }

  async #buildImagesFromPointers(pointers: string[]): Promise<NonNullable<AskOutput["images"]>> {
    if (pointers.length === 0) {
      return [];
    }

    const images: NonNullable<AskOutput["images"]> = [];

    let accessToken: string | null = null;
    try {
      accessToken = await this.#getAccessToken();
    } catch {
      accessToken = null;
    }

    for (const assetPointer of pointers) {
      const estuaryId = parseAssetPointerToEstuaryId(assetPointer);
      if (!estuaryId) {
        continue;
      }

      const estuaryUrl = `${this.#baseUrl}/backend-api/estuary/content?id=${encodeURIComponent(estuaryId)}`;
      const record: NonNullable<AskOutput["images"]>[number] = { assetPointer, estuaryUrl };

      if (accessToken) {
        try {
          const response = await this.#bearerFetchBinary(estuaryUrl, {
            headers: this.#bearerBaseHeaders({ Authorization: `Bearer ${accessToken}` }),
          });

          if (response.ok) {
            record.bytes = response.bytes;
            record.mimeType = response.mimeType;
            if (response.bytes <= this.#imageDownloadMaxBytes) {
              record.dataUrl = `data:${response.mimeType};base64,${response.base64}`;
            }
          }
        } catch {
          // best-effort; keep pointer + url
        }
      }

      images.push(record);
    }

    return images;
  }

  async #downloadGeneratedImages(conversationId: string): Promise<NonNullable<AskOutput["images"]>> {
    const doc = await this.#camofoxFetchJsonDocument(`${this.#baseUrl}/backend-api/conversation/${conversationId}`);
    const payload = (doc as ConversationPayload) ?? {};
    const pointers = extractImageAssetPointersFromConversation(payload);
    return await this.#buildImagesFromPointers(pointers);
  }

  async #downloadGeneratedImagesFromTab(
    tabId: string,
    conversationId: string,
  ): Promise<NonNullable<AskOutput["images"]>> {
    const url = `${this.#baseUrl}/backend-api/conversation/${conversationId}`;
    const attempts = 3;
    const initialSnapshot = await this.#camofoxSnapshot(tabId).catch(() => ({} as CamofoxSnapshotResponse));
    const initialUrlRaw = String(initialSnapshot.url ?? "").trim();
    const fallbackConversationUrl = `${this.#baseUrl}/c/${conversationId}`;
    const restoreUrl =
      initialUrlRaw && !/\/backend-api\/conversation\//i.test(initialUrlRaw)
        ? initialUrlRaw
        : fallbackConversationUrl;

    try {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        await this.#camofoxNavigate(tabId, url);
        await this.#camofoxTryWait(tabId, 12000, attempt === 0);

        const snapshot = await this.#camofoxSnapshotTextAll(tabId);
        const doc = parseFirstJsonDocumentFromSnapshot(snapshot);
        if (doc && typeof doc === "object") {
          const payload = (doc as ConversationPayload) ?? {};
          const pointers = extractImageAssetPointersFromConversation(payload);
          return await this.#buildImagesFromPointers(pointers);
        }

        await sleep(1200);
      }

      throw new Error("camofox_conversation_json_not_found_from_existing_tab");
    } finally {
      try {
        const currentSnapshot = await this.#camofoxSnapshot(tabId);
        const currentUrl = String(currentSnapshot.url ?? "").trim();
        if (restoreUrl && currentUrl !== restoreUrl) {
          await this.#camofoxNavigate(tabId, restoreUrl);
          await this.#camofoxTryWait(tabId, 8000, false);
        }
      } catch {
        // best-effort restore; keep caller flow running
      }
    }
  }

  async #camofoxRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.#camofoxBaseUrl}${path}`, init);
    const raw = await response.text();
    const payload = safeJsonParse<T>(raw);

    if (!response.ok) {
      throw new Error(`camofox_request_failed_${response.status}: ${summarizeErrorPayload(raw)}`);
    }

    if (payload === null) {
      throw new Error(`camofox_invalid_json_response_for_${path}`);
    }

    return payload;
  }

  async #camofoxRequestBinary(path: string): Promise<{ mimeType: string; base64: string; bytes: number }> {
    const response = await fetch(`${this.#camofoxBaseUrl}${path}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!response.ok) {
      const raw = buffer.toString("utf8");
      throw new Error(`camofox_request_failed_${response.status}: ${summarizeErrorPayload(raw)}`);
    }

    return {
      mimeType: response.headers.get("content-type") ?? "image/png",
      base64: buffer.toString("base64"),
      bytes: buffer.byteLength,
    };
  }

  async #camofoxPost<T>(path: string, body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<T> {
    return await this.#camofoxRequest<T>(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  async #camofoxDelete(path: string, body: Record<string, unknown>): Promise<void> {
    await this.#camofoxRequest<Record<string, unknown>>(path, {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  async #camofoxRestartBrowser(): Promise<void> {
    try {
      await fetch(`${this.#camofoxBaseUrl}/start`, { method: "POST" });
    } catch {
      // best-effort
    }
  }

  async #camofoxCreateTab(): Promise<string> {
    const create = async () =>
      await this.#camofoxPost<{ tabId?: string }>("/tabs", {
        userId: this.#camofoxUserId,
        sessionKey: this.#camofoxSessionKey,
        // Keep initial navigation lightweight; we navigate to ChatGPT after importing cookies.
        url: "https://example.com/",
      });

    const maxAttempts = 4;
    let lastError: unknown = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const payload = await create();
        const tabId = String(payload.tabId ?? "").trim();
        if (!tabId) {
          throw new Error("camofox_create_tab_failed_missing_tab_id");
        }

        return tabId;
      } catch (error) {
        lastError = error;
        const message = toErrorMessage(error);
        const recoverable =
          /Page crashed|browser.*closed|Target page, context or browser has been closed|Failed to launch the browser process|browserType\.launch/i.test(
            message,
          );
        if (!recoverable || attempt === maxAttempts - 1) {
          throw error;
        }

        await this.#camofoxRestartBrowser();
        await sleep(1000 * (attempt + 1));
      }
    }

    throw (lastError instanceof Error ? lastError : new Error("camofox_create_tab_failed"));
  }

  async #camofoxDeleteTab(tabId: string): Promise<void> {
    try {
      await this.#camofoxDelete(`/tabs/${encodeURIComponent(tabId)}`, {
        userId: this.#camofoxUserId,
      });
    } catch {
      // best-effort cleanup
    }
  }

  async #camofoxImportSessionCookie(): Promise<void> {
    const expiry = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
    const expiryPast = 1;
    const headers: Record<string, string> = {};
    if (this.#camofoxApiKey) {
      headers.Authorization = `Bearer ${this.#camofoxApiKey}`;
    }

    try {
      await this.#camofoxPost(
        `/sessions/${encodeURIComponent(this.#camofoxUserId)}/cookies`,
        {
          cookies: [
            {
              name: "__Secure-next-auth.session-token",
              // Clear any stale cookie variants first.
              // Camofox/Playwright can hold both host-only and domain cookies. If both exist,
              // ChatGPT may receive multiple cookies with the same name and treat the session as invalid.
              value: "",
              domain: ".chatgpt.com",
              path: "/",
              expires: expiryPast,
              httpOnly: true,
              secure: true,
              sameSite: "None",
            },
            {
              name: "__Secure-next-auth.session-token",
              value: "",
              domain: "chatgpt.com",
              path: "/",
              expires: expiryPast,
              httpOnly: true,
              secure: true,
              sameSite: "None",
            },
            {
              name: "__Secure-next-auth.session-token",
              value: this.#sessionToken,
              domain: ".chatgpt.com",
              path: "/",
              expires: expiry,
              httpOnly: true,
              secure: true,
              sameSite: "None",
            },
            {
              name: "__Secure-next-auth.session-token",
              value: this.#sessionToken,
              domain: "chatgpt.com",
              path: "/",
              expires: expiry,
              httpOnly: true,
              secure: true,
              sameSite: "None",
            },
          ],
        },
        headers,
      );
    } catch (error) {
      const message = toErrorMessage(error);
      if (
        message.includes("camofox_request_failed_401") ||
        message.includes("camofox_request_failed_403")
      ) {
        if (!this.#camofoxApiKey) {
          return;
        }
      }

      throw error;
    }
  }

  async #camofoxFetchJsonDocument(url: string, waitTimeoutMs = 15000): Promise<unknown> {
    const attempts = 4;
    let lastError: unknown = null;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let tabId: string | null = null;
      try {
        tabId = await this.#camofoxCreateTab();
        await this.#camofoxImportSessionCookie();
        await this.#camofoxNavigate(tabId, url);
        await this.#camofoxTryWait(tabId, waitTimeoutMs, attempt === 0);

        const snapshot = await this.#camofoxSnapshotTextAll(tabId);
        const doc = parseFirstJsonDocumentFromSnapshot(snapshot);
        if (doc) {
          return doc;
        }

        if (/Just a moment|cf-mitigated|Cloudflare/i.test(snapshot)) {
          await this.#camofoxTryWait(tabId, 5000, false);
          const snapshotAfter = await this.#camofoxSnapshotTextAll(tabId);
          const afterDoc = parseFirstJsonDocumentFromSnapshot(snapshotAfter);
          if (afterDoc) {
            return afterDoc;
          }
        }

        lastError = new Error("camofox_json_document_not_found_in_snapshot");
      } catch (error) {
        lastError = error;
        const message = toErrorMessage(error);
        const recoverable =
          /Page crashed|browser.*closed|Target page, context or browser has been closed|Failed to launch the browser process|browserType\.launch/i.test(
            message,
          );

        if (recoverable) {
          await this.#camofoxRestartBrowser();
        }
      } finally {
        if (tabId) {
          await this.#camofoxDeleteTab(tabId);
        }
      }

      await sleep(1000 * (attempt + 1));
    }

    throw (lastError instanceof Error ? lastError : new Error("camofox_json_document_not_found_in_snapshot"));
  }

  async #camofoxNavigate(tabId: string, url: string): Promise<void> {
    await this.#camofoxPost(`/tabs/${encodeURIComponent(tabId)}/navigate`, {
      userId: this.#camofoxUserId,
      url,
    });
  }

  async #camofoxWait(tabId: string, timeoutMs = 5000, waitForNetwork = true): Promise<void> {
    await this.#camofoxPost(`/tabs/${encodeURIComponent(tabId)}/wait`, {
      userId: this.#camofoxUserId,
      timeout: timeoutMs,
      waitForNetwork,
    });
  }

  async #camofoxTryWait(tabId: string, timeoutMs = 5000, waitForNetwork = true): Promise<void> {
    try {
      await this.#camofoxWait(tabId, timeoutMs, waitForNetwork);
    } catch {
      // long-running generations can keep network activity alive for a long time
    }
  }

  async #camofoxSnapshot(tabId: string, offset?: number): Promise<CamofoxSnapshotResponse> {
    const query =
      typeof offset === "number" && Number.isFinite(offset) && offset >= 0
        ? `&offset=${encodeURIComponent(String(Math.floor(offset)))}`
        : "";

    return await this.#camofoxRequest<CamofoxSnapshotResponse>(
      `/tabs/${encodeURIComponent(tabId)}/snapshot?userId=${encodeURIComponent(this.#camofoxUserId)}${query}`,
      {
        method: "GET",
      },
    );
  }

  async #camofoxSnapshotText(tabId: string): Promise<string> {
    const snapshot = await this.#camofoxSnapshot(tabId);
    return String(snapshot.snapshot ?? "");
  }

  async #camofoxSnapshotTextAll(tabId: string, maxChunks = 8): Promise<string> {
    let offset = 0;
    const chunks: string[] = [];

    for (let i = 0; i < maxChunks; i += 1) {
      const response = await this.#camofoxSnapshot(tabId, offset);
      chunks.push(String(response.snapshot ?? ""));

      const hasMore = response.hasMore === true || response.truncated === true;
      const nextOffset = typeof response.nextOffset === "number" ? response.nextOffset : null;
      if (!hasMore || nextOffset === null || !Number.isFinite(nextOffset) || nextOffset <= offset) {
        break;
      }

      offset = nextOffset;
    }

    return chunks.join("\n");
  }

  async #camofoxGetLinks(tabId: string): Promise<Array<{ url?: string; text?: string }>> {
    const payload = await this.#camofoxRequest<CamofoxLinksResponse>(
      `/tabs/${encodeURIComponent(tabId)}/links?userId=${encodeURIComponent(this.#camofoxUserId)}`,
      {
        method: "GET",
      },
    );

    return Array.isArray(payload.links) ? payload.links : [];
  }

  async #camofoxGetVisitedUrls(tabId: string): Promise<string[]> {
    const payload = await this.#camofoxRequest<CamofoxStatsResponse>(
      `/tabs/${encodeURIComponent(tabId)}/stats?userId=${encodeURIComponent(this.#camofoxUserId)}`,
      {
        method: "GET",
      },
    );

    return extractVisitedUrlsFromStats(payload);
  }

  async #camofoxGetDownloads(
    tabId: string,
    options?: { includeData?: boolean; consume?: boolean; maxBytes?: number },
  ): Promise<NonNullable<CamofoxDownloadsResponse["downloads"]>> {
    const includeData = options?.includeData === true;
    const consume = options?.consume === true;
    const maxBytes =
      typeof options?.maxBytes === "number" && Number.isFinite(options.maxBytes) && options.maxBytes > 0
        ? Math.floor(options.maxBytes)
        : undefined;

    const queryParts = [
      `userId=${encodeURIComponent(this.#camofoxUserId)}`,
      `includeData=${includeData ? "true" : "false"}`,
      `consume=${consume ? "true" : "false"}`,
    ];
    if (typeof maxBytes === "number") {
      queryParts.push(`maxBytes=${encodeURIComponent(String(maxBytes))}`);
    }

    const payload = await this.#camofoxRequest<CamofoxDownloadsResponse>(
      `/tabs/${encodeURIComponent(tabId)}/downloads?${queryParts.join("&")}`,
      {
        method: "GET",
      },
    );

    return Array.isArray(payload.downloads) ? payload.downloads : [];
  }

  #mapCamofoxDownloadsToImages(
    downloads: NonNullable<CamofoxDownloadsResponse["downloads"]>,
  ): NonNullable<AskOutput["images"]> {
    return downloads
      .filter((entry) => !entry?.failure)
      .map((entry) => {
        const downloadUrl = String(entry.url ?? "").trim();
        const suggestedFilename = String(entry.suggestedFilename ?? "").trim();
        const mimeType =
          String(entry.mimeType ?? "").trim() ||
          inferMimeTypeFromName(suggestedFilename) ||
          inferMimeTypeFromName(downloadUrl) ||
          "application/octet-stream";
        const dataBase64 = String(entry.dataBase64 ?? "").trim();
        const syntheticUrl = `download://${encodeURIComponent(String(entry.id ?? crypto.randomUUID()))}/${encodeURIComponent(
          suggestedFilename || "image.bin",
        )}`;
        const estuaryUrl = downloadUrl || syntheticUrl;
        const assetPointer =
          extractAssetPointerLikeTokensFromUrls([estuaryUrl])[0] || suggestedFilename || estuaryUrl;

        return {
          assetPointer,
          estuaryUrl,
          mimeType,
          bytes: typeof entry.bytes === "number" ? entry.bytes : undefined,
          dataUrl: dataBase64 ? `data:${mimeType};base64,${dataBase64}` : undefined,
        };
      })
      .filter((entry) => Boolean(entry.estuaryUrl));
  }

  async #camofoxWaitForDownloadedImages(
    tabId: string,
    options?: {
      timeoutMs?: number;
      intervalMs?: number;
      consume?: boolean;
    },
  ): Promise<NonNullable<AskOutput["images"]>> {
    const timeoutMs =
      typeof options?.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? Math.floor(options.timeoutMs)
        : 10000;
    const intervalMs =
      typeof options?.intervalMs === "number" && Number.isFinite(options.intervalMs) && options.intervalMs > 0
        ? Math.floor(options.intervalMs)
        : 500;
    const shouldConsume = options?.consume === true;

    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      let downloads: NonNullable<CamofoxDownloadsResponse["downloads"]> = [];
      try {
        downloads = await this.#camofoxGetDownloads(tabId, {
          includeData: true,
          consume: false,
          maxBytes: this.#imageDownloadMaxBytes,
        });
      } catch {
        downloads = [];
      }

      const mapped = this.#mapCamofoxDownloadsToImages(downloads);
      if (mapped.length > 0) {
        if (shouldConsume) {
          try {
            await this.#camofoxGetDownloads(tabId, {
              includeData: false,
              consume: true,
              maxBytes: this.#imageDownloadMaxBytes,
            });
          } catch {
            // best-effort drain
          }
        }

        return mapped;
      }

      await sleep(intervalMs);
    }

    return [];
  }

  async #camofoxGetDomImages(
    tabId: string,
    options?: { includeData?: boolean; maxBytes?: number; limit?: number },
  ): Promise<NonNullable<CamofoxDomImagesResponse["images"]>> {
    const includeData = options?.includeData === true;
    const maxBytes =
      typeof options?.maxBytes === "number" && Number.isFinite(options.maxBytes) && options.maxBytes > 0
        ? Math.floor(options.maxBytes)
        : undefined;
    const limit =
      typeof options?.limit === "number" && Number.isFinite(options.limit) && options.limit > 0
        ? Math.floor(options.limit)
        : undefined;

    const queryParts = [
      `userId=${encodeURIComponent(this.#camofoxUserId)}`,
      `includeData=${includeData ? "true" : "false"}`,
    ];
    if (typeof maxBytes === "number") {
      queryParts.push(`maxBytes=${encodeURIComponent(String(maxBytes))}`);
    }
    if (typeof limit === "number") {
      queryParts.push(`limit=${encodeURIComponent(String(limit))}`);
    }

    const payload = await this.#camofoxRequest<CamofoxDomImagesResponse>(
      `/tabs/${encodeURIComponent(tabId)}/images?${queryParts.join("&")}`,
      {
        method: "GET",
      },
    );

    return Array.isArray(payload.images) ? payload.images : [];
  }

  async #camofoxScreenshotDataUrl(tabId: string, fullPage = false): Promise<{ dataUrl: string; bytes: number }> {
    const payload = await this.#camofoxRequestBinary(
      `/tabs/${encodeURIComponent(tabId)}/screenshot?userId=${encodeURIComponent(this.#camofoxUserId)}&fullPage=${String(
        fullPage,
      )}`,
    );

    return {
      dataUrl: `data:${payload.mimeType};base64,${payload.base64}`,
      bytes: payload.bytes,
    };
  }

  async #camofoxClick(tabId: string, input: { ref?: string; selector?: string }): Promise<void> {
    const ref = String(input.ref ?? "").trim();
    const selector = String(input.selector ?? "").trim();
    if (!ref && !selector) {
      throw new Error("camofox_click_missing_ref_or_selector");
    }

    await this.#camofoxPost(`/tabs/${encodeURIComponent(tabId)}/click`, {
      userId: this.#camofoxUserId,
      ...(ref ? { ref } : {}),
      ...(selector ? { selector } : {}),
    });
  }

  async #camofoxClickRef(tabId: string, ref: string): Promise<void> {
    await this.#camofoxClick(tabId, { ref });
  }

  async #camofoxClickSelector(tabId: string, selector: string): Promise<void> {
    await this.#camofoxClick(tabId, { selector });
  }

  async #camofoxFindAndClick(tabId: string, role: string, label: RegExp): Promise<boolean> {
    const snapshotText = await this.#camofoxSnapshotText(tabId);
    const ref = parseSnapshotForRef(snapshotText, role, label);
    if (!ref) {
      return false;
    }

    await this.#camofoxClickRef(tabId, ref);
    return true;
  }

  async #camofoxFindAndClickAnyRole(tabId: string, roles: string[], label: RegExp): Promise<boolean> {
    for (const role of roles) {
      const clicked = await this.#camofoxFindAndClick(tabId, role, label);
      if (clicked) {
        return true;
      }
    }

    return false;
  }

  async #camofoxResolveWorkspace(tabId: string, workspace: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const snapshotText = await this.#camofoxSnapshotText(tabId);
      if (!/heading\s+"Select a workspace/i.test(snapshotText)) {
        return;
      }

      const escapedWorkspace = escapeRegExp(workspace);
      const preferredRef = parseSnapshotForRef(snapshotText, "radio", new RegExp(`^${escapedWorkspace}$`, "i"));
      const fallbackRef = parseSnapshotForRef(snapshotText, "radio", /.+/i);
      const refToClick = preferredRef ?? fallbackRef;

      if (!refToClick) {
        throw new Error("camofox_workspace_selection_ref_not_found");
      }

      await this.#camofoxClickRef(tabId, refToClick);
      await this.#camofoxTryWait(tabId, 10000);
    }

    const finalSnapshot = await this.#camofoxSnapshotText(tabId);
    if (/heading\s+"Select a workspace/i.test(finalSnapshot)) {
      throw new Error("camofox_workspace_selection_not_resolved");
    }
  }

  async #camofoxDismissCookieDialogs(tabId: string): Promise<void> {
    const cookieButtonMatchers = [/Accept all/i, /Reject non-essential/i, /^Close$/i, /Manage Cookies/i];

    for (const matcher of cookieButtonMatchers) {
      try {
        const clicked = await this.#camofoxFindAndClick(tabId, "button", matcher);
        if (clicked) {
          await this.#camofoxWait(tabId, 2000);
          return;
        }
      } catch {
        // ignore and try next pattern
      }
    }
  }

  async #camofoxAssertAuthenticated(tabId: string): Promise<void> {
    const snapshotText = await this.#camofoxSnapshotText(tabId);
    if (snapshotIndicatesLoginRequired(snapshotText)) {
      throw new Error("camofox_login_required");
    }
  }

  async #camofoxOpenSidebar(tabId: string): Promise<void> {
    const snapshotText = await this.#camofoxSnapshotText(tabId);
    if (/button\s+"Close sidebar"/i.test(snapshotText)) {
      return;
    }

    const clicked = await this.#camofoxFindAndClick(tabId, "button", /Open sidebar/i);
    if (clicked) {
      await this.#camofoxWait(tabId, 3000);
    }
  }

  async #camofoxOpenModelMenu(tabId: string): Promise<string> {
    const snapshotText = await this.#camofoxSnapshotText(tabId);
    const modelRef =
      parseSnapshotForRef(snapshotText, "button", /Model selector/i) ??
      parseSnapshotForRef(snapshotText, "button", /^(Auto|Instant|Thinking|Pro)$/i) ??
      parseSnapshotForRef(snapshotText, "button", /GPT-5\.[12]/i);
    if (!modelRef) {
      throw new Error("camofox_model_selector_not_found");
    }

    await this.#camofoxClickRef(tabId, modelRef);
    await this.#camofoxTryWait(tabId, 4000);

    return await this.#camofoxSnapshotText(tabId);
  }

  async #camofoxSelectModel(tabId: string, modelSlug: string): Promise<void> {
    const matchers = modelSlugToLabelMatchers(modelSlug);
    const submenus = modelSlugToSubmenuMatchers(modelSlug);

    const findAndSelectFromSnapshot = async (snapshotText: string): Promise<boolean> => {
      const menuItems = parseCamofoxMenuItems(snapshotText);
      if (menuItems.length === 0) {
        return false;
      }

      const matched = menuItems.find((item) => matchers.some((matcher) => matcher.test(item.label)));
      if (!matched) {
        return false;
      }

      await this.#camofoxClickRef(tabId, matched.ref);
      await this.#camofoxTryWait(tabId, 8000);
      return true;
    };

    const initialSnapshotText = await this.#camofoxOpenModelMenu(tabId);
    if (await findAndSelectFromSnapshot(initialSnapshotText)) {
      return;
    }

    for (const submenuMatcher of submenus) {
      const opened = await this.#camofoxFindAndClickAnyRole(tabId, ["button", "menuitem"], submenuMatcher);
      if (!opened) {
        continue;
      }

      await this.#camofoxTryWait(tabId, 3500);
      const submenuSnapshot = await this.#camofoxSnapshotText(tabId);
      if (await findAndSelectFromSnapshot(submenuSnapshot)) {
        return;
      }
    }

    const fallbackSnapshot = await this.#camofoxSnapshotText(tabId);
    const available = parseCamofoxMenuItems(fallbackSnapshot)
      .map((item) => item.label)
      .join(", ");
    throw new Error(`camofox_model_not_found_for_slug_${modelSlug}; available: ${available || "none"}`);
  }

  async #camofoxEnableDeepResearch(tabId: string, siteMode?: AskInput["deepResearchSiteMode"]): Promise<void> {
    await this.#camofoxOpenSidebar(tabId);

    let clicked = await this.#camofoxFindAndClick(tabId, "link", /Deep research/i);
    if (!clicked) {
      clicked = await this.#camofoxFindAndClickAnyRole(tabId, ["button", "menuitem"], /^Deep research$/i);
    }

    if (!clicked) {
      throw new Error("camofox_deep_research_entry_not_found");
    }

    await this.#camofoxTryWait(tabId, 15000);

    if (!siteMode) {
      return;
    }

    const openSites = await this.#camofoxFindAndClick(tabId, "button", /^Sites,/i);
    if (!openSites) {
      throw new Error("camofox_deep_research_sites_button_not_found");
    }

    await this.#camofoxTryWait(tabId, 4000);

    const targetLabel = siteMode === "specific_sites" ? /Specific sites/i : /Search the web/i;
    const selected = await this.#camofoxFindAndClick(tabId, "menuitem", targetLabel);
    if (!selected) {
      throw new Error(`camofox_deep_research_sites_option_not_found_${siteMode}`);
    }

    await this.#camofoxTryWait(tabId, 3000);
  }

  async #camofoxEnableCreateImage(tabId: string): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const snapshotText = await this.#camofoxSnapshotText(tabId);

      // If the composer hasn't loaded yet, wait a bit and retry.
      if (!/Ask anything/i.test(snapshotText) && !/Add files/i.test(snapshotText)) {
        await this.#camofoxTryWait(tabId, 4000);
        continue;
      }

      if (parseSnapshotForRef(snapshotText, "button", /Create images?, click to remove/i)) {
        return;
      }

      if (parseSnapshotForRef(snapshotText, "button", /Create image, click to remove/i)) {
        return;
      }

      // Some UI layouts show a direct toggle, others put it under the composer "Add files and more" menu.
      let enabled = await this.#camofoxFindAndClickAnyRole(tabId, ["button", "menuitem", "menuitemradio"], /^Create images?$/i);
      if (!enabled) {
        enabled = await this.#camofoxFindAndClickAnyRole(tabId, ["button", "menuitem", "menuitemradio"], /^Create image$/i);
      }
      if (!enabled) {
        const openedMenu =
          (await this.#camofoxFindAndClick(tabId, "button", /Add files/i)) ||
          (await this.#camofoxFindAndClick(tabId, "button", /^Tools$/i)) ||
          (await this.#camofoxFindAndClick(tabId, "button", /^Attach$/i)) ||
          (await this.#camofoxFindAndClickAnyRole(tabId, ["button", "menuitem"], /Add files/i));

        if (openedMenu) {
          await this.#camofoxTryWait(tabId, 2500);

          // Menu tool options often render without stable snapshot refs (e.g. menuitemradio).
          // Use selector-based click as the most reliable path.
          try {
            await this.#camofoxClickSelector(tabId, 'role=menuitemradio[name="Create image"]');
            enabled = true;
          } catch {
            // fall back to ref-based matching
          }

          if (!enabled) {
            enabled =
              (await this.#camofoxFindAndClickAnyRole(tabId, ["menuitemradio", "menuitem", "button"], /^Create images?$/i)) ||
              (await this.#camofoxFindAndClickAnyRole(tabId, ["menuitemradio", "menuitem", "button"], /^Create image$/i)) ||
              (await this.#camofoxFindAndClickAnyRole(tabId, ["menuitemradio", "menuitem", "button"], /Create.*image/i));
          }
        }
      }

      if (enabled) {
        await this.#camofoxTryWait(tabId, 1500);
        return;
      }

      await this.#camofoxTryWait(tabId, 2000);
    }

    const fallbackSnapshot = await this.#camofoxSnapshotText(tabId);
    const available = parseCamofoxMenuItems(fallbackSnapshot)
      .map((item) => item.label)
      .join(", ");
    throw new Error(`camofox_create_image_control_not_found; available: ${available || "none"}`);
  }

  async #camofoxSetReasoningEffort(tabId: string, effort: AskInput["reasoningEffort"]): Promise<void> {
    if (!effort) {
      return;
    }

    const snapshotText = await this.#camofoxSnapshotText(tabId);
    const selectedExtendedRef = parseSnapshotForRef(snapshotText, "button", /Extended thinking, click to remove/i);
    const selectedThinkingRef = parseSnapshotForRef(snapshotText, "button", /Thinking, click to remove/i);

    if (effort === "none") {
      const selectedRef = selectedExtendedRef ?? selectedThinkingRef;
      if (selectedRef) {
        await this.#camofoxClickRef(tabId, selectedRef);
        await this.#camofoxWait(tabId, 3000);
      }
      return;
    }

    if (effort === "standard") {
      if (selectedExtendedRef) {
        await this.#camofoxClickRef(tabId, selectedExtendedRef);
        await this.#camofoxWait(tabId, 2500);
      }

      const snapshotAfterRemove = await this.#camofoxSnapshotText(tabId);
      if (parseSnapshotForRef(snapshotAfterRemove, "button", /Thinking, click to remove/i)) {
        return;
      }

      const enabledThinking = await this.#camofoxFindAndClick(tabId, "button", /^Thinking$/i);
      if (enabledThinking) {
        await this.#camofoxWait(tabId, 3000);
      }
      return;
    }

    if (effort === "extended") {
      if (selectedExtendedRef) {
        return;
      }

      if (selectedThinkingRef) {
        await this.#camofoxClickRef(tabId, selectedThinkingRef);
        await this.#camofoxWait(tabId, 2500);
      }

      const enabled = await this.#camofoxFindAndClick(tabId, "button", /^Extended thinking$/i);
      if (enabled) {
        await this.#camofoxWait(tabId, 3000);
        return;
      }

      const altEnabled = await this.#camofoxFindAndClickAnyRole(tabId, ["button", "menuitem"], /Extended/i);
      if (altEnabled) {
        await this.#camofoxTryWait(tabId, 3000);
      }
    }
  }

  async #camofoxType(tabId: string, selector: string, text: string): Promise<boolean> {
    try {
      await this.#camofoxPost(`/tabs/${encodeURIComponent(tabId)}/type`, {
        userId: this.#camofoxUserId,
        selector,
        text,
      });
      return true;
    } catch {
      return false;
    }
  }

  async #camofoxTypeWithFallback(tabId: string, prompt: string): Promise<void> {
    const selectors = [
      "#prompt-textarea",
      "textarea#prompt-textarea",
      "div#prompt-textarea",
      "textarea[name='prompt-textarea']",
      "role=textbox[name=\"Ask anything\"]",
      "role=textbox",
      "[contenteditable='true']",
      "textarea",
    ];

    for (const selector of selectors) {
      const ok = await this.#camofoxType(tabId, selector, prompt);
      if (ok) {
        return;
      }

      try {
        await this.#camofoxClickSelector(tabId, selector);
      } catch {
        // ignore focus fallback errors
      }

      const focused = await this.#camofoxType(tabId, selector, prompt);
      if (focused) {
        return;
      }
    }

    const snapshot = await this.#camofoxSnapshot(tabId);
    const snapshotText = String(snapshot.snapshot ?? "");
    const textboxRef = parseSnapshotForRef(snapshotText, "textbox", /.*/i);
    let effectiveTextboxRef = textboxRef;

    if (!effectiveTextboxRef) {
      const allSnapshot = await this.#camofoxSnapshotTextAll(tabId);
      effectiveTextboxRef = parseSnapshotForRef(allSnapshot, "textbox", /.*/i);
    }

    if (!effectiveTextboxRef) {
      throw new Error("camofox_prompt_input_not_found");
    }

    await this.#camofoxPost(`/tabs/${encodeURIComponent(tabId)}/type`, {
      userId: this.#camofoxUserId,
      ref: effectiveTextboxRef,
      text: prompt,
    });
  }

  async #camofoxSubmitPrompt(tabId: string): Promise<void> {
    try {
      await this.#camofoxPost(`/tabs/${encodeURIComponent(tabId)}/press`, {
        userId: this.#camofoxUserId,
        key: "Enter",
      });
    } catch {
      // keep going; click fallback below
    }

    await sleep(600);

    const snapshot = await this.#camofoxSnapshot(tabId);
    const snapshotText = String(snapshot.snapshot ?? "");
    if (snapshotIndicatesGenerationInProgress(snapshotText)) {
      return;
    }

    const sendRef =
      parseSnapshotForRef(snapshotText, "button", /send prompt/i) ??
      parseSnapshotForRef(snapshotText, "button", /send message/i) ??
      parseSnapshotForRef(snapshotText, "button", /get a detailed report/i) ??
      parseSnapshotForRef(snapshotText, "button", /detailed report/i);

    if (!sendRef) {
      try {
        await this.#camofoxClickSelector(tabId, 'role=button[name="Send prompt"]');
      } catch {
        try {
          await this.#camofoxClickSelector(tabId, 'role=button[name="Send message"]');
        } catch {
          return;
        }
      }

      return;
    }

    try {
      await this.#camofoxPost(`/tabs/${encodeURIComponent(tabId)}/click`, {
        userId: this.#camofoxUserId,
        ref: sendRef,
      });
      await this.#camofoxTryWait(tabId, 2000, false);
    } catch {
      // ignore click fallback failure
    }
  }

  async #camofoxClickContinueGeneratingIfPresent(tabId: string, snapshotText: string): Promise<boolean> {
    const continueRef = parseSnapshotForRef(snapshotText, "button", /Continue generating/i);
    if (!continueRef) {
      return false;
    }

    await this.#camofoxClickRef(tabId, continueRef);
    await this.#camofoxTryWait(tabId, 4000, false);
    return true;
  }

  async #camofoxPollAssistantText(
    tabId: string,
    prompt: string,
    timeoutMs: number,
    options: { allowEmptyResult?: boolean } = {},
  ): Promise<{ text: string; conversationId: string | null }> {
    const allowEmptyResult = options.allowEmptyResult === true;
    const startedAt = Date.now();
    let lastCandidate = "";
    let lastCandidateAt = 0;
    let lastConversationId: string | null = null;
    let idleTicks = 0;
    let seenGenerationIndicator = false;
    const minimumSettleMs = 6000;

    while (Date.now() - startedAt < timeoutMs) {
      await this.#camofoxTryWait(tabId, 5000, false);
      const snapshot = await this.#camofoxSnapshot(tabId);
      const snapshotText = String(snapshot.snapshot ?? "");
      const stillGenerating = snapshotIndicatesGenerationInProgress(snapshotText);
      if (stillGenerating) {
        seenGenerationIndicator = true;
      }

      if (await this.#camofoxClickContinueGeneratingIfPresent(tabId, snapshotText)) {
        idleTicks = 0;
        continue;
      }

      const fatalUiError = snapshotFatalUiError(snapshotText);
      if (fatalUiError && !lastCandidate) {
        throw new Error(`camofox_ui_error_${fatalUiError}`);
      }

      if (snapshotIndicatesLoginRequired(snapshotText) && !lastCandidate) {
        throw new Error("camofox_login_required");
      }

      const candidate = extractLikelyAssistantTextFromSnapshot(snapshotText, prompt);
      const conversationId = parseConversationIdFromUrl(snapshot.url);
      if (conversationId) {
        lastConversationId = conversationId;
      }

      const canTrustCandidate = seenGenerationIndicator || Boolean(lastConversationId);

      if (canTrustCandidate && candidate && candidate !== lastCandidate) {
        lastCandidate = candidate;
        lastCandidateAt = Date.now();
        idleTicks = 0;
      } else if (!stillGenerating) {
        idleTicks += 1;
      } else {
        idleTicks = 0;
      }

      if (
        lastCandidate &&
        !stillGenerating &&
        Date.now() - lastCandidateAt >= minimumSettleMs &&
        (snapshotIndicatesReadyForNextPrompt(snapshotText) || idleTicks >= 3)
      ) {
        return { text: lastCandidate, conversationId: lastConversationId };
      }

      if (
        allowEmptyResult &&
        canTrustCandidate &&
        !stillGenerating &&
        (snapshotIndicatesReadyForNextPrompt(snapshotText) || idleTicks >= 3)
      ) {
        return { text: "", conversationId: lastConversationId };
      }

      await sleep(1500);
    }

    if (lastCandidate) {
      return { text: lastCandidate, conversationId: lastConversationId };
    }

    if (allowEmptyResult && lastConversationId) {
      return { text: "", conversationId: lastConversationId };
    }

    throw new Error("camofox_assistant_response_timeout");
  }

  async #camofoxWaitForImageGenerationToSettle(
    tabId: string,
    timeoutMs: number,
  ): Promise<{ conversationId: string | null; sawImageCandidate: boolean }> {
    const startedAt = Date.now();
    let lastConversationId: string | null = null;
    let idleTicks = 0;
    let sawImageCandidate = false;
    const minimumSettleMs = 6000;

    while (Date.now() - startedAt < timeoutMs) {
      await this.#camofoxTryWait(tabId, 5000, false);
      const snapshot = await this.#camofoxSnapshot(tabId);
      const snapshotText = String(snapshot.snapshot ?? "");

      const conversationId = parseConversationIdFromUrl(snapshot.url);
      if (conversationId) {
        lastConversationId = conversationId;
      }

      let visitedUrls: string[] = [];
      try {
        visitedUrls = await this.#camofoxGetVisitedUrls(tabId);
      } catch {
        visitedUrls = [];
      }

      if (visitedUrlsContainImageCandidate(visitedUrls)) {
        sawImageCandidate = true;
      }

      const stillGenerating = snapshotIndicatesGenerationInProgress(snapshotText);

      if (stillGenerating) {
        idleTicks = 0;
      } else {
        idleTicks += 1;
      }

      if (
        sawImageCandidate &&
        !stillGenerating &&
        Date.now() - startedAt >= minimumSettleMs &&
        (snapshotIndicatesReadyForNextPrompt(snapshotText) || idleTicks >= 2)
      ) {
        return { conversationId: lastConversationId, sawImageCandidate };
      }

      if (
        !stillGenerating &&
        Date.now() - startedAt >= minimumSettleMs &&
        (snapshotIndicatesReadyForNextPrompt(snapshotText) || idleTicks >= 3)
      ) {
        return { conversationId: lastConversationId, sawImageCandidate };
      }

      await sleep(1500);
    }

    return { conversationId: lastConversationId, sawImageCandidate };
  }

  #conversationUrl(conversationId?: string): string {
    const id = String(conversationId ?? "").trim();
    if (!id) {
      return `${this.#baseUrl}/`;
    }

    return `${this.#baseUrl}/c/${encodeURIComponent(id)}`;
  }

  async #askViaCamofox(input: AskInput): Promise<AskOutput> {
    let tabId: string | null = null;
    const workspace = String(input.workspace ?? this.#camofoxWorkspace).trim() || this.#camofoxWorkspace;
    const effectiveTimeout =
      typeof input.waitTimeoutMs === "number" && input.waitTimeoutMs > 0
        ? Math.floor(input.waitTimeoutMs)
        : this.#camofoxWaitTimeoutMs;
    const explicitModel = input.model?.trim() || null;
    const modeModel = modeToDefaultModelSlug(input.modelMode);
    const effectiveModelSlug = explicitModel ?? modeModel;
    const wantsImageGeneration = input.createImage === true;
    const shouldUseDeepResearch =
      input.deepResearch === true ||
      input.deepResearchSiteMode !== undefined ||
      effectiveModelSlug === "research";

    if (wantsImageGeneration && shouldUseDeepResearch) {
      throw new Error("camofox_invalid_mode_combination_create_image_and_deep_research");
    }

    try {
      tabId = await this.#camofoxCreateTab();

      await this.#camofoxImportSessionCookie();
      await this.#camofoxNavigate(tabId, this.#conversationUrl(input.conversationId));
      try {
        await this.#camofoxWait(tabId, 20000, true);
      } catch {
        await this.#camofoxTryWait(tabId, 8000, true);
      }
      await this.#camofoxResolveWorkspace(tabId, workspace);
      await this.#camofoxDismissCookieDialogs(tabId);
      await this.#camofoxAssertAuthenticated(tabId);

      if (shouldUseDeepResearch) {
        await this.#camofoxEnableDeepResearch(tabId, input.deepResearchSiteMode);
      }

      if (wantsImageGeneration) {
        try {
          await this.#camofoxEnableCreateImage(tabId);
        } catch {
          // Best-effort: the UI toggle is not always discoverable; still submit the prompt.
        }
      }

      let modelSelected = false;
      if (effectiveModelSlug && effectiveModelSlug !== "research" && effectiveModelSlug !== "auto") {
        try {
          await this.#camofoxSelectModel(tabId, effectiveModelSlug);
          modelSelected = true;
        } catch {
          // Best-effort: UI controls can vary; prefer completing the run over hard-failing.
          modelSelected = false;
        }
      }

      if (input.reasoningEffort) {
        await this.#camofoxSetReasoningEffort(tabId, input.reasoningEffort);
      }

      await this.#camofoxTypeWithFallback(tabId, input.prompt);
      await this.#camofoxSubmitPrompt(tabId);

      let polledText = "";
      let polledConversationId: string | null = null;
      if (wantsImageGeneration) {
        const settled = await this.#camofoxWaitForImageGenerationToSettle(tabId, effectiveTimeout);
        polledConversationId = settled.conversationId;
      } else {
        const polled = await this.#camofoxPollAssistantText(tabId, input.prompt, effectiveTimeout);
        polledText = polled.text;
        polledConversationId = polled.conversationId;
      }
      let imageUrls: string[] | undefined;
      let imageDataUrl: string | undefined;
      let images: AskOutput["images"] | undefined;
      if (wantsImageGeneration) {
        await this.#camofoxTryWait(tabId, 8000, false);

        if (polledConversationId) {
          try {
            for (let attempt = 0; attempt < 8; attempt += 1) {
              let downloaded: NonNullable<AskOutput["images"]> = [];

              try {
                downloaded = await this.#downloadGeneratedImagesFromTab(tabId, polledConversationId);
              } catch {
                downloaded = await this.#downloadGeneratedImages(polledConversationId);
              }

              if (downloaded && downloaded.length > 0) {
                images = downloaded;
                imageUrls = downloaded.map((image) => image.estuaryUrl);
                imageDataUrl = downloaded[0]?.dataUrl;
                break;
              }

              await sleep(2500);
            }
          } catch {
            // fall back to best-effort link/screenshot extraction
          }
        }

        if (imageUrls && imageUrls.length > 0) {
          // we already have the real image artifact; skip heuristics.
        } else {
        const links = await this.#camofoxGetLinks(tabId);
        const visitedUrls = await this.#camofoxGetVisitedUrls(tabId);
        const postSnapshot = await this.#camofoxSnapshotText(tabId);
        const snapshotUrls = extractUrlsFromSnapshot(postSnapshot).map((url) => ({ url }));
        const visitedUrlLinks = visitedUrls.map((url) => ({ url }));
        imageUrls = extractImageUrlsFromLinks([...links, ...snapshotUrls, ...visitedUrlLinks]);

        if (!images || images.length === 0) {
          const pointerCandidates = new Set<string>([
            ...extractAssetPointerLikeTokens(postSnapshot),
            ...extractAssetPointerLikeTokensFromUrls(visitedUrls),
            ...extractAssetPointerLikeTokensFromUrls(
              [...links, ...snapshotUrls, ...visitedUrlLinks]
                .map((entry) => String(entry.url ?? "").trim())
                .filter(Boolean),
            ),
          ]);

          if (pointerCandidates.size > 0) {
            try {
              const downloadedFromPointers = await this.#buildImagesFromPointers(Array.from(pointerCandidates));
              if (downloadedFromPointers.length > 0) {
                images = downloadedFromPointers;
                imageUrls = downloadedFromPointers.map((image) => image.estuaryUrl);
                imageDataUrl = downloadedFromPointers[0]?.dataUrl;
              }
            } catch {
              // keep fallback-only urls if pointer downloads fail
            }
          }
        }

        if (imageUrls.length === 0) {
          try {
            const domImages = await this.#camofoxGetDomImages(tabId, {
              includeData: true,
              maxBytes: this.#imageDownloadMaxBytes,
              limit: 12,
            });

            const mappedDomImages = domImages
              .map((entry) => {
                const src = String(entry.src ?? "").trim();
                if (!src) {
                  return null;
                }

                const alt = String(entry.alt ?? "").trim();
                const mimeType =
                  String(entry.mimeType ?? "").trim() || inferMimeTypeFromName(src) || "application/octet-stream";
                const dataUrl = String(entry.dataUrl ?? "").trim() || undefined;
                const assetPointer =
                  extractAssetPointerLikeTokensFromUrls([src])[0] || alt || src;
                const score =
                  (/(generated image|download this image|created image)/i.test(alt) ? 5 : 0) +
                  (/(oaiusercontent|openaiusercontent|oaidalle|estuary|blob:|dalle)/i.test(src) ? 3 : 0) +
                  (dataUrl ? 2 : 0);

                return {
                  assetPointer,
                  estuaryUrl: src,
                  mimeType,
                  bytes: typeof entry.bytes === "number" ? entry.bytes : undefined,
                  dataUrl,
                  score,
                };
              })
              .filter((entry) => entry !== null)
              .map((entry) => entry as NonNullable<AskOutput["images"]>[number] & { score: number })
              .sort((left, right) => right.score - left.score);

            if (mappedDomImages.length > 0) {
              const preferredDomImages = mappedDomImages.filter((entry) => entry.score > 0);
              const selectedDomImages = (preferredDomImages.length > 0 ? preferredDomImages : mappedDomImages).map(
                ({ score, ...rest }) => rest,
              );
              images = selectedDomImages;
              imageUrls = selectedDomImages.map((entry) => entry.estuaryUrl);
              imageDataUrl = selectedDomImages.find((entry) => entry.dataUrl)?.dataUrl;
            }
          } catch {
            // ignore dom image extraction fallback failures
          }
        }

        if (imageUrls.length === 0) {
          try {
            const queuedDownloads = await this.#camofoxWaitForDownloadedImages(tabId, {
              timeoutMs: 2500,
              intervalMs: 350,
              consume: true,
            });
            if (queuedDownloads.length > 0) {
              images = queuedDownloads;
              imageUrls = queuedDownloads.map((entry) => entry.estuaryUrl);
              imageDataUrl = queuedDownloads.find((entry) => entry.dataUrl)?.dataUrl;
            }
          } catch {
            // ignore queued download check failures
          }
        }

        if (imageUrls.length === 0) {
          const downloadRef = parseSnapshotForRef(postSnapshot, "button", /Download(?: this image)?/i);
          if (downloadRef) {
            try {
              await this.#camofoxClickRef(tabId, downloadRef);
              await this.#camofoxTryWait(tabId, 2500, false);

              const imagesFromDownloads = await this.#camofoxWaitForDownloadedImages(tabId, {
                timeoutMs: 12000,
                intervalMs: 500,
                consume: true,
              });

              if (imagesFromDownloads.length > 0) {
                images = imagesFromDownloads;
                imageUrls = imagesFromDownloads.map((entry) => entry.estuaryUrl);
                imageDataUrl = imagesFromDownloads.find((entry) => entry.dataUrl)?.dataUrl;
              }

              if (imageUrls.length === 0) {
                const linksAfterClick = await this.#camofoxGetLinks(tabId);
                const visitedAfterClick = await this.#camofoxGetVisitedUrls(tabId);
                const snapshotAfterClick = await this.#camofoxSnapshotText(tabId);
                const snapshotAfterUrls = extractUrlsFromSnapshot(snapshotAfterClick).map((url) => ({ url }));
                const visitedAfterLinks = visitedAfterClick.map((url) => ({ url }));
                imageUrls = extractImageUrlsFromLinks([
                  ...linksAfterClick,
                  ...snapshotAfterUrls,
                  ...visitedAfterLinks,
                ]);

                if (!images || images.length === 0) {
                  const pointerCandidatesAfterClick = new Set<string>([
                    ...extractAssetPointerLikeTokens(snapshotAfterClick),
                    ...extractAssetPointerLikeTokensFromUrls(visitedAfterClick),
                    ...extractAssetPointerLikeTokensFromUrls(
                      [...linksAfterClick, ...snapshotAfterUrls, ...visitedAfterLinks]
                        .map((entry) => String(entry.url ?? "").trim())
                        .filter(Boolean),
                    ),
                  ]);

                  if (pointerCandidatesAfterClick.size > 0) {
                    try {
                      const downloadedFromPointers = await this.#buildImagesFromPointers(Array.from(pointerCandidatesAfterClick));
                      if (downloadedFromPointers.length > 0) {
                        images = downloadedFromPointers;
                        imageUrls = downloadedFromPointers.map((image) => image.estuaryUrl);
                        imageDataUrl = downloadedFromPointers[0]?.dataUrl;
                      }
                    } catch {
                      // ignore pointer fallback failures
                    }
                  }
                }
              }
            } catch {
              // ignore image click fallback
            }
          }
        }

        if (imageUrls.length === 0 && this.#imageScreenshotFallback) {
          try {
            const screenshot = await this.#camofoxScreenshotDataUrl(tabId, false);
            if (screenshot.bytes <= this.#imageScreenshotMaxBytes) {
              imageDataUrl = screenshot.dataUrl;
            }
          } catch {
            // best-effort fallback
          }
        }
        }
      }

      if ((!images || images.length === 0) && imageUrls && imageUrls.length > 0) {
        const synthesized = imageUrls
          .map((url) => {
            const token = extractAssetPointerLikeTokensFromUrls([url])[0] ?? "";
            const estuaryUrl = String(url).trim();
            if (!estuaryUrl) {
              return null;
            }

            return {
              assetPointer: token || estuaryUrl,
              estuaryUrl,
            };
          })
          .filter((entry): entry is NonNullable<AskOutput["images"]>[number] => entry !== null);

        if (synthesized.length > 0) {
          images = synthesized;
        }
      }

      return {
        text: wantsImageGeneration ? "" : polledText,
        conversationId: polledConversationId ?? input.conversationId ?? null,
        parentMessageId: null,
        model: modelSelected ? effectiveModelSlug : effectiveModelSlug === "auto" ? "auto" : null,
        imageUrls,
        imageDataUrl,
        images,
      };
    } finally {
      if (tabId) {
        await this.#camofoxDeleteTab(tabId);
      }
    }
  }

  async getSession(): Promise<SessionPayload> {
    const doc = await this.#camofoxFetchJsonDocument(`${this.#baseUrl}/api/auth/session`);
    const payload = (doc as SessionPayload) ?? {};
    if (!payload.accessToken) {
      throw new Error("failed_to_get_access_token_from_session_cookie: missing_access_token");
    }

    return payload;
  }

  async getModels(): Promise<unknown> {
    return await this.#camofoxFetchJsonDocument(`${this.#baseUrl}/backend-api/models`);
  }

  async #getChatRequirementsToken(accessToken: string): Promise<string | null> {
    try {
      const response = await this.#bearerFetch(`${this.#baseUrl}${CHAT_REQUIREMENTS_PATH}`, {
        headers: this.#bearerBaseHeaders({ Authorization: `Bearer ${accessToken}` }),
        json: {},
      });

      if (!response.ok) {
        return null;
      }

      const payload = safeJsonParse<{ token?: string }>(response.text) ?? {};

      return payload.token ?? null;
    } catch {
      return null;
    }
  }

  async ask(input: AskInput): Promise<AskOutput> {
    const prompt = input.prompt.trim();
    if (!prompt) {
      throw new Error("missing_prompt");
    }

    const deepResearchRequested =
      input.deepResearch === true || input.deepResearchSiteMode !== undefined || input.model?.trim() === "research";

    if (input.createImage && deepResearchRequested) {
      throw new Error("invalid_mode_combination_create_image_and_deep_research");
    }

    const requestedModel = deepResearchRequested
      ? "research"
      : input.model?.trim() || modeToDefaultModelSlug(input.modelMode) || modeToDefaultModelSlug("auto") || undefined;

    const normalizedInput: AskInput = {
      ...input,
      prompt,
      model: requestedModel,
    };

    const maxAttempts = 3;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        // httpcloak transport intentionally unsupported; camofox is the default and only path.
        return await this.#askViaCamofox(normalizedInput);
      } catch (error) {
        lastError = error;
        const message = toErrorMessage(error);
        const recoverable =
          /Page crashed|browser.*closed|Target page, context or browser has been closed|Failed to launch the browser process|browserType\.launch|camofox_request_failed_500/i.test(
            message,
          );

        if (!recoverable || attempt === maxAttempts - 1) {
          throw error;
        }

        await this.#camofoxRestartBrowser();
        await sleep(1000 * (attempt + 1));
      }
    }

    throw (lastError instanceof Error ? lastError : new Error("camofox_ask_failed"));
  }
}
