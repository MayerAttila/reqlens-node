# reqlens-node

Express middleware for collecting request analytics and sending them to a Reqlens ingest API.

```ts
import express from "express";
import { reqlens } from "@reqlens/node-sdk";

const app = express();

app.use(
  reqlens({
    apiKey: process.env.REQLENS_API_KEY!,
    endpoint: "https://api.reqlens.dev/ingest"
  })
);
```

Tracks method, route path, status code, duration, and timestamp. It does not collect request bodies or headers.
