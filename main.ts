// main.ts — the entrypoint: start the forge, tell the env where it lives, and stay
// alive until the env declares the trial finished.
//
// The env (a separate process) scores the server this file boots. The contract, in
// order:
//   1. MAKEFUN_ENV_URL points at the env. Without it there is nobody to talk to, so
//      bail out immediately with exit code 1.
//   2. Bind the forge to an ephemeral port (listen(0) and read it back). Port 8080
//      belongs to the env; never take it.
//   3. POST {"port": N} to $MAKEFUN_ENV_URL/register so the env knows where to dial.
//      The first registration wins — a 409 just means someone else got there first
//      and this process waits like any other. 400/405 mean the request itself is
//      wrong, so those are fatal; anything else (a status the env might answer with
//      while still starting, a dropped connection, a timeout) is worth retrying.
//   4. GET $MAKEFUN_ENV_URL/done over and over until the answer is {"done": true}.
//      The env answers promptly either way, so this is a poll loop; a failed or
//      slow poll is retried, and the process never quits before the env says so.
//   5. Shut the server down and exit 0.
//
// Retries back off exponentially (250 ms first, doubling, never past 2 s) and every
// single HTTP call gives up after 30 s. Nothing here touches a model or a package:
// the only import is the forge itself.

import { createApp } from './app.ts';

const ENV_ORIGIN = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_ORIGIN === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is empty: no env to register with\n');
  process.exit(1);
}

// One HTTP call may hang this long before it counts as failed and is retried.
const CALL_BUDGET_MS = 30_000;
// Retry spacing: start here, double after each miss, stop growing here.
const RETRY_FIRST_MS = 250;
const RETRY_CEILING_MS = 2_000;

const pause = (ms: number): Promise<void> =>
  new Promise((done) => setTimeout(done, ms));

/** The next wait after a failed attempt: double the last one, capped. */
function growWait(lastWait: number): number {
  return Math.min(RETRY_CEILING_MS, lastWait * 2);
}

/** A fetch against the env that gives up after CALL_BUDGET_MS instead of hanging. */
async function callEnv(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${ENV_ORIGIN}${path}`, {
    ...init,
    signal: AbortSignal.timeout(CALL_BUDGET_MS),
  });
}

/**
 * Announce the bound port. Returns once the env has accepted it (200) or tells us
 * a first registration already won (409). A 400/405 is a contract violation and
 * aborts the process; every other outcome is retried.
 */
async function announce(port: number): Promise<void> {
  let wait = RETRY_FIRST_MS;
  for (;;) {
    let reply: Response;
    try {
      reply = await callEnv('/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
    } catch {
      // The env is not reachable yet (or the call timed out): wait, then try again.
      await pause(wait);
      wait = growWait(wait);
      continue;
    }
    if (reply.status === 200 || reply.status === 409) return;
    if (reply.status === 400 || reply.status === 405) {
      throw new Error(`register refused: HTTP ${reply.status} ${await reply.text()}`);
    }
    await pause(wait);
    wait = growWait(wait);
  }
}

/** Keep asking /done until the env answers {"done": true}. Never returns early. */
async function waitUntilDone(): Promise<void> {
  let wait = RETRY_FIRST_MS;
  for (;;) {
    try {
      const reply = await callEnv('/done');
      if (reply.ok) {
        const payload = (await reply.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // A failed or timed-out poll just means "not done yet": poll again.
    }
    await pause(wait);
    wait = growWait(wait);
  }
}

/** Boot the forge, register it, wait for the trial to end, then shut it down. */
async function run(): Promise<void> {
  const forge = createApp();
  const port = await new Promise<number>((resolve, reject) => {
    forge.once('error', reject);
    forge.listen(0, () => {
      const bound = forge.address();
      if (bound === null || typeof bound === 'string') {
        reject(new Error('the forge did not bind a TCP port'));
        return;
      }
      resolve(bound.port);
    });
  });
  process.stdout.write(`[entry] forge listening on port ${port}\n`);

  await announce(port);
  process.stdout.write('[entry] registered with the env; waiting for done\n');

  await waitUntilDone();
  forge.close();
  process.stdout.write('[entry] trial done, shutting down\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
