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

test("finalize: synthesizes a relative prefix for an unmatched same-origin IRI", () => {
    const store = new ts.Triplestore("https://wunderfacts.com/adv/oid/DENWAT011hs0002F", []);
    const s = store.getURI("https://wunderfacts.com/adv/oid/DENWAT011hs0002F");
    const p = store.getURI("https://example.org/predicate");
    const o1 = store.getURI("https://wunderfacts.com/adv/ok/7.1/ax-elektrifizierung#2000");
    const o2 = store.getURI("https://wunderfacts.com/adv/ok/7.1/ax-elektrifizierung#3000");
    store.addTriple(s, p, o1);
    store.addTriple(s, p, o2);
    store.finalize();

    assert.strictEqual(o1.prefix, o2.prefix, "both fragments share one synthesized prefix");
    assert.strictEqual(o1.prefix.name, "ax-elektrifizierung");
    assert.strictEqual(o1.prefix.value.value, "https://wunderfacts.com/adv/ok/7.1/ax-elektrifizierung#");
});

test("finalize: names per-id hash prefixes from the parent segment, not a colliding fallback", () => {
    // OSM-style URIs: every resource is its own hash-terminated stem
    // (.../way/<id>#), and the segment right before the id is a bare
    // number, which alone isn't a legal prefix name.
    const store = new ts.Triplestore("https://osmwrap.example/overpass/features", []);
    const s = store.getURI("https://osmwrap.example/overpass/features");
    const p = store.getURI("https://example.org/predicate");
    const o1 = store.getURI("https://osmwrap.example/way/320502576#id");
    const o2 = store.getURI("https://osmwrap.example/way/358616762#id");
    const o3 = store.getURI("https://osmwrap.example/node/11035846249#id");
    store.addTriple(s, p, o1);
    store.addTriple(s, p, o2);
    store.addTriple(s, p, o3);
    store.finalize();

    assert.strictEqual(o1.prefix.name, "way320502576");
    assert.strictEqual(o2.prefix.name, "way358616762");
    assert.strictEqual(o3.prefix.name, "node11035846249");
    const names = store.prefixes.map(x => x.name);
    assert.ok(!names.includes("local"), "no bare 'local' fallback when a readable name is available");
});

test("finalize: does not synthesize a prefix for a cross-origin IRI", () => {
    const store = new ts.Triplestore("https://wunderfacts.com/adv/oid/DENWAT011hs0002F", []);
    const s = store.getURI("https://wunderfacts.com/adv/oid/DENWAT011hs0002F");
    const p = store.getURI("https://example.org/predicate");
    const o = store.getURI("https://other.example/ok/7.1/ax-elektrifizierung#2000");
    store.addTriple(s, p, o);
    store.finalize();

    assert.strictEqual(o.prefix, null);
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
