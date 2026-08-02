const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch + JSON with bounded retries on transient failures (429 / 5xx / network).
 * Honours Retry-After when the server sends it. Throws on persistent failure so the
 * caller can decide whether that player's work should be retried on the next run.
 */
export async function fetchJson(url, { retries = 3, timeoutMs = 20000, ...init } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000));
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ac.signal });

      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after'));
        if (Number.isFinite(retryAfter) && retryAfter > 0) {
          await sleep(Math.min(retryAfter * 1000, 15000));
        }
        lastErr = new Error(`HTTP ${res.status} from ${hostOf(url)}`);
        continue;
      }
      if (!res.ok) {
        // 4xx other than 429 won't fix themselves — fail fast.
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} from ${hostOf(url)}: ${body.slice(0, 200)}`);
      }
      return await res.json();
    } catch (err) {
      if (err.name === 'AbortError') {
        lastErr = new Error(`Timed out after ${timeoutMs}ms: ${hostOf(url)}`);
      } else if (String(err.message).startsWith('HTTP 4')) {
        throw err;
      } else {
        lastErr = err;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new Error(`Request failed: ${hostOf(url)}`);
}

function hostOf(url) {
  try {
    return new URL(url).host + new URL(url).pathname;
  } catch {
    return 'unknown';
  }
}

export { sleep };
