const {test} = require("node:test");
const assert = require("node:assert");
const parser = require("../src/app/parser");

// Feed a string through obtainTriplestore via a mock getReader() stream
// (the redirect=true read() path), and return the resulting triplestore.
function parse(ttl, format, base) {
    const enc = new TextEncoder();
    const chunks = [enc.encode(ttl.slice(0, Math.ceil(ttl.length / 2))), enc.encode(ttl.slice(Math.ceil(ttl.length / 2)))];
    let i = 0;
    const reader = {read: () => Promise.resolve(i < chunks.length ? {done: false, value: chunks[i++]} : {done: true})};
    return parser.obtainTriplestore(reader, true, new TextDecoder("utf-8"), format, base);
}

test("parser: parses a Turtle container listing", async () => {
    const base = "https://ex.org/c/";
    const ttl = [
        "@prefix dc: <http://purl.org/dc/terms/>.",
        "@prefix ldp: <http://www.w3.org/ns/ldp#>.",
        "<> a ldp:Container; dc:modified \"2026\".",
        "<a/> a ldp:Resource.",
        "<b.ttl> a ldp:Resource.",
        "<> ldp:contains <a/>, <b.ttl>."
    ].join("\n");
    const store = await parse(ttl, "text/turtle", base);
    assert.strictEqual(store.triples, 6);
    assert.strictEqual(store.subjects.length, 3); // <>, <a/>, <b.ttl>
    const used = store.prefixes.filter(p => p.used).map(p => p.name);
    assert.ok(used.includes("dc"));
    assert.ok(used.includes("ldp"));
});

test("parser: unused common prefixes are dropped on finalize", async () => {
    // base prefix and any common prefixes that no triple uses must be removed.
    const store = await parse("<https://ex.org/s> <http://purl.org/dc/terms/title> \"t\".", "text/turtle", "https://ex.org/s");
    // every retained prefix must actually be used
    assert.ok(store.prefixes.every(p => p.used), "all retained prefixes should be used");
});

test("parser: rejects malformed RDF", async () => {
    await assert.rejects(parse("<a> <b> .", "text/turtle", "https://ex.org/"));
});

test("parser: parses N-Triples", async () => {
    const nt = "<https://ex.org/s> <https://ex.org/p> <https://ex.org/o> .";
    const store = await parse(nt, "application/n-triples", "https://ex.org/");
    assert.strictEqual(store.triples, 1);
});
