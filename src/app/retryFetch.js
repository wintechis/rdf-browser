/*
 * Wrap a fetch so it retries transient throttling with exponential backoff and
 * bounds every attempt with a timeout.
 *
 * Solid pod providers (e.g. solidcommunity.net) sit behind Cloudflare, which
 * rate-limits bursts with HTTP 429 (and 503). Two failure shapes occur:
 *  - a readable 429/503 Response, or
 *  - a thrown TypeError ("Failed to fetch") when the throttle page carries no
 *    CORS headers (so the browser blocks it and the status never reaches JS).
 * Both are retried, honoring Retry-After (capped so an interactive navigation
 * never blocks for a minute).
 *
 * The per-attempt timeout is the key anti-hang guarantee: a throttled Cloudflare
 * connection can stall without ever sending headers, which would otherwise leave
 * the onHeadersReceived listener awaiting forever and spin the tab indefinitely.
 * On timeout the attempt is abandoned (Promise.race; the underlying request is
 * left to die on its own) and retried, then — once retries are exhausted — the
 * final rejection propagates so the caller can render an error page instead of a
 * spinner.
 *
 * Ported from granergize-webapp src/services/utils/retryFetch.ts.
 */

const RETRYABLE_STATUS = new Set([429, 503]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A thrown fetch failure (network / CORS-blocked throttle page) is a TypeError.
function isNetworkError(e) {
    return e instanceof TypeError;
}

// Retry-After in ms (delta-seconds form), capped so honoring it can't stall an
// interactive lookup for a long time; null when absent or non-numeric.
function retryAfterMs(response, capMs) {
    const header = response.headers.get("Retry-After");
    if (!header)
        return null;
    const secs = Number(header);
    if (!Number.isFinite(secs))
        return null;
    return Math.min(secs * 1000, capMs);
}

// Reject after timeoutMs with a tagged error; the fetch itself keeps running but
// is no longer awaited.
function withTimeout(promise, timeoutMs) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const e = new Error("Request timed out after " + timeoutMs + "ms");
            e.name = "TimeoutError";
            reject(e);
        }, timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * @param fetchFn The underlying fetch (global fetch or a session.fetch).
 * @param opts {maxRetries, baseDelayMs, timeoutMs, maxWaitMs}
 * @returns A fetch-shaped function with retry + timeout applied.
 */
function withRetry(fetchFn, opts = {}) {
    const maxRetries = opts.maxRetries !== undefined ? opts.maxRetries : 3;
    const baseDelayMs = opts.baseDelayMs !== undefined ? opts.baseDelayMs : 400;
    // A fetch resolves when response headers arrive (not when the body finishes),
    // so 8s is generous for a healthy origin yet promptly abandons a Cloudflare
    // connection that has stalled without answering.
    const timeoutMs = opts.timeoutMs !== undefined ? opts.timeoutMs : 8000;
    const maxWaitMs = opts.maxWaitMs !== undefined ? opts.maxWaitMs : 5000;

    return async function (input, init) {
        let attempt = 0;
        while (true) {
            const backoff = Math.min(baseDelayMs * 2 ** attempt, maxWaitMs);
            try {
                const response = await withTimeout(fetchFn(input, init), timeoutMs);
                if (RETRYABLE_STATUS.has(response.status) && attempt < maxRetries) {
                    await sleep(retryAfterMs(response, maxWaitMs) || backoff);
                    attempt++;
                    continue;
                }
                return response;
            } catch (e) {
                if ((isNetworkError(e) || e.name === "TimeoutError") && attempt < maxRetries) {
                    await sleep(backoff);
                    attempt++;
                    continue;
                }
                throw e;
            }
        }
    };
}

module.exports = {withRetry};
