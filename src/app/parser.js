const RdfXmlParser = require('rdfxml-streaming-parser').RdfXmlParser;
const JsonLdParser = require('jsonld-streaming-parser').JsonLdParser;
const N3StreamParser = require('n3').StreamParser;
const Transform = require('stream').Transform;
const ts = require('../bdo/triplestore');

function obtainTriplestore(inputStream, redirect, decoder, format, baseIRI) {
    return new Promise((resolve, reject) => {
        const parser = getParser(format, baseIRI);
        if (!parser)
            reject("Unsupported format");
        ts.getTriplestore(baseIRI).then(store => {
            parseDocument(inputStream, parser, decoder, redirect, store, resolve, reject);
        });
    });
}

function getParser(format, baseIRI) {
    let parser = null;
    switch (format) {
        case "application/rdf+xml":
            parser = new RdfXmlParser({
                baseIRI: baseIRI
            });
            break;
        case "application/ld+json":
            parser = new JsonLdParser({
                baseIRI: baseIRI
            });
            break;
        case "application/trig":
        case "application/n-quads":
        case "application/n-triples":
        case "text/nt":
        case "text/turtle":
        case "text/n3":
            parser = new N3StreamParser({
                baseIRI: baseIRI
            });
            break;
    }
    return parser;
}

function parseDocument(inputStream, parser, decoder, redirect, store, resolve, reject) {
    const transformStream = new Transform({
        transform(chunk, encoding, callback) {
            this.push(chunk);
            callback();
        }
    });
    // A getReader() stream (redirect/authenticated fetch) is pulled with read();
    // the in-flight StreamFilter delivers data via on(stop|data) events.
    if (redirect) {
        inputStream.read().then(function processText({done, value}) {
            if (done)
                transformStream.push(null);
            else {
                handleInput(value, transformStream);
                inputStream.read().then(processText);
            }
        });
    } else {
        inputStream.onstop = () => {
            transformStream.push(null);
        };
        inputStream.ondata = event => {
            handleInput(event.data, transformStream);
        };
    }
    const outputStream = parser.import(transformStream);
    outputStream
        .on("context", context => {
            for (const prefix in context) {
                if (typeof context[prefix] === "string")
                    store.addPrefix(prefix, context[prefix]);
            }
        })
        .on("data", triple => {
            handleTriple(triple);
        })
        .on("prefix", (prefix, ns) => {
            if (typeof ns.value === "string" && /^http/.test(ns.value))
                store.addPrefix(prefix, ns.value);
        })
        .on("error", error => {
            reject(error);
        })
        .on("end", () => {
            store.finalize();
            resolve(store);
        });

    function processResource(store, resource) {
        const value = resource.value;
        const resourceType = Object.getPrototypeOf(resource).termType || resource.termType;
        if (!resourceType)
            return null;
        switch (resourceType) {
            case "BlankNode":
                return store.getBlankNode(value);
            case "NamedNode":
                return store.getURI(value);
            case "Literal":
                return store.getLiteral(value, resource.datatype.value, resource.language);
        }
        return null;
    }

    function handleInput(value, transformStream) {
        let data = decoder.decode(value, {stream: true});
        if (typeof data === "string")
            transformStream.push(data);
    }

    function handleTriple(triple) {
        const subject = processResource(store, triple.subject);
        const predicate = processResource(store, triple.predicate);
        const object = processResource(store, triple.object);
        store.addTriple(subject, predicate, object);
    }
}

module.exports = {obtainTriplestore};
