// Entry point: start the forge, hand its port to the trial environment, and stay alive until
// the environment says the trial is over.
//
// The trial environment (the "env") is a small HTTP service whose origin comes from
// MAKEFUN_ENV_URL. The handshake is three steps:
//   1. listen on an ephemeral port chosen by the kernel, so nothing collides with the env
//      itself (the env listens on 8080; this process must never bind that port);
//   2. POST {"port": <the bound port>} to $MAKEFUN_ENV_URL/register, retrying until the env
//      accepts it (a 409 only means another entry registered first; that is not an error here);
//   3. GET $MAKEFUN_ENV_URL/done over and over until it answers {"done": true}, then shut the
//      server down and exit 0.
// Without MAKEFUN_ENV_URL there is no env to talk to, so the process exits 1 right away.
// Requests that fail (the env may still be starting) are retried with exponential backoff.

import { createApp } from "./app.ts";

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/+$/, "");
if (envOrigin === "") {
  process.stderr.write("[forge] MAKEFUN_ENV_URL is not set, so there is no trial env to join\n");
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 30_000;
const BACKOFF_FIRST_MS = 250;
const BACKOFF_LIMIT_MS = 2_000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(failures: number): number {
  const doubled = BACKOFF_FIRST_MS * 2 ** Math.min(failures, 8);
  return Math.min(BACKOFF_LIMIT_MS, doubled);
}

async function registerPort(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    let response: Response;
    try {
      response = await fetch(`${envOrigin}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // The env is unreachable for now; wait and try again.
      await wait(backoffMs(failures));
      failures += 1;
      continue;
    }
    if (response.status === 200 || response.status === 409) return;
    if (response.status === 400 || response.status === 405) {
      const detail = await response.text();
      throw new Error(`register was refused with HTTP ${response.status}: ${detail}`);
    }
    await wait(backoffMs(failures));
    failures += 1;
  }
}

async function waitUntilDone(): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const response = await fetch(`${envOrigin}/done`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) {
        const payload = (await response.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // A failed poll only means "not done yet".
    }
    await wait(backoffMs(failures));
    failures += 1;
  }
}

async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === "string") {
    throw new Error("the forge did not bind a TCP port");
  }
  process.stdout.write(`[forge] listening on port ${bound.port}\n`);

  await registerPort(bound.port);
  process.stdout.write("[forge] registered with the trial env; waiting for done\n");

  await waitUntilDone();
  server.close();
  process.stdout.write("[forge] trial done\n");
}

try {
  await run();
  process.exit(0);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[forge] ${message}\n`);
  process.exit(1);
}
