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
  timestamp: string;
}

export interface ReqlensOptions {
  apiKey: string;
  endpoint: string;
  batchSize?: number;
  flushIntervalMs?: number;
  maxQueueSize?: number;
  requestTimeoutMs?: number;
  enabled?: boolean;
  onError?: (error: unknown) => void;
}

interface NormalizedOptions {
  apiKey: string;
  endpoint: string;
  batchSize: number;
  flushIntervalMs: number;
  maxQueueSize: number;
  requestTimeoutMs: number;
  enabled: boolean;
  onError?: (error: unknown) => void;
}

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const DEFAULT_MAX_QUEUE_SIZE = 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 2_000;

export function reqlens(options: ReqlensOptions): RequestHandler {
  const config = normalizeOptions(options);
  const queue: ReqlensLog[] = [];
  let isFlushing = false;

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
      config.onError?.(error);
    } finally {
      isFlushing = false;
    }
  };

  const interval = setInterval(() => {
    void flush();
  }, config.flushIntervalMs);

  interval.unref?.();

  return (req, res, next) => {
    if (!config.enabled) {
      next();
      return;
    }

    const startedAt = process.hrtime.bigint();

    res.once("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

      enqueue(queue, config.maxQueueSize, {
        method: req.method,
        path: getRoutePath(req),
        statusCode: res.statusCode,
        durationMs: Math.round(durationMs),
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
    batchSize: positiveInt(options.batchSize, DEFAULT_BATCH_SIZE),
    flushIntervalMs: positiveInt(options.flushIntervalMs, DEFAULT_FLUSH_INTERVAL_MS),
    maxQueueSize: positiveInt(options.maxQueueSize, DEFAULT_MAX_QUEUE_SIZE),
    requestTimeoutMs: positiveInt(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
    enabled: options.enabled ?? true,
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
