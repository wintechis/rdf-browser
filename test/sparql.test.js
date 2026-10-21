const {test} = require("node:test");
const assert = require("node:assert");
const sparql = require("../src/app/sparql");

const base = "http://localhost:8000/queries/q.rq";

// The rendered HTML as plain text (tags stripped, entities decoded).
function text(html) {
    return html.replace(/<[^>]*>/g, "")
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

const query = [
    "# things, by <kind> & label",
    "PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>",
    "PREFIX : <http://ex.org/>",
    "SELECT ?kind $thing ?label",
    "FROM <vocab>",
    "WHERE {",
    "  ?thing a :Thing ; rdfs:label \"a # not a comment <x>\"@en .",
    "  [] :p _:b1 . FILTER (?x < 3 && ?y<?z) # trailing",
    "  OPTIONAL { ?thing un:known ?label }",
    "}",
    "order by ?kind"
].join("\n");

test("sparql: keeps the query text as written", () => {
    assert.strictEqual(text(sparql.renderQuery(query, base)), query);
});

test("sparql: tokens concatenate to the input", () => {
    assert.strictEqual(sparql.tokenize(query).map(t => t.text).join(""), query);
});

test("sparql: IRIs resolve against the document; prefixed names expand", () => {
    const html = sparql.renderQuery(query, base);
    assert.match(html, /<a href="http:\/\/localhost:8000\/queries\/vocab">&lt;vocab&gt;<\/a>/);
    assert.match(html, /<a href="http:\/\/www.w3.org\/2000\/01\/rdf-schema#label"><span class="prefixName">rdfs<\/span>:label<\/a>/);
    assert.match(html, /<a href="http:\/\/ex.org\/Thing"><span class="prefixName"><\/span>:Thing<\/a>/);
    assert.match(html, /<a href="http:\/\/www.w3.org\/1999\/02\/22-rdf-syntax-ns#type">a<\/a>/);
    // undeclared prefix: not linked
    assert.match(html, /<span class="postfix"><span class="prefixName">un<\/span>:known<\/span>/);
});

test("sparql: comments, strings, variables, keywords, blank nodes", () => {
    const html = sparql.renderQuery(query, base);
    assert.match(html, /<span class="sparqlComment"># things, by &lt;kind&gt; &amp; label<\/span>/);
    assert.match(html, /<span class="sparqlComment"># trailing<\/span>/);
    assert.match(html, /<span class="literal">&quot;a # not a comment &lt;x&gt;&quot;<\/span>@en/);
    assert.match(html, /<span class="sparqlVariable">\$thing<\/span>/);
    assert.match(html, /<span class="prefixDeclaration">order<\/span>/);
    assert.match(html, /<span class="blankNode">_:b1<\/span>/);
    // a comparison is not an IRI
    assert.doesNotMatch(html, /href="[^"]*3 &amp;/);
});

test("sparql: BASE changes how later IRIs resolve", () => {
    const html = sparql.renderQuery("BASE <http://other.org/dir/>\nPREFIX ex: <ns#>\nSELECT * { <a> ex:b ?c }", base);
    assert.match(html, /href="http:\/\/other.org\/dir\/a"/);
    assert.match(html, /href="http:\/\/other.org\/dir\/ns#b"/);
});

test("sparql: text is escaped", () => {
    const html = sparql.renderQuery("SELECT * { ?s ?p \"<script>&\" }", base);
    assert.match(html, /&lt;script&gt;&amp;/);
    assert.doesNotMatch(html, /<script>/);
});
