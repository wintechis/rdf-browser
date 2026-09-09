const {test} = require("node:test");
const assert = require("node:assert");
const {relativeReference, compareValues} = require("../src/bdo/resource");

// relativeReference(target, base) must produce a reference that, resolved
// against the base, reproduces the target exactly.
function roundTrips(target, base) {
    const rel = relativeReference(target, base);
    if (rel === null)
        return false;
    return new URL(rel, base).href === new URL(target).href;
}

test("relativeReference: descendants are relative", () => {
    const base = "https://ex.org/a/b/";
    assert.strictEqual(relativeReference(base + "child/", base), "child/");
    assert.strictEqual(relativeReference(base + "doc.ttl", base), "doc.ttl");
    assert.strictEqual(relativeReference(base + "x/y/z", base), "x/y/z");
});

test("relativeReference: parents and siblings use ../", () => {
    const base = "https://ex.org/a/b/";
    assert.strictEqual(relativeReference("https://ex.org/a/", base), "../");
    assert.strictEqual(relativeReference("https://ex.org/", base), "../../");
    assert.strictEqual(relativeReference("https://ex.org/a/sib/", base), "../sib/");
    assert.strictEqual(relativeReference("https://ex.org/other/x", base), "../../other/x");
});

test("relativeReference: file-based base resolves against its directory", () => {
    const base = "https://ex.org/a/b/file";
    assert.strictEqual(relativeReference("https://ex.org/a/b/other", base), "other");
    assert.strictEqual(relativeReference("https://ex.org/a/b/", base), "./");
});

test("relativeReference: a colon-leading first segment is guarded", () => {
    const base = "https://ex.org/a/";
    // would otherwise parse as a scheme
    assert.strictEqual(relativeReference("https://ex.org/a/x:y", base), "./x:y");
});

test("relativeReference: query and fragment are preserved", () => {
    const base = "https://ex.org/a/";
    assert.strictEqual(relativeReference("https://ex.org/a/b#sec", base), "b#sec");
    assert.strictEqual(relativeReference("https://ex.org/a/b?q=1", base), "b?q=1");
});

test("relativeReference: a bare trailing '#' (empty fragment) is preserved", () => {
    // URL.hash normalizes an empty fragment to "", losing the distinction
    // between "no fragment" and "empty fragment" — a stem synthesized for a
    // hash-fragment IRI (e.g. ".../index#") relies on the '#' staying put.
    const base = "https://ex.org/tag/building";
    assert.strictEqual(relativeReference("https://ex.org/index#", base), "../index#");
});

test("relativeReference: different origin stays absolute (null)", () => {
    const base = "https://ex.org/a/";
    assert.strictEqual(relativeReference("https://other.org/a/", base), null);
    assert.strictEqual(relativeReference("http://ex.org/a/", base), null); // scheme differs
});

test("relativeReference: every result round-trips", () => {
    const base = "https://michaela-auster.solidcommunity.net/granergize/buildings/";
    const targets = [
        base + "1780478162186-evhas/",
        base + "data.ttl",
        "https://michaela-auster.solidcommunity.net/granergize/",
        "https://michaela-auster.solidcommunity.net/",
        "https://michaela-auster.solidcommunity.net/granergize/rooms/",
        "https://michaela-auster.solidcommunity.net/other/x",
        base + "deep/a/b/c"
    ];
    for (const t of targets)
        assert.ok(roundTrips(t, base), "should round-trip: " + t);
});

test("compareValues: numeric suffixes order numerically, both directions", () => {
    // entries differing only by a trailing number compare by the number
    assert.ok(compareValues("item2", "item10") < 0);
    assert.ok(compareValues("item10", "item2") > 0);
    assert.strictEqual(compareValues("item2", "item2"), 0);
});
