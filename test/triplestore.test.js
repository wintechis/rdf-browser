const {test} = require("node:test");
const assert = require("node:assert");
const ts = require("../src/bdo/triplestore");

test("finalize: keeps used prefixes, drops unused ones", () => {
    const store = new ts.Triplestore("https://ex.org/doc", [
        ["dc", "http://purl.org/dc/terms/"],
        ["foaf", "http://xmlns.com/foaf/0.1/"]
    ]);
    // a single triple using dc:title
    const s = store.getURI("https://ex.org/doc");
    const p = store.getURI("http://purl.org/dc/terms/title");
    const o = store.getLiteral("hello", "http://www.w3.org/2001/XMLSchema#string", null);
    store.addTriple(s, p, o);
    store.finalize();

    const names = store.prefixes.map(x => x.name);
    assert.ok(names.includes("dc"), "dc is used -> kept");
    assert.ok(!names.includes("foaf"), "foaf is unused -> dropped");
    assert.ok(store.prefixes.every(x => x.used), "only used prefixes remain");
});

test("addTriple: de-duplicates identical triples", () => {
    const store = new ts.Triplestore("https://ex.org/", []);
    const triple = () => store.addTriple(
        store.getURI("https://ex.org/s"),
        store.getURI("https://ex.org/p"),
        store.getURI("https://ex.org/o"));
    triple();
    triple();
    assert.strictEqual(store.triples, 1);
});
