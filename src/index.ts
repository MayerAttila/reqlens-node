import type { Request, RequestHandler } from "express";

export type ReqlensMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS"
  | string;

export interface ReqlensLog {
  method: ReqlensMethod;
  path: string;
  statusCode: number;
  durationMs: number;
  requestBody?: unknown;
  responseBody?: unknown;
  timestamp: string;
}

export type ReqlensBodyCaptureMode = "always" | "errors-only" | "off";
export type ReqlensLogLevel = "debug" | "info" | "silent";

export interface ReqlensCaptureOptions {
  requestBody?: ReqlensBodyCaptureMode;
  responseBody?: ReqlensBodyCaptureMode;
  slowRequestThresholdMs?: number;
  maxBodyBytes?: number;
  redactKeys?: string[];
}

export interface ReqlensOptions {
  apiKey: string;
  endpoint: string;
  dashboardUrl?: string;
  configEndpoint?: string;
  configStreamEndpoint?: string;
  configReconnectDelayMs?: number;
  batchSize?: number;
  flushIntervalMs?: number;
  maxQueueSize?: number;
  requestTimeoutMs?: number;
  enabled?: boolean;
  logLevel?: ReqlensLogLevel;
  capture?: ReqlensCaptureOptions;
  onError?: (error: unknown) => void;
}

interface NormalizedOptions {
  apiKey: string;
  endpoint: string;
  dashboardUrl?: string;
  configEndpoint: string;
  configStreamEndpoint: string;
  configReconnectDelayMs: number;
  batchSize: number;
  flushIntervalMs: number;
  maxQueueSize: number;
  requestTimeoutMs: number;
  enabled: boolean;
  logLevel: ReqlensLogLevel;
  capture: Required<ReqlensCaptureOptions>;
  onError?: (error: unknown) => void;
}

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const DEFAULT_CONFIG_RECONNECT_DELAY_MS = 5_000;
const DEFAULT_MAX_QUEUE_SIZE = 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_BODY_BYTES = 10_000;
const DEFAULT_SLOW_REQUEST_THRESHOLD_MS = 750;
const DEFAULT_DASHBOARD_URL = "http://localhost:3000/dashboard";
const DEFAULT_REDACT_KEYS = [
  "authorization",
  "card",
  "cookie",
  "password",
  "secret",
  "token"
];

export function reqlens(options: ReqlensOptions): RequestHandler {
  const config = normalizeOptions(options);
  const queue: ReqlensLog[] = [];
  let isFlushing = false;
  let hasLoggedConfigWait = false;
  let lastLoggedSlowRequestThresholdMs: number | null = null;

  const applyConfig = (sdkConfig: SdkConfigResponse | undefined): void => {
    const slowRequestThresholdMs = sdkConfig?.capture?.slowRequestThresholdMs;

    if (
      typeof slowRequestThresholdMs === "number" &&
      Number.isFinite(slowRequestThresholdMs) &&
      slowRequestThresholdMs > 0
    ) {
      config.capture.slowRequestThresholdMs = Math.floor(slowRequestThresholdMs);

      if (lastLoggedSlowRequestThresholdMs !== config.capture.slowRequestThresholdMs) {
        lastLoggedSlowRequestThresholdMs = config.capture.slowRequestThresholdMs;
        logInfo(
          config,
          `Config loaded. Slow payload capture threshold: ${config.capture.slowRequestThresholdMs} ms.`
        );
      }
    }
  };

  const syncConfig = async (): Promise<void> => {
    try {
      applyConfig(await fetchSdkConfig(config));
    } catch (error) {
      if (!hasLoggedConfigWait) {
        logInfo(
          config,
          `Waiting for Reqlens API at ${getOriginLabel(config.configEndpoint)}.`
        );
        hasLoggedConfigWait = true;
      }
      logDebug(config, error);
    }
  };

  const flush = async (): Promise<void> => {
    if (!config.enabled || isFlushing || queue.length === 0) {
      return;
    }

    isFlushing = true;
    const batch = queue.splice(0, config.batchSize);

    try {
      await sendBatch(config, batch);
    } catch (error) {
      requeueWithinLimit(queue, batch, config.maxQueueSize);
      logInfo(config, `Could not send logs yet. Retrying next flush.`);
      logDebug(config, error);
      config.onError?.(error);
    } finally {
      isFlushing = false;
    }
  };

  const interval = setInterval(() => {
    void flush();
  }, config.flushIntervalMs);

  interval.unref?.();
  void syncConfig();
  void streamConfig(config, applyConfig);
  logInfo(
    config,
    `Middleware started. Request logs will appear in the Reqlens dashboard${
      config.dashboardUrl ? `: ${config.dashboardUrl}` : "."
    }`
  );

  return (req, res, next) => {
    if (!config.enabled) {
      next();
      return;
    }

    const startedAt = process.hrtime.bigint();
    let responseBody: unknown;
    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);

    res.json = ((body: unknown) => {
      responseBody = body;
      return originalJson(body);
    }) as typeof res.json;

    res.send = ((body: unknown) => {
      responseBody ??= body;
      return originalSend(body as Parameters<typeof res.send>[0]);
    }) as typeof res.send;

    res.once("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const roundedDurationMs = Math.round(durationMs);
      const problem =
        res.statusCode >= 400 ||
        roundedDurationMs >= config.capture.slowRequestThresholdMs;

      enqueue(queue, config.maxQueueSize, {
        method: req.method,
        path: getRoutePath(req),
        statusCode: res.statusCode,
        durationMs: roundedDurationMs,
        requestBody: shouldCapture(config.capture.requestBody, problem)
          ? snapshotPayload(req.body, config.capture)
          : undefined,
        responseBody: shouldCapture(config.capture.responseBody, problem)
          ? snapshotPayload(responseBody, config.capture)
          : undefined,
        timestamp: new Date().toISOString()
      });

      if (queue.length >= config.batchSize) {
        void flush();
      }
    });

    next();
  };
}

function normalizeOptions(options: ReqlensOptions): NormalizedOptions {
  if (!options.apiKey) {
    throw new Error("Reqlens requires an apiKey.");
  }

  if (!options.endpoint) {
    throw new Error("Reqlens requires an endpoint.");
  }

  return {
    apiKey: options.apiKey,
    endpoint: options.endpoint,
    dashboardUrl: options.dashboardUrl ?? DEFAULT_DASHBOARD_URL,
    configEndpoint: options.configEndpoint ?? getDefaultConfigEndpoint(options.endpoint),
    configStreamEndpoint:
      options.configStreamEndpoint ?? getDefaultConfigStreamEndpoint(options.endpoint),
    configReconnectDelayMs: positiveInt(
      options.configReconnectDelayMs,
      DEFAULT_CONFIG_RECONNECT_DELAY_MS
    ),
    batchSize: positiveInt(options.batchSize, DEFAULT_BATCH_SIZE),
    flushIntervalMs: positiveInt(options.flushIntervalMs, DEFAULT_FLUSH_INTERVAL_MS),
    maxQueueSize: positiveInt(options.maxQueueSize, DEFAULT_MAX_QUEUE_SIZE),
    requestTimeoutMs: positiveInt(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
    enabled: options.enabled ?? true,
    logLevel: options.logLevel ?? "info",
    capture: {
      maxBodyBytes: positiveInt(
        options.capture?.maxBodyBytes,
        DEFAULT_MAX_BODY_BYTES
      ),
      redactKeys: options.capture?.redactKeys ?? DEFAULT_REDACT_KEYS,
      requestBody: options.capture?.requestBody ?? "errors-only",
      responseBody: options.capture?.responseBody ?? "errors-only",
      slowRequestThresholdMs: positiveInt(
        options.capture?.slowRequestThresholdMs,
        DEFAULT_SLOW_REQUEST_THRESHOLD_MS
      )
    },
    onError: options.onError
  };
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.floor(value);
}

function enqueue(queue: ReqlensLog[], maxQueueSize: number, log: ReqlensLog): void {
  if (queue.length >= maxQueueSize) {
    queue.shift();
  }

  queue.push(log);
}

function requeueWithinLimit(
  queue: ReqlensLog[],
  failedBatch: ReqlensLog[],
  maxQueueSize: number
): void {
  const room = Math.max(maxQueueSize - queue.length, 0);
  const logsToRestore = failedBatch.slice(-room);
  queue.unshift(...logsToRestore);
}

async function sendBatch(config: NormalizedOptions, logs: ReqlensLog[]): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  try {
    const response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-reqlens-api-key": config.apiKey
      },
      body: JSON.stringify({ logs }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Reqlens ingest failed with status ${response.status}.`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

type SdkConfigResponse = {
  capture?: {
    slowRequestThresholdMs?: number;
  };
};

async function fetchSdkConfig(
  config: NormalizedOptions
): Promise<SdkConfigResponse | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  try {
    const response = await fetch(config.configEndpoint, {
      method: "GET",
      headers: {
        "x-reqlens-api-key": config.apiKey
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Reqlens config sync failed with status ${response.status}.`);
    }

    return (await response.json()) as SdkConfigResponse;
  } finally {
    clearTimeout(timeout);
  }
}

async function streamConfig(
  config: NormalizedOptions,
  applyConfig: (sdkConfig: SdkConfigResponse | undefined) => void
): Promise<void> {
  let isConfigStreamConnected = false;

  while (config.enabled) {
    try {
      const response = await fetch(config.configStreamEndpoint, {
        method: "GET",
        headers: {
          accept: "text/event-stream",
          "x-reqlens-api-key": config.apiKey
        }
      });

      if (!response.ok) {
        throw new Error(
          `Reqlens config stream failed with status ${response.status}.`
        );
      }

      if (!response.body) {
        throw new Error("Reqlens config stream response had no body.");
      }

      if (!isConfigStreamConnected) {
        logInfo(config, "Connected. Live project settings are synced.");
        isConfigStreamConnected = true;
      }
      await readConfigStream(response.body, applyConfig);
    } catch (error) {
      if (isConfigStreamConnected) {
        logInfo(config, "Settings stream disconnected. Reconnecting...");
        isConfigStreamConnected = false;
      } else if (!isConnectionRefusedError(error)) {
        logInfo(config, "Settings stream unavailable. Retrying...");
      }
      logDebug(config, error);
      await delay(config.configReconnectDelayMs);
    }
  }
}

async function readConfigStream(
  body: ReadableStream<Uint8Array>,
  applyConfig: (sdkConfig: SdkConfigResponse | undefined) => void
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      return;
    }

    buffer += decoder.decode(value, { stream: true });
    const messages = buffer.split("\n\n");
    buffer = messages.pop() ?? "";

    for (const message of messages) {
      const config = parseConfigEvent(message);

      if (config) {
        applyConfig(config);
      }
    }
  }
}

function parseConfigEvent(message: string): SdkConfigResponse | undefined {
  const data = message
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");

  if (!data) {
    return undefined;
  }

  try {
    return JSON.parse(data) as SdkConfigResponse;
  } catch {
    return undefined;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRoutePath(req: Request): string {
  const baseUrl = req.baseUrl ?? "";
  const routePath = getExpressRoutePath(req);

  if (routePath) {
    return joinPaths(baseUrl, routePath);
  }

  return stripQuery(req.originalUrl || req.url || req.path || "/");
}

function getExpressRoutePath(req: Request): string | undefined {
  const route = req.route as { path?: string | RegExp | Array<string | RegExp> } | undefined;

  if (!route?.path) {
    return undefined;
  }

  if (typeof route.path === "string") {
    return route.path;
  }

  if (route.path instanceof RegExp) {
    return route.path.source;
  }

  const firstStringPath = route.path.find((path) => typeof path === "string");
  return typeof firstStringPath === "string" ? firstStringPath : undefined;
}

function joinPaths(baseUrl: string, routePath: string): string {
  const normalizedBase = baseUrl === "/" ? "" : baseUrl.replace(/\/$/, "");
  const normalizedRoute = routePath.startsWith("/") ? routePath : `/${routePath}`;
  return `${normalizedBase}${normalizedRoute}` || "/";
}

function stripQuery(path: string): string {
  return path.split("?")[0] || "/";
}

function getDefaultConfigEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    url.pathname = "/sdk/config";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return endpoint.replace(/\/ingest\/?$/, "/sdk/config");
  }
}

function getDefaultConfigStreamEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    url.pathname = "/sdk/config/stream";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return endpoint.replace(/\/ingest\/?$/, "/sdk/config/stream");
  }
}

function shouldCapture(mode: ReqlensBodyCaptureMode, problem: boolean): boolean {
  return mode === "always" || (mode === "errors-only" && problem);
}

function snapshotPayload(
  value: unknown,
  capture: Required<ReqlensCaptureOptions>
): unknown {
  if (value === undefined) {
    return undefined;
  }

  const redacted = redactPayload(value, new Set(capture.redactKeys.map(normalizeKey)));
  const json = safeStringify(redacted);

  if (json === undefined) {
    return "[unserializable]";
  }

  if (Buffer.byteLength(json, "utf8") > capture.maxBodyBytes) {
    return {
      truncated: true,
      preview: json.slice(0, capture.maxBodyBytes)
    };
  }

  return JSON.parse(json) as unknown;
}

function redactPayload(value: unknown, redactKeys: Set<string>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactPayload(item, redactKeys));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [
      key,
      shouldRedactKey(key, redactKeys) ? "[redacted]" : redactPayload(nestedValue, redactKeys)
    ])
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shouldRedactKey(key: string, redactKeys: Set<string>): boolean {
  const normalized = normalizeKey(key);

  for (const redactKey of redactKeys) {
    if (normalized.includes(redactKey)) {
      return true;
    }
  }

  return false;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function logInfo(config: NormalizedOptions, message: string): void {
  if (config.logLevel === "silent") {
    return;
  }

  console.info(`${purple("[reqlens]")} ${message}`);
}

function logDebug(config: NormalizedOptions, error: unknown): void {
  if (config.logLevel !== "debug") {
    return;
  }

  console.warn(`${purple("[reqlens:debug]")}`, error);
}

function purple(value: string): string {
  return `\u001b[35m${value}\u001b[0m`;
}

function getOriginLabel(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return endpoint;
  }
}

function isConnectionRefusedError(error: unknown): boolean {
  return JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(
    "ECONNREFUSED"
  );
}
