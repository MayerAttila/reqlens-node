# `@reqlens/node-sdk`

Express middleware for sending request analytics to a Reqlens ingest API.

The middleware records request method, route path, status code, duration, timestamp, and optional request/response body snapshots. Logs are batched and sent to Reqlens in the background.

## Install

```bash
npm install @reqlens/node-sdk
```

For local monorepo development, the examples package uses:

```json
"@reqlens/node-sdk": "file:../reqlens-node"
```

## Basic Usage

```ts
import express from "express";
import { reqlens } from "@reqlens/node-sdk";

const app = express();

app.use(express.json());

app.use(
  reqlens({
    apiKey: process.env.REQLENS_API_KEY!,
    endpoint: "http://localhost:3001/ingest"
  })
);
```

## Options

| Option | Default | Description |
| --- | --- | --- |
| `apiKey` | required | Project API key from Reqlens |
| `endpoint` | required | Reqlens ingest endpoint |
| `dashboardUrl` | `http://localhost:3000/dashboard` | URL printed in startup logs |
| `batchSize` | `50` | Logs sent per batch |
| `flushIntervalMs` | `5000` | Background flush interval |
| `maxQueueSize` | `1000` | Max queued logs before oldest logs are dropped |
| `requestTimeoutMs` | `2000` | Ingest/config request timeout |
| `enabled` | `true` | Disable middleware without removing it |
| `logLevel` | `info` | `debug`, `info`, or `silent` |
| `capture.requestBody` | `errors-only` | `always`, `errors-only`, or `off` |
| `capture.responseBody` | `errors-only` | `always`, `errors-only`, or `off` |
| `capture.slowRequestThresholdMs` | `750` | Slow request threshold |
| `capture.maxBodyBytes` | `10000` | Max serialized payload snapshot size |
| `capture.redactKeys` | sensitive defaults | Keys redacted from payload snapshots |
| `onError` | none | Callback when background send fails |

## Payload Capture

Default behavior:

- Captures payload snapshots only for errors or slow requests.
- Redacts keys containing `authorization`, `card`, `cookie`, `password`, `secret`, or `token`.
- Truncates large payloads.

Example:

```ts
app.use(
  reqlens({
    apiKey: process.env.REQLENS_API_KEY!,
    endpoint: "http://localhost:3001/ingest",
    capture: {
      requestBody: "errors-only",
      responseBody: "errors-only",
      slowRequestThresholdMs: 1000,
      redactKeys: ["password", "token", "apiKey"]
    }
  })
);
```

## Live Config Sync

The SDK reads project config from:

- `/sdk/config`
- `/sdk/config/stream`

This lets Reqlens update the slow-request threshold without redeploying the backend using the SDK.

## Scripts

| Command | Description |
| --- | --- |
| `npm run build` | Compile TypeScript |
| `npm run typecheck` | Typecheck without emitting files |
