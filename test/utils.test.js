const {test} = require("node:test");
const assert = require("node:assert");

// utils.js does `const browser = window.browser` at module load; shim it.
global.window = {browser: {}};
const {onList} = require("../src/app/utils");

function bl(patterns) {
    return {blacklist: patterns.join("\n"), whitelist: ""};
}

const has = (patterns, url) => onList(bl(patterns), "blacklist", new URL(url));

test("onList: exact page match", () => {
    assert.strictEqual(has(["https://ex.org/page"], "https://ex.org/page"), true);
    assert.strictEqual(has(["https://ex.org/page"], "https://ex.org/other"), false);
});

test("onList: host wildcard /* matches all paths on the host", () => {
    const p = ["https://ex.org/*"];
    assert.strictEqual(has(p, "https://ex.org/"), true);
    assert.strictEqual(has(p, "https://ex.org/a/b/c"), true);
    assert.strictEqual(has(p, "https://other.org/a"), false);
});

test("onList: directory wildcard matches only under that path", () => {
    const p = ["https://ex.org/dir/*"];
    assert.strictEqual(has(p, "https://ex.org/dir/x"), true);
    assert.strictEqual(has(p, "https://ex.org/dir/x/y"), true);
    assert.strictEqual(has(p, "https://ex.org/other/x"), false);
});

test("onList: subdomain wildcard matches subdomains", () => {
    const p = ["https://*.ex.org/*"];
    assert.strictEqual(has(p, "https://sub.ex.org/a"), true);
    assert.strictEqual(has(p, "https://deep.sub.ex.org/a"), true);
    assert.strictEqual(has(p, "https://notex.org/a"), false);
});

test("onList: scheme in the pattern is ignored (host+path only)", () => {
    // the per-site toggle stores https://<host>/* but should also catch http
    const p = ["https://ex.org/*"];
    assert.strictEqual(has(p, "http://ex.org/a"), true);
});

test("onList: commented (#) and blank lines are ignored", () => {
    assert.strictEqual(has(["#https://ex.org/*"], "https://ex.org/a"), false);
    assert.strictEqual(has(["", "  ", "#x"], "https://ex.org/a"), false);
});

test("onList: any matching line wins", () => {
    const p = ["https://a.org/*", "https://b.org/*"];
    assert.strictEqual(has(p, "https://b.org/x"), true);
});
