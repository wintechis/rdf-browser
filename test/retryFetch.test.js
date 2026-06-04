const {test} = require("node:test");
const assert = require("node:assert");

const {withRetry} = require("../src/app/retryFetch");

// A fake Response carrying just what withRetry inspects (status + Retry-After).
function res(status, retryAfter) {
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: {get: name => (name === "Retry-After" ? (retryAfter ?? null) : null)}
    };
}

// Returns a fetch that yields the scripted statuses/errors in order, recording
// the number of calls. An entry that is an Error is thrown; otherwise it is a
// status code wrapped in a Response.
function scriptedFetch(script) {
    let i = 0;
    const fn = async () => {
        const step = script[Math.min(i, script.length - 1)];
        i++;
        if (step instanceof Error)
            throw step;
        return res(step);
    };
    fn.calls = () => i;
    return fn;
}

const fast = {baseDelayMs: 1, maxWaitMs: 5, timeoutMs: 1000};

test("withRetry: retries a 429 then returns the success", async () => {
    const f = scriptedFetch([429, 200]);
    const out = await withRetry(f, fast)("u");
    assert.strictEqual(out.status, 200);
    assert.strictEqual(f.calls(), 2);
});

test("withRetry: retries 503 too", async () => {
    const f = scriptedFetch([503, 503, 200]);
    const out = await withRetry(f, fast)("u");
    assert.strictEqual(out.status, 200);
    assert.strictEqual(f.calls(), 3);
});

test("withRetry: gives up after maxRetries and returns the last 429", async () => {
    const f = scriptedFetch([429]);
    const out = await withRetry(f, {...fast, maxRetries: 2})("u");
    assert.strictEqual(out.status, 429);
    assert.strictEqual(f.calls(), 3); // initial + 2 retries
});

test("withRetry: retries a thrown network error (CORS-blocked 429)", async () => {
    const f = scriptedFetch([new TypeError("Failed to fetch"), 200]);
    const out = await withRetry(f, fast)("u");
    assert.strictEqual(out.status, 200);
    assert.strictEqual(f.calls(), 2);
});

test("withRetry: a non-network error is not retried and propagates", async () => {
    const f = scriptedFetch([new RangeError("boom"), 200]);
    await assert.rejects(() => withRetry(f, fast)("u"), /boom/);
    assert.strictEqual(f.calls(), 1);
});

test("withRetry: a 404 is returned immediately, not retried", async () => {
    const f = scriptedFetch([404, 200]);
    const out = await withRetry(f, fast)("u");
    assert.strictEqual(out.status, 404);
    assert.strictEqual(f.calls(), 1);
});

test("withRetry: a stalled attempt times out and is retried", async () => {
    let calls = 0;
    const f = async () => {
        calls++;
        if (calls === 1)
            return new Promise(() => {}); // never resolves -> must time out
        return res(200);
    };
    const out = await withRetry(f, {...fast, timeoutMs: 20})("u");
    assert.strictEqual(out.status, 200);
    assert.strictEqual(calls, 2);
});

test("withRetry: honours a numeric Retry-After (capped by maxWaitMs)", async () => {
    let i = 0;
    const f = async () => (i++ === 0 ? res(429, "100") : res(200));
    const start = Date.now();
    const out = await withRetry(f, {baseDelayMs: 1, maxWaitMs: 30, timeoutMs: 1000})("u");
    const elapsed = Date.now() - start;
    assert.strictEqual(out.status, 200);
    // Retry-After of 100s would be huge; the cap keeps it near maxWaitMs.
    assert.ok(elapsed < 500, "wait should be capped, took " + elapsed + "ms");
});
