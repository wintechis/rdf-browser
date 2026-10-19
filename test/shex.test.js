const {test} = require("node:test");
const assert = require("node:assert");
const shex = require("../src/app/shex");

const base = "https://ex.org/schema.shex";

function render(text) {
    return shex.renderSchema(shex.parseSchema(text, base), base);
}

const schema = [
    "PREFIX ex: <http://ex.org/>",
    "PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>",
    "PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>",
    "PREFIX unused: <http://unused.org/>",
    "start = @<#Person>",
    "<#Person> CLOSED EXTRA a {",
    "  a [ex:Person] ;",
    "  ex:name xsd:string MINLENGTH 1 // rdfs:comment \"full name\" ;",
    "  ex:knows @<#Person> * ;",
    "  ( ex:email IRI | ex:phone LITERAL /^\\\\+/ )+ ;",
    "  ^ex:owner @ex:Thing {2,5}",
    "}",
    "ABSTRACT <#Employee> EXTENDS @<#Person> { ex:status [ex:Active \"x\"@en ex:On~] } AND NOT @<#Person>"
].join("\n");

test("shex: reads a getReader() stream split mid-character", async () => {
    const bytes = new TextEncoder().encode("ex:S { ex:p \"é\" }");
    const cut = bytes.indexOf(0xc3) + 1; // split inside the two-byte é
    const chunks = [bytes.slice(0, cut), bytes.slice(cut)];
    let i = 0;
    const reader = {read: () => Promise.resolve(i < chunks.length ? {done: false, value: chunks[i++]} : {done: true})};
    const text = await shex.readText(reader, true, new TextDecoder("utf-8"));
    assert.strictEqual(text, "ex:S { ex:p \"é\" }");
});

// The rendered HTML as plain ShExC text (tags stripped, entities decoded).
function text(html) {
    return html.replace(/<br>/g, "\n").replace(/<\/p>/g, "\n").replace(/<[^>]*>/g, "")
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

// ShExJ without the parser's bookkeeping (_prefixes, _index, ...).
function clean(schema) {
    return JSON.parse(JSON.stringify(schema, (k, v) => k.startsWith("_") ? undefined : v));
}

test("shex: renders ShExC that parses back to the same schema", () => {
    const view = render(schema);
    const reparsed = shex.parseSchema(text(view.prefixes) + text(view.shapes), base);
    assert.deepStrictEqual(clean(reparsed), clean(shex.parseSchema(schema, base)));
});

test("shex: renders a schema with groups, labels, stems and semantic actions round-trip", () => {
    const src = [
        "PREFIX ex: <http://ex.org/>",
        "BASE <http://other.org/dir/>",
        "IMPORT <lib.shex>",
        "<S> {",
        "  $<#g> ( ex:a . ; ex:b [1 2.5 true \"q\\\"uote\"^^ex:dt] ){2,*} ;",
        "  ( ex:c @<T> | ex:d { ex:e LITERAL MAXLENGTH 3 } AND NOT IRI ) ;",
        "  &<#g> ;",
        "  ex:f [ex:~ - ex:x . - ex:y~] // ex:note <x> %ex:act{ code %}",
        "}",
        "<T> EXTERNAL",
        "<U> LITERAL /a\\/b/i"
    ].join("\n");
    const view = render(src);
    const reparsed = shex.parseSchema(text(view.prefixes) + text(view.shapes), base);
    assert.deepStrictEqual(clean(reparsed), clean(shex.parseSchema(src, base)));
});

test("shex: declarations are anchored by fragment; local references jump in-page", () => {
    const {shapes} = render(schema);
    assert.match(shapes, /<p class="triple shexDecl" id="Person">/);
    assert.match(shapes, /<p class="triple shexDecl" id="Employee">ABSTRACT /);
    // @<#Person> is declared here: an in-page anchor
    assert.match(shapes, /@<span class="uri"><a href="#Person">&lt;#Person&gt;<\/a>/);
    // @ex:Thing is not declared here: links to the IRI itself
    assert.match(shapes, /@<span class="postfix"><a href="http:\/\/ex.org\/Thing">/);
});

test("shex: one triple constraint per indented line", () => {
    const lines = text(render(schema).shapes).split("\n");
    assert.ok(lines.includes("<#Person> CLOSED EXTRA a {"));
    assert.ok(lines.includes("    ex:knows @<#Person> * ;"));
    assert.ok(lines.includes("    ^ex:owner @ex:Thing {2,5}"));
});

test("shex: only used prefixes are declared", () => {
    const {prefixes} = render(schema);
    assert.match(prefixes, /prefixName">ex</);
    assert.match(prefixes, /prefixName">xsd</);
    assert.doesNotMatch(prefixes, /unused/);
});

test("shex: text is escaped", () => {
    const {shapes} = render("PREFIX ex: <http://ex.org/>\nex:S { ex:p [\"<script>&\"] }");
    assert.match(shapes, /&lt;script&gt;&amp;/);
    assert.doesNotMatch(shapes, /<script>/);
});

test("shex: rejects malformed ShExC", () => {
    assert.throws(() => shex.parseSchema("ex:S { ex:p", base));
});
