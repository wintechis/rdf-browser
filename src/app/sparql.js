const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const KEYWORDS = new Set([
    "BASE", "PREFIX", "SELECT", "CONSTRUCT", "DESCRIBE", "ASK", "DISTINCT", "REDUCED", "AS", "FROM",
    "NAMED", "WHERE", "ORDER", "BY", "ASC", "DESC", "LIMIT", "OFFSET", "VALUES", "OPTIONAL", "GRAPH",
    "UNION", "MINUS", "FILTER", "BIND", "SERVICE", "SILENT", "GROUP", "HAVING", "UNDEF", "NOT", "IN",
    "EXISTS", "LOAD", "CLEAR", "DROP", "CREATE", "ADD", "MOVE", "COPY", "INSERT", "DELETE", "DATA",
    "WITH", "USING", "DEFAULT", "ALL", "INTO", "TO", "TRUE", "FALSE"
]);
// The lexical tokens of SPARQL that matter for rendering, tried in order at
// each position. Anything else (punctuation, numbers, whitespace) is copied.
const TOKENS = [
    ["comment", /#[^\n\r]*/y],
    ["iri", /<[^<>"{}|^`\\\x00-\x20]*>/y],
    ["string", /'''(?:[^'\\]|\\.|'(?!''))*'''|"""(?:[^"\\]|\\.|"(?!""))*"""|'(?:[^'\\\n\r]|\\.)*'|"(?:[^"\\\n\r]|\\.)*"/y],
    ["variable", /[?$][A-Za-z0-9_·À-￿]+/y],
    ["bnode", /_:[A-Za-z0-9_À-￿](?:[A-Za-z0-9_\-.·À-￿]*[A-Za-z0-9_\-·À-￿])?/y],
    ["pname", /(?:[A-Za-zÀ-￿](?:[A-Za-z0-9_\-.·À-￿]*[A-Za-z0-9_\-·À-￿])?)?:(?:(?:[A-Za-z0-9_:À-￿]|%[0-9A-Fa-f]{2}|\\[_~.\-!$&'()*+,;=/?#@%])(?:(?:[A-Za-z0-9_\-.:·À-￿]|%[0-9A-Fa-f]{2}|\\[_~.\-!$&'()*+,;=/?#@%])*(?:[A-Za-z0-9_\-:·À-￿]|%[0-9A-Fa-f]{2}|\\[_~.\-!$&'()*+,;=/?#@%]))?)?/y],
    ["word", /[A-Za-z_][A-Za-z0-9_]*/y]
];

function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function resolve(iri, base) {
    try {
        return new URL(iri, base).href;
    } catch (e) {
        return iri;
    }
}

/**
 * Split a SPARQL query or update into tokens ({type, text}); the concatenated
 * texts are the original input, so comments and layout are kept.
 */
function tokenize(text) {
    const tokens = [];
    let other = "";
    let i = 0;
    outer:
    while (i < text.length) {
        // A name continues a preceding word/number; don't start a token mid-name.
        const midName = i > 0 && /[A-Za-z0-9_]/.test(text[i - 1]);
        for (const [type, re] of TOKENS) {
            if (midName && (type === "pname" || type === "word" || type === "bnode"))
                continue;
            re.lastIndex = i;
            const m = re.exec(text);
            if (m && m[0].length > 0) {
                if (other) {
                    tokens.push({type: "other", text: other});
                    other = "";
                }
                tokens.push({type: type, text: m[0]});
                i += m[0].length;
                continue outer;
            }
        }
        other += text[i++];
    }
    if (other)
        tokens.push({type: "other", text: other});
    return tokens;
}

/**
 * Render a SPARQL query or update as HTML in the manner of the Turtle view:
 * IRIs (resolved against BASE or the document) and prefixed names (expanded
 * with the PREFIX declarations in effect) link to the resources they denote.
 * The query text is kept as written.
 */
function renderQuery(text, baseIRI) {
    const tokens = tokenize(text);
    const prefixes = {};
    let base = baseIRI.split("#")[0];
    let html = "";
    // The keyword (BASE/PREFIX) whose arguments are being read, and the prefix
    // label of a PREFIX declaration awaiting its IRI.
    let declaring = null;
    let label = null;

    for (const t of tokens) {
        switch (t.type) {
            case "comment":
                html += '<span class="sparqlComment">' + esc(t.text) + "</span>";
                break;
            case "iri": {
                const iri = resolve(t.text.slice(1, -1), base);
                if (declaring === "BASE")
                    base = iri;
                else if (declaring === "PREFIX" && label !== null)
                    prefixes[label] = iri;
                declaring = null;
                html += '<span class="uri"><a href="' + esc(iri) + '">' + esc(t.text) + "</a></span>";
                break;
            }
            case "pname": {
                const colon = t.text.indexOf(":");
                const name = t.text.substring(0, colon);
                if (declaring === "PREFIX") {
                    label = name;
                    html += '<span class="prefixName">' + esc(name) + '</span><span class="postfix">:</span>';
                    break;
                }
                const local = t.text.substring(colon + 1).replace(/\\(.)/g, "$1");
                const nameHtml = '<span class="prefixName">' + esc(name) + "</span>:" + esc(t.text.substring(colon + 1));
                if (prefixes.hasOwnProperty(name))
                    html += '<span class="postfix"><a href="' + esc(prefixes[name] + local) + '">' + nameHtml + "</a></span>";
                else
                    html += '<span class="postfix">' + nameHtml + "</span>";
                break;
            }
            case "word": {
                const upper = t.text.toUpperCase();
                if (upper === "BASE" || upper === "PREFIX") {
                    declaring = upper;
                    label = null;
                }
                if (t.text === "a")
                    html += '<span class="postfix"><a href="' + esc(RDF_TYPE) + '">a</a></span>';
                else if (KEYWORDS.has(upper))
                    html += '<span class="prefixDeclaration">' + esc(t.text) + "</span>";
                else
                    html += esc(t.text);
                break;
            }
            case "string":
                html += '<span class="literal">' + esc(t.text) + "</span>";
                break;
            case "variable":
                html += '<span class="sparqlVariable">' + esc(t.text) + "</span>";
                break;
            case "bnode":
                html += '<span class="blankNode">' + esc(t.text) + "</span>";
                break;
            default:
                html += esc(t.text);
        }
    }
    return '<p class="triple sparqlQuery">' + html + "</p>";
}

// Keep the query's own line breaks and indentation. In its own <style>
// element: style.js maps theme options onto the first stylesheet's rules by
// prefix match, so this must not live there.
const QUERY_CSS = ".sparqlQuery{white-space:pre}.sparqlComment{opacity:.6;font-style:italic}"
    + ".sparqlVariable{font-weight:bold}";

module.exports = {tokenize, renderQuery, QUERY_CSS};
