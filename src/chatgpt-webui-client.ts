import crypto from "node:crypto";

import {
  Session,
  type RequestOptions,
  type Response as HttpcloakResponse,
  type SessionOptions,
} from "httpcloak";

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
const DEFAULT_HTTPCLOAK_PRESET = "chrome-145";
const DEFAULT_TRANSPORT = "camofox";
const DEFAULT_CAMOFOX_BASE_URL = "http://127.0.0.1:9377";
const DEFAULT_CAMOFOX_USER_ID = "chatgpt-webui-mcp";
const DEFAULT_CAMOFOX_SESSION_KEY = "chatgpt-webui";
const DEFAULT_CAMOFOX_WAIT_TIMEOUT_MS = 5400000;
const DEFAULT_CAMOFOX_WORKSPACE = "PRO";

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function normalizeTransport(raw: string | undefined): "camofox" | "httpcloak" {
  const normalized = String(raw ?? DEFAULT_TRANSPORT).trim().toLowerCase();
  if (normalized === "httpcloak") {
    return "httpcloak";
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

function buildHttpcloakSessionOptionsFromEnv(): SessionOptions {
  const preset = String(process.env.CHATGPT_HTTPCLOAK_PRESET ?? DEFAULT_HTTPCLOAK_PRESET).trim();
  const sessionOptions: SessionOptions = {
    preset: preset || DEFAULT_HTTPCLOAK_PRESET,
  };

  const httpVersion = String(process.env.CHATGPT_HTTPCLOAK_HTTP_VERSION ?? "").trim();
  if (httpVersion) {
    sessionOptions.httpVersion = httpVersion;
  }

  const proxy = String(process.env.CHATGPT_HTTPCLOAK_PROXY ?? "").trim();
  if (proxy) {
    sessionOptions.proxy = proxy;
  }

  const tcpProxy = String(process.env.CHATGPT_HTTPCLOAK_TCP_PROXY ?? "").trim();
  if (tcpProxy) {
    sessionOptions.tcpProxy = tcpProxy;
  }

  const udpProxy = String(process.env.CHATGPT_HTTPCLOAK_UDP_PROXY ?? "").trim();
  if (udpProxy) {
    sessionOptions.udpProxy = udpProxy;
  }

  const echConfigDomain = String(process.env.CHATGPT_HTTPCLOAK_ECH_CONFIG_DOMAIN ?? "").trim();
  if (echConfigDomain) {
    sessionOptions.echConfigDomain = echConfigDomain;
  }

  const timeoutSeconds = parsePositiveNumber(process.env.CHATGPT_HTTPCLOAK_TIMEOUT_SECONDS);
  if (timeoutSeconds !== undefined) {
    sessionOptions.timeout = timeoutSeconds;
  }

  const quicIdleTimeout = parsePositiveNumber(process.env.CHATGPT_HTTPCLOAK_QUIC_IDLE_TIMEOUT_SECONDS);
  if (quicIdleTimeout !== undefined) {
    sessionOptions.quicIdleTimeout = quicIdleTimeout;
  }

  const tlsOnly = parseOptionalBoolean(process.env.CHATGPT_HTTPCLOAK_TLS_ONLY);
  if (tlsOnly !== undefined) {
    sessionOptions.tlsOnly = tlsOnly;
  }

  const verifyTls = parseOptionalBoolean(process.env.CHATGPT_HTTPCLOAK_VERIFY_TLS);
  if (verifyTls !== undefined) {
    sessionOptions.verify = verifyTls;
  }

  const allowRedirects = parseOptionalBoolean(process.env.CHATGPT_HTTPCLOAK_ALLOW_REDIRECTS);
  if (allowRedirects !== undefined) {
    sessionOptions.allowRedirects = allowRedirects;
  }

  const preferIpv4 = parseOptionalBoolean(process.env.CHATGPT_HTTPCLOAK_PREFER_IPV4);
  if (preferIpv4 !== undefined) {
    sessionOptions.preferIpv4 = preferIpv4;
  }

  const retry = parseNonNegativeInteger(process.env.CHATGPT_HTTPCLOAK_RETRY);
  if (retry !== undefined) {
    sessionOptions.retry = retry;
  }

  const maxRedirects = parseNonNegativeInteger(process.env.CHATGPT_HTTPCLOAK_MAX_REDIRECTS);
  if (maxRedirects !== undefined) {
    sessionOptions.maxRedirects = maxRedirects;
  }

  return sessionOptions;
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

function extractLikelyAssistantTextFromSnapshot(snapshot: string, prompt: string): string {
  const rawLines = snapshot.split(/\r?\n/);
  const lines = rawLines
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-]\s+/, ""));

  const assistantChunks: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!/^heading\s+"ChatGPT said:"/i.test(line)) {
      continue;
    }

    const chunkLines: string[] = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const candidate = lines[j] ?? "";
      if (
        /^heading\s+"/i.test(candidate) ||
        /^button\s+"/i.test(candidate) ||
        /^(article|complementary|dialog|main|banner):/i.test(candidate)
      ) {
        break;
      }

      if (/^(paragraph|text):\s*/i.test(candidate)) {
        let value = candidate.replace(/^(paragraph|text):\s*/i, "").trim();
        if (value.startsWith('"') && value.endsWith('"')) {
          value = value.slice(1, -1);
        }
        if (value && !/^Ask anything$/i.test(value)) {
          chunkLines.push(value);
        }
      }
    }

    if (chunkLines.length > 0) {
      assistantChunks.push(chunkLines.join("\n"));
    }
  }

  if (assistantChunks.length > 0) {
    return assistantChunks[assistantChunks.length - 1] ?? "";
  }

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

  const extracted: string[] = [];

  for (const line of lines) {
    if (!/^paragraph:\s*/i.test(line) && !/^text:\s*/i.test(line)) {
      continue;
    }

    let value = line;

    value = value.replace(/^text:\s*/i, "");
    value = value.replace(/^paragraph:\s*/i, "");

    if (value.startsWith("\"") && value.endsWith("\"")) {
      value = value.slice(1, -1);
    }

    const normalized = value.trim();
    if (!normalized) {
      continue;
    }

    if (promptNormalized && normalized === promptNormalized) {
      continue;
    }

    if (noisePatterns.some((pattern) => pattern.test(normalized))) {
      continue;
    }

    extracted.push(normalized);
  }

  if (extracted.length === 0) {
    return "";
  }

  extracted.sort((a, b) => b.length - a.length);
  return extracted[0] ?? "";
}

type CamofoxSnapshotResponse = {
  url?: string;
  snapshot?: string;
  refsCount?: number;
};

type CamofoxLinksResponse = {
  links?: Array<{
    url?: string;
    text?: string;
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

function snapshotIndicatesGenerationInProgress(snapshot: string): boolean {
  return (
    /button\s+"(?:Stop|Cancel)\b/i.test(snapshot) ||
    /\b(Researching|Gathering sources|Working on your report|Thinking|Analyzing|Generating)\b/i.test(snapshot)
  );
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
      /(oaiusercontent|openaiusercontent|oaidalle|blob\.core\.windows\.net)/i.test(url);

    if (!isLikelyImageUrl) {
      continue;
    }

    seen.add(url);
    output.push(url);
  }

  return output;
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
  readonly #transport: "camofox" | "httpcloak";
  #httpSession: Session | null;
  readonly #camofoxBaseUrl: string;
  readonly #camofoxUserId: string;
  readonly #camofoxSessionKey: string;
  readonly #camofoxApiKey: string;
  readonly #camofoxWaitTimeoutMs: number;
  readonly #camofoxWorkspace: string;

  constructor(options: ChatgptWebuiClientOptions = {}) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl ?? process.env.CHATGPT_WEBUI_BASE_URL ?? DEFAULT_BASE_URL);
    this.#sessionToken = String(
      options.sessionToken ?? process.env.CHATGPT_SESSION_TOKEN ?? process.env.OPENAI_SESSION_TOKEN ?? "",
    ).trim();
    this.#deviceId = crypto.randomUUID();
    this.#transport = normalizeTransport(options.transport ?? process.env.CHATGPT_TRANSPORT);
    this.#camofoxBaseUrl = normalizeBaseUrl(
      process.env.CHATGPT_CAMOFOX_BASE_URL ?? process.env.CAMOFOX_BASE_URL ?? DEFAULT_CAMOFOX_BASE_URL,
    );
    this.#camofoxUserId = String(
      process.env.CHATGPT_CAMOFOX_USER_ID ?? DEFAULT_CAMOFOX_USER_ID,
    ).trim();
    this.#camofoxSessionKey = String(
      process.env.CHATGPT_CAMOFOX_SESSION_KEY ?? DEFAULT_CAMOFOX_SESSION_KEY,
    ).trim();
    this.#camofoxApiKey = String(
      process.env.CHATGPT_CAMOFOX_API_KEY ?? process.env.CAMOFOX_API_KEY ?? "",
    ).trim();
    const waitTimeoutFromEnv = parsePositiveNumber(process.env.CHATGPT_CAMOFOX_WAIT_TIMEOUT_MS);
    this.#camofoxWaitTimeoutMs =
      waitTimeoutFromEnv !== undefined ? Math.floor(waitTimeoutFromEnv) : DEFAULT_CAMOFOX_WAIT_TIMEOUT_MS;
    this.#camofoxWorkspace = String(
      process.env.CHATGPT_CAMOFOX_WORKSPACE ?? DEFAULT_CAMOFOX_WORKSPACE,
    ).trim();

    if (!this.#sessionToken) {
      throw new Error(
        "CHATGPT_SESSION_TOKEN is required (cookie value of __Secure-next-auth.session-token)",
      );
    }

    this.#httpSession = null;
  }

  close(): void {
    if (this.#httpSession) {
      this.#httpSession.close();
      this.#httpSession = null;
    }
  }

  #getHttpSession(): Session {
    if (!this.#httpSession) {
      const session = new Session(buildHttpcloakSessionOptionsFromEnv());
      session.headers.Origin = this.#baseUrl;
      session.headers.Referer = `${this.#baseUrl}/`;
      session.headers["Oai-Device-Id"] = this.#deviceId;
      session.setCookie("__Secure-next-auth.session-token", this.#sessionToken);
      this.#httpSession = session;
    }

    return this.#httpSession;
  }

  #headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...extra,
    };
  }

  #requestOptions(extra: RequestOptions = {}): RequestOptions {
    return {
      ...extra,
      cookies: {
        "__Secure-next-auth.session-token": this.#sessionToken,
        ...(extra.cookies ?? {}),
      },
      headers: extra.headers ? { ...extra.headers } : undefined,
    };
  }

  async #get(url: string, options: RequestOptions = {}): Promise<HttpcloakResponse> {
    try {
      return await this.#getHttpSession().get(url, this.#requestOptions(options));
    } catch (error) {
      throw new Error(`httpcloak_get_failed: ${toErrorMessage(error)}`);
    }
  }

  async #post(url: string, options: RequestOptions = {}): Promise<HttpcloakResponse> {
    try {
      return await this.#getHttpSession().post(url, this.#requestOptions(options));
    } catch (error) {
      throw new Error(`httpcloak_post_failed: ${toErrorMessage(error)}`);
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

  async #camofoxCreateTab(): Promise<string> {
    const payload = await this.#camofoxPost<{ tabId?: string }>("/tabs", {
      userId: this.#camofoxUserId,
      sessionKey: this.#camofoxSessionKey,
      url: `${this.#baseUrl}/`,
    });

    const tabId = String(payload.tabId ?? "").trim();
    if (!tabId) {
      throw new Error("camofox_create_tab_failed_missing_tab_id");
    }

    return tabId;
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
              value: this.#sessionToken,
              domain: ".chatgpt.com",
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

  async #camofoxSnapshot(tabId: string): Promise<CamofoxSnapshotResponse> {
    return await this.#camofoxRequest<CamofoxSnapshotResponse>(
      `/tabs/${encodeURIComponent(tabId)}/snapshot?userId=${encodeURIComponent(this.#camofoxUserId)}`,
      {
        method: "GET",
      },
    );
  }

  async #camofoxSnapshotText(tabId: string): Promise<string> {
    const snapshot = await this.#camofoxSnapshot(tabId);
    return String(snapshot.snapshot ?? "");
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

  async #camofoxClickRef(tabId: string, ref: string): Promise<void> {
    await this.#camofoxPost(`/tabs/${encodeURIComponent(tabId)}/click`, {
      userId: this.#camofoxUserId,
      ref,
    });
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
    const snapshotText = await this.#camofoxSnapshotText(tabId);
    if (parseSnapshotForRef(snapshotText, "button", /Create images?, click to remove/i)) {
      return;
    }

    const enabled = await this.#camofoxFindAndClickAnyRole(tabId, ["button", "menuitem"], /^Create images?$/i);
    if (!enabled) {
      throw new Error("camofox_create_image_control_not_found");
    }

    await this.#camofoxTryWait(tabId, 3000);
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
    const selectors = ["#prompt-textarea", "div#prompt-textarea", "textarea[name='prompt-textarea']", "textarea"];

    for (const selector of selectors) {
      const ok = await this.#camofoxType(tabId, selector, prompt);
      if (ok) {
        return;
      }
    }

    const snapshot = await this.#camofoxSnapshot(tabId);
    const snapshotText = String(snapshot.snapshot ?? "");
    const textboxRef = parseSnapshotForRef(snapshotText, "textbox", /.*/i);
    if (!textboxRef) {
      throw new Error("camofox_prompt_input_not_found");
    }

    await this.#camofoxPost(`/tabs/${encodeURIComponent(tabId)}/type`, {
      userId: this.#camofoxUserId,
      ref: textboxRef,
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
      await this.#camofoxTryWait(tabId, 8000);
      await this.#camofoxResolveWorkspace(tabId, workspace);
      await this.#camofoxDismissCookieDialogs(tabId);
      await this.#camofoxAssertAuthenticated(tabId);

      if (shouldUseDeepResearch) {
        await this.#camofoxEnableDeepResearch(tabId, input.deepResearchSiteMode);
      }

      if (wantsImageGeneration) {
        await this.#camofoxEnableCreateImage(tabId);
      }

      if (effectiveModelSlug && effectiveModelSlug !== "research") {
        await this.#camofoxSelectModel(tabId, effectiveModelSlug);
      }

      if (input.reasoningEffort) {
        await this.#camofoxSetReasoningEffort(tabId, input.reasoningEffort);
      }

      await this.#camofoxTypeWithFallback(tabId, input.prompt);
      await this.#camofoxSubmitPrompt(tabId);

      const polled = await this.#camofoxPollAssistantText(tabId, input.prompt, effectiveTimeout, {
        allowEmptyResult: wantsImageGeneration,
      });
      let imageUrls: string[] | undefined;
      if (wantsImageGeneration) {
        const links = await this.#camofoxGetLinks(tabId);
        const postSnapshot = await this.#camofoxSnapshotText(tabId);
        const snapshotUrls = extractUrlsFromSnapshot(postSnapshot).map((url) => ({ url }));
        imageUrls = extractImageUrlsFromLinks([...links, ...snapshotUrls]);
      }

      return {
        text: polled.text,
        conversationId: polled.conversationId ?? input.conversationId ?? null,
        parentMessageId: null,
        model: effectiveModelSlug ?? DEFAULT_MODEL,
        imageUrls,
      };
    } finally {
      if (tabId) {
        await this.#camofoxDeleteTab(tabId);
      }
    }
  }

  async getSession(): Promise<SessionPayload> {
    const response = await this.#get(`${this.#baseUrl}/api/auth/session`, {
      headers: this.#headers(),
    });

    const raw = response.text;
    const payload = safeJsonParse<SessionPayload>(raw) ?? {};
    if (!response.ok || !payload.accessToken) {
      throw new Error(
        `failed_to_get_access_token_from_session_cookie_${response.statusCode}: ${summarizeErrorPayload(raw)}`,
      );
    }

    return payload;
  }

  async getModels(): Promise<unknown> {
    const session = await this.getSession();
    const response = await this.#get(`${this.#baseUrl}/backend-api/models`, {
      headers: this.#headers({ Authorization: `Bearer ${session.accessToken ?? ""}` }),
    });

    const raw = response.text;
    const payload = safeJsonParse<unknown>(raw) ?? {};
    if (!response.ok) {
      throw new Error(`models_request_failed_${response.statusCode}: ${summarizeErrorPayload(raw)}`);
    }

    return payload;
  }

  async #getChatRequirementsToken(accessToken: string): Promise<string | null> {
    try {
      const response = await this.#post(`${this.#baseUrl}${CHAT_REQUIREMENTS_PATH}`, {
        headers: this.#headers({ Authorization: `Bearer ${accessToken}` }),
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
      : input.model?.trim() || modeToDefaultModelSlug(input.modelMode) || undefined;

    if (this.#transport === "camofox") {
      return await this.#askViaCamofox({
        ...input,
        prompt,
        model: requestedModel,
      });
    }

    if (input.createImage) {
      throw new Error("httpcloak_create_image_not_supported_use_camofox");
    }

    const session = await this.getSession();
    const accessToken = session.accessToken as string;
    const requirementsToken = await this.#getChatRequirementsToken(accessToken);

    const parentMessageId = input.parentMessageId ?? crypto.randomUUID();
    const userMessageId = crypto.randomUUID();

    const body = {
      action: "next",
      messages: [
        {
          id: userMessageId,
          author: { role: "user" },
          content: {
            content_type: "text",
            parts: [prompt],
          },
        },
      ],
      parent_message_id: parentMessageId,
      conversation_id: input.conversationId ?? undefined,
      model: requestedModel ?? DEFAULT_MODEL,
      history_and_training_disabled: false,
      timezone_offset_min: new Date().getTimezoneOffset() * -1,
      suggestions: [],
      websocket_request_id: crypto.randomUUID(),
      conversation_mode: { kind: "primary_assistant" },
    };

    const headers = this.#headers({
      Accept: "text/event-stream",
      Authorization: `Bearer ${accessToken}`,
    });

    if (requirementsToken) {
      headers["OpenAI-Sentinel-Chat-Requirements-Token"] = requirementsToken;
    }

    const response = await this.#post(`${this.#baseUrl}/backend-api/conversation`, {
      headers,
      json: body,
    });

    const raw = response.text;
    if (!response.ok) {
      throw new Error(
        `conversation_request_failed_${response.statusCode}: ${summarizeErrorPayload(raw)}`,
      );
    }

    const events = parseSseEvents(raw);
    if (events.length === 0) {
      throw new Error("empty_conversation_stream");
    }

    const streamError = events.find((event) => event.error)?.error;
    if (streamError) {
      throw new Error(`conversation_stream_error: ${streamError}`);
    }

    let text = "";
    let conversationId: string | null = null;
    let outputParentMessageId: string | null = null;
    let model: string | null = null;

    for (const event of events) {
      const candidate = extractAssistantText(event);
      if (candidate) {
        text = candidate;
      }

      if (event.conversation_id) {
        conversationId = event.conversation_id;
      }

      if (event.message?.id) {
        outputParentMessageId = event.message.id;
      }

      if (event.message?.metadata?.model_slug) {
        model = event.message.metadata.model_slug;
      }
    }

    if (!text) {
      throw new Error("assistant_response_not_found_in_stream");
    }

    return {
      text,
      conversationId,
      parentMessageId: outputParentMessageId,
      model,
    };
  }
}
