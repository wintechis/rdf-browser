const ShExParser = require("@shexjs/parser");

const XSD = "http://www.w3.org/2001/XMLSchema#";
const INDENT = "    ";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const FACETS = [
    ["length", "LENGTH"],
    ["minlength", "MINLENGTH"],
    ["maxlength", "MAXLENGTH"],
    ["mininclusive", "MININCLUSIVE"],
    ["minexclusive", "MINEXCLUSIVE"],
    ["maxinclusive", "MAXINCLUSIVE"],
    ["maxexclusive", "MAXEXCLUSIVE"],
    ["totaldigits", "TOTALDIGITS"],
    ["fractiondigits", "FRACTIONDIGITS"]
];
// A prefixed-name local part that can be written without escaping (a
// conservative subset of the ShExC/Turtle PN_LOCAL production).
const PN_LOCAL = /^[A-Za-z0-9_\u00C0-\uFFFF]([A-Za-z0-9_\-.\u00B7\u00C0-\uFFFF]*[A-Za-z0-9_\-\u00B7\u00C0-\uFFFF])?$/;

/**
 * Read a whole text body from either a getReader() stream (fromReader) or an
 * in-flight StreamFilter (on stop/data events), decoding with the given decoder.
 */
function readText(stream, fromReader, decoder) {
    return new Promise((resolve, reject) => {
        let text = "";
        if (fromReader) {
            stream.read().then(function process({done, value}) {
                if (done) {
                    resolve(text + decoder.decode());
                    return;
                }
                text += decoder.decode(value, {stream: true});
                stream.read().then(process, reject);
            }, reject);
        } else {
            stream.ondata = event => {
                text += decoder.decode(event.data, {stream: true});
            };
            stream.onstop = () => resolve(text + decoder.decode());
            stream.onerror = () => reject(stream.error);
        }
    });
}

/**
 * Parse a ShExC document into ShExJ (with _prefixes and _base attached).
 * Throws the parser's error (with line/position) on malformed input.
 */
function parseSchema(text, baseIRI) {
    const parser = ShExParser.construct(baseIRI, {}, {index: true});
    return parser.parse(text);
}

function esc(s) {
    return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Render a parsed ShExJ schema as ShExC with clickable IRIs, in the manner of
 * the Turtle view: IRIs link to themselves, and a shape reference (@label)
 * jumps to the shape's declaration when it is declared in this document.
 * @returns {{prefixes: string, shapes: string}} HTML for the prefix block and the declarations
 */
function renderSchema(schema, baseIRI) {
    const prefixes = schema._prefixes || {};
    const usedPrefixes = new Set();
    const docIRI = baseIRI.split("#")[0];
    const base = (schema._base || docIRI).split("#")[0];
    const shapes = schema.shapes || [];
    const declared = new Set(shapes.map(s => s.id));
    const tripleExprIds = new Set(Object.keys((schema._index && schema._index.tripleExprs) || {}));

    // Same-document IRIs are anchored by their fragment so <#S> and a click on
    // the shape's own IRI land on the same element; others by the full IRI.
    function anchorId(iri) {
        if (iri.startsWith(docIRI + "#"))
            return iri.substring(docIRI.length + 1);
        return iri;
    }

    function anchorHref(iri) {
        return "#" + encodeURIComponent(anchorId(iri));
    }

    function iriHref(iri) {
        if (iri.startsWith(docIRI + "#"))
            return iri.substring(docIRI.length);
        return iri;
    }

    function iriText(iri) {
        let best = null;
        for (const name in prefixes) {
            const ns = prefixes[name];
            if (iri.startsWith(ns) && (best === null || ns.length > prefixes[best].length)
                && (iri.length === ns.length || PN_LOCAL.test(iri.substring(ns.length))))
                best = name;
        }
        if (best !== null) {
            usedPrefixes.add(best);
            return {prefix: best, local: iri.substring(prefixes[best].length)};
        }
        // Relative to the (BASE or document) IRI, as ShExC resolves it.
        if (iri.startsWith(base + "#"))
            return {iri: iri.substring(base.length)};
        if (iri === base)
            return {iri: ""};
        return {iri: iri};
    }

    // An IRI as a link, styled like the Turtle view (prefixName/postfix or uri).
    function iriLink(iri, href = iriHref(iri)) {
        if (iri.startsWith("_:"))
            return '<a class="blankNode" href="' + esc(href) + '">' + esc(iri) + "</a>";
        const t = iriText(iri);
        if (t.prefix !== undefined)
            return '<span class="postfix"><a href="' + esc(href) + '"><span class="prefixName">'
                + esc(t.prefix) + "</span>:" + esc(t.local) + "</a></span>";
        return '<span class="uri"><a href="' + esc(href) + '">&lt;' + esc(t.iri) + "&gt;</a></span>";
    }

    // A shape label: an in-page jump when the shape is declared here.
    function shapeLabel(label) {
        return iriLink(label, declared.has(label) ? anchorHref(label) : iriHref(label));
    }

    // A predicate, with rdf:type written as the ShExC keyword "a".
    function predicate(iri) {
        if (iri === RDF_TYPE)
            return '<span class="postfix"><a href="' + esc(RDF_TYPE) + '">a</a></span>';
        return iriLink(iri);
    }

    function quote(value) {
        return '"' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')
            .replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t") + '"';
    }

    function literal(v) {
        const dt = v.type;
        if (v.language)
            return '<span class="literal">' + esc(quote(v.value)) + "@" + esc(v.language) + "</span>";
        if (dt === XSD + "integer" || dt === XSD + "decimal" || dt === XSD + "double" || dt === XSD + "boolean")
            return '<span class="literal">' + esc(v.value) + "</span>";
        if (dt && dt !== XSD + "string")
            return '<span class="literal">' + esc(quote(v.value)) + "^^</span>" + iriLink(dt);
        return '<span class="literal">' + esc(quote(v.value)) + "</span>";
    }

    function objectValue(v) {
        return typeof v === "string" ? iriLink(v) : literal(v);
    }

    function language(tag) {
        return '<span class="literal">@' + esc(tag) + "</span>";
    }

    // A single value of the given kind ("Iri", "Literal" or "Language").
    function plainValue(kind, value) {
        if (kind === "Iri")
            return iriLink(value);
        if (kind === "Language")
            return language(value);
        return literal({value: value});
    }

    function valueSetValue(v) {
        if (typeof v === "string")
            return iriLink(v);
        switch (v.type) {
            case "Language":
                return language(v.languageTag);
            case "IriStem":
            case "LiteralStem":
            case "LanguageStem":
                return plainValue(v.type.replace("Stem", ""), v.stem) + "~";
            case "IriStemRange":
            case "LiteralStemRange":
            case "LanguageStemRange": {
                const kind = v.type.replace("StemRange", "");
                let out = (typeof v.stem === "object" && v.stem.type === "Wildcard")
                    ? "."
                    : plainValue(kind, v.stem) + "~";
                for (const ex of v.exclusions || [])
                    out += " - " + (typeof ex === "string" ? plainValue(kind, ex) : valueSetValue(ex));
                return out;
            }
            default:
                return literal(v);
        }
    }

    function nodeConstraint(nc) {
        const parts = [];
        if (nc.nodeKind)
            parts.push(esc(nc.nodeKind.toUpperCase()));
        if (nc.datatype)
            parts.push(iriLink(nc.datatype));
        if (nc.values)
            parts.push("[" + nc.values.map(valueSetValue).join(" ") + "]");
        if (nc.pattern !== undefined)
            parts.push('<span class="literal">/' + esc(nc.pattern.replace(/\//g, "\\/")) + "/" + esc(nc.flags || "") + "</span>");
        for (const [key, kw] of FACETS)
            if (nc[key] !== undefined)
                parts.push(kw + " " + esc(nc[key]));
        return parts.length ? parts.join(" ") : ".";
    }

    function semActs(list) {
        if (!list || !list.length)
            return "";
        return list.map(a => " %" + iriLink(a.name)
            + (a.code !== undefined ? "{" + esc(a.code) + "%}" : "%")).join("");
    }

    function annotations(list) {
        if (!list || !list.length)
            return "";
        return list.map(a => " // " + predicate(a.predicate) + " " + objectValue(a.object)).join("");
    }

    function cardinality(te) {
        const min = te.min === undefined ? 1 : te.min;
        const max = te.max === undefined ? 1 : te.max;
        if (min === 1 && max === 1)
            return "";
        if (min === 0 && max === 1)
            return "?";
        if (min === 0 && max === -1)
            return "*";
        if (min === 1 && max === -1)
            return "+";
        if (min === max)
            return "{" + min + "}";
        return "{" + min + "," + (max === -1 ? "*" : max) + "}";
    }

    function pad(depth) {
        return INDENT.repeat(depth);
    }

    // A shape expression. depth is the indentation of the line it starts on;
    // a Shape's triple expressions are written one per line below it.
    function shapeExpr(se, depth, nested = false) {
        if (se === undefined || se === null)
            return ".";
        if (typeof se === "string")
            return "@" + shapeLabel(se);
        switch (se.type) {
            case "NodeConstraint":
                return nodeConstraint(se);
            case "Shape":
                return shape(se, depth);
            case "ShapeAnd":
            case "ShapeOr": {
                const inner = se.shapeExprs.map(e => shapeExpr(e, depth, true))
                    .join(se.type === "ShapeAnd" ? " AND " : " OR ");
                return nested ? "(" + inner + ")" : inner;
            }
            case "ShapeNot":
                return "NOT " + shapeExpr(se.shapeExpr, depth, true);
            case "ShapeExternal":
                return "EXTERNAL";
            default:
                return esc(JSON.stringify(se));
        }
    }

    function shape(s, depth) {
        let out = "";
        if (s.extends && s.extends.length)
            out += s.extends.map(e => "EXTENDS " + shapeExpr(e, depth, true)).join(" ") + " ";
        if (s.closed)
            out += "CLOSED ";
        if (s.extra && s.extra.length)
            out += "EXTRA " + s.extra.map(predicate).join(" ") + " ";
        if (s.expression)
            out += "{\n" + tripleExpr(s.expression, depth + 1, null) + "\n" + pad(depth) + "}";
        else
            out += "{ }";
        return out + annotations(s.annotations) + semActs(s.semActs);
    }

    // A triple expression, starting with its own indentation. parent is the
    // type of the enclosing group ("EachOf"/"OneOf"), or null at the top.
    function tripleExpr(te, depth, parent) {
        if (typeof te === "string") {
            const href = tripleExprIds.has(te) ? anchorHref(te) : iriHref(te);
            return pad(depth) + "&amp;" + iriLink(te, href);
        }
        const label = te.id
            ? '<span id="' + esc(anchorId(te.id)) + '">$' + iriLink(te.id, anchorHref(te.id)) + "</span> "
            : "";
        const suffix = cardinality(te) + annotations(te.annotations) + semActs(te.semActs);
        if (te.type === "TripleConstraint")
            return pad(depth) + label + (te.inverse ? "^" : "") + predicate(te.predicate)
                + " " + shapeExpr(te.valueExpr, depth) + (suffix ? " " + suffix.trim() : "");
        // ";" binds tighter than "|", so only a OneOf inside an EachOf, or a
        // group carrying a label/cardinality/annotation, needs parentheses.
        const parens = label !== "" || suffix !== "" || (te.type === "OneOf" && parent === "EachOf")
            || (parent !== null && te.type === parent);
        const inner = depth + (parens ? 1 : 0);
        const sep = te.type === "EachOf" ? " ;\n" : " |\n";
        const body = te.expressions.map(x => tripleExpr(x, inner, te.type)).join(sep);
        if (!parens)
            return body;
        return pad(depth) + label + "(\n" + body + "\n" + pad(depth) + ")" + suffix;
    }

    let decls = "";
    if (schema.imports && schema.imports.length)
        decls += '<p class="triple shexDecl">' + schema.imports.map(i => "IMPORT " + iriLink(i)).join("\n") + "</p>";
    if (schema.startActs && schema.startActs.length)
        decls += '<p class="triple shexDecl">' + semActs(schema.startActs).trim() + "</p>";
    if (schema.start)
        decls += '<p class="triple shexDecl">start = ' + shapeExpr(schema.start, 0) + "</p>";
    for (const decl of shapes) {
        const head = (decl.abstract ? "ABSTRACT " : "") + iriLink(decl.id) + " ";
        decls += '<p class="triple shexDecl" id="' + esc(anchorId(decl.id)) + '">' + head
            + shapeExpr(decl.shapeExpr, 0) + "</p>";
    }

    // Emitted after the declarations so only prefixes that were used appear.
    let prefixHtml = "";
    if (base !== docIRI)
        prefixHtml += '<span class="prefix"><span class="prefixDeclaration">BASE</span> '
            + '<span class="uri"><a href="' + esc(base) + '">&lt;' + esc(base) + "&gt;</a></span><br></span>";
    for (const name of Object.keys(prefixes)) {
        if (!usedPrefixes.has(name))
            continue;
        prefixHtml += '<span class="prefix"><span class="prefixDeclaration">PREFIX</span> <span class="prefixName">'
            + esc(name) + '</span><span class="postfix">:</span> <span class="uri"><a href="'
            + esc(prefixes[name]) + '">&lt;' + esc(prefixes[name]) + "&gt;</a></span><br></span>";
    }
    return {prefixes: prefixHtml, shapes: decls};
}

// Keep the line breaks and indentation of the ShExC rendering. In its own
// <style> element: style.js maps theme options onto the first stylesheet's
// rules by prefix match, so this must not live there.
const SHAPE_CSS = ".shexDecl{white-space:pre}";

module.exports = {readText, parseSchema, renderSchema, SHAPE_CSS};
