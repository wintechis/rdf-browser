const LOCAL_NAME_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9_\-.]*[a-zA-Z0-9_\-]$|^[a-zA-Z0-9_]$/;

const datatypes = {
    string: "http://www.w3.org/2001/XMLSchema#string",
    integer: "http://www.w3.org/2001/XMLSchema#integer",
    decimal: "http://www.w3.org/2001/XMLSchema#decimal",
    langString: "http://www.w3.org/1999/02/22-rdf-syntax-ns#langString"
};

class Resource {
    constructor(value) {
        this.value = value;
        this.html = null;
        this.constituents = {
            subject: null,
            predicate: [],
            object: []
        };
        this.representationLength = 0;
        this.id = null;
    }

    compareTo(resource, position = "") {
        if (["subject", "object"].includes(position))
            return this.compareTypes(this, resource);
        return compareValues(this.value, resource.value);
    }

    compareTypes(a, b) {
        const typeA = a.getTypeNumber();
        const typeB = b.getTypeNumber();
        if (typeA <= 0 || typeB <= 0 || typeA === typeB)
            return a.compareTo(b);
        else
            return (typeA < typeB) ? -1 : 1;
    }

    getTypeNumber() {
        return 0;
    }

    setSubject(subject) {
        this.constituents.subject = subject;
    }

    addPredicate(predicate) {
        this.constituents.predicate.push(predicate);
    }

    addObject(object) {
        this.constituents.object.push(object);
    }
}

class URI extends Resource {
    constructor(value) {
        super(value);
        this.prefix = null;
        const id = value.split("#");
        if (id.length > 1 && id[id.length - 1] !== "")
            this.id = id[id.length - 1];
        this.subjects = [];
    }

    addSubject(subject) {
        this.subjects.push(subject);
    }

    updatePrefix(prefixes) {
        if (this.prefix !== null)
            return;
        for (const prefix of prefixes) {
            if (this.value.length > prefix.value.value.length && this.value.includes(prefix.value.value) &&
                this.value.substr(prefix.value.value.length, this.value.length).match(LOCAL_NAME_PATTERN)) {
                this.prefix = prefix;
                prefix.used = true;
                return;
            }
        }
    }

    createHtml(retrieveHtml = false, forPrefix = false, baseURL = "") {
        const html = document.createElement("span");
        const link = document.createElement("a");
        let uriValue = this.value;
        if (baseURL !== "") {
            try {
                const thisNorm = new URL(this.value).href;
                const baseNorm = new URL(baseURL).href;
                if (thisNorm === baseNorm)
                    uriValue = "";
                else if (new URL(this.value.split("#")[0]).href === new URL(baseURL.split("#")[0]).href)
                    uriValue = this.value.substring(this.value.split("#")[0].length);
                else {
                    // Show same-origin references relative to the base — a
                    // descendant as <child/>, a sibling as <../sibling/>, the
                    // parent as <../> — matching how containers serialise their
                    // members. Different-origin references stay absolute.
                    const rel = relativeReference(this.value, baseURL);
                    if (rel !== null)
                        uriValue = rel;
                }
            } catch(e) {
                if ((this.value.replace("https", "http").split("#"))[0] ===
                    (baseURL.replace("https", "http").split("#")[0]))
                    uriValue = this.value.substring(this.value.split("#")[0].length);
            }
        }
        link.setAttribute("href", uriValue);
        if (!forPrefix && this.prefix !== null) {
            html.setAttribute("class", "postfix");
            const prefixElement = document.createElement("span");
            prefixElement.setAttribute("class", "prefixName");
            const prefixText = this.prefix.name;
            prefixElement.appendChild(document.createTextNode(prefixText));
            const prefixValue = this.prefix.value.value;
            const postfixText = ":" + this.value.substr(prefixValue.length, this.value.length);
            link.appendChild(prefixElement);
            link.appendChild(document.createTextNode(postfixText));
            html.appendChild(link);
            if (this.html === null)
                this.representationLength = prefixText.length + postfixText.length;
        } else {
            html.setAttribute("class", "uri");
            link.appendChild(document.createTextNode("<"));
            link.appendChild(document.createTextNode(uriValue));
            link.appendChild(document.createTextNode(">"));
            html.appendChild(link);
            if (forPrefix)
                return html;
            if (this.html === null)
                this.representationLength = uriValue.length + 2;
        }
        if (this.html === null)
            this.html = html;
        if (retrieveHtml)
            return html;
    }

    getTypeNumber() {
        return 2;
    }
}

class BlankNode extends Resource {
    constructor(value) {
        super(value);
        this.representationLength = value.length + 2;
        this.id = "_:" + value;
    }

    compareTo(resource, position = "") {
        if (["subject", "object"].includes(position))
            return this.compareTypes(this, resource);
        if ((typeof resource === typeof this) && /b[0-9]+/.test(this.value) && /b[0-9]+/.test(resource.value)) {
            const myNumber = parseInt(this.value.substring(1, this.value.length));
            const otherNumber = parseInt(resource.value.substring(1, resource.value.length));
            return myNumber < otherNumber ? -1 : (myNumber > otherNumber ? 1 : 0);
        }
        return compareValues(this.value, resource.value);
    }

    createHtml() {
        const html = document.createElement("span");
        const link = document.createElement("a");
        link.setAttribute("href", "#_:" + this.value);
        link.appendChild(document.createTextNode("_:" + this.value));
        html.appendChild(link);
        link.setAttribute("class", "blankNode");
        this.html = html;
    }

    getTypeNumber() {
        return 3;
    }
}

class Literal extends Resource {
    constructor(value, datatype, triplestore, language = null) {
        super(value.replace(new RegExp("\"", 'g'), "\'"));
        this.dtype = triplestore.getURI(datatype);
        if (this.dtype.value !== datatypes.langString)
            language = null;
        this.language = language;
    }

    updatePrefix(prefixes) {
        this.dtype.updatePrefix(prefixes);
    }

    createHtml() {
        const html = document.createElement("span");
        html.setAttribute("class", "literal");
        let node;
        switch (this.dtype.value) {
            case datatypes.string:
                node = document.createTextNode("\"" + this.value + "\"");
                break;
            case datatypes.integer:
            case datatypes.decimal:
                node = document.createTextNode(this.value);
                break;
            case datatypes.langString:
                node = document.createTextNode("\"" + this.value + "\"@" + this.language);
                break;
            default:
                node = document.createTextNode("\"" + this.value + "\"^^");
                html.appendChild(node);
                const dtypeHtml = this.dtype.createHtml(true);
                const n = dtypeHtml.childNodes.length;
                for (let i = 0; i < n; ++i)
                    html.appendChild(dtypeHtml.childNodes[0]);
                this.html = html;
                return;
        }
        html.appendChild(node);
        this.html = html;
    }

    getTypeNumber() {
        return 2;
    }
}

/**
 * Compute an RFC 3986 relative reference for `targetHref` against `baseHref`
 * (e.g. "child/", "../sibling/", "../"), so resolving it against the base yields
 * the target. Returns null when they are not the same origin (keep it absolute).
 */
function relativeReference(targetHref, baseHref) {
    let t, b;
    try {
        t = new URL(targetHref);
        b = new URL(baseHref);
    } catch (e) {
        return null;
    }
    if (t.protocol !== b.protocol || t.host !== b.host)
        return null;
    const tParts = t.pathname.split("/");
    const bParts = b.pathname.split("/");
    // Relative refs resolve against the base's directory, i.e. everything up to
    // its last "/": drop the base's final segment (a file name, or the empty
    // string after a trailing slash).
    bParts.pop();
    let i = 0;
    while (i < bParts.length && i < tParts.length && bParts[i] === tParts[i])
        i++;
    const up = bParts.length - i;
    const down = tParts.slice(i);
    let rel = "../".repeat(up) + down.join("/");
    if (rel === "")
        rel = "./"; // target is the base directory itself
    else if (up === 0 && /^[^/]*:/.test(rel))
        rel = "./" + rel; // first segment with ':' would be read as a scheme
    // t.hash normalizes a bare trailing "#" (empty fragment) to "", losing it —
    // but t.href keeps it, and stems synthesized for hash-fragment IRIs rely on
    // that trailing "#" being present. Recover it from href instead of t.hash.
    const hashIndex = t.href.indexOf("#");
    const hash = hashIndex >= 0 ? t.href.substring(hashIndex) : "";
    return rel + t.search + hash;
}

function compareValues(a, b) {
    const pattern = /[^[0-9][0-9]+$/;
    if (pattern.test(a) && pattern.test(b)) {
        const aLength = (a.match(pattern)[0]).length - 1;
        const bLength = (b.match(pattern)[0]).length - 1;
        const aString = a.substring(0, a.length - aLength);
        const bString = b.substring(0, b.length - bLength);
        if (aString === bString) {
            const aInt = parseInt(a.substring(aString.length));
            const bInt = parseInt(b.substring(bString.length));
            return aInt < bInt ? -1 : (aInt > bInt ? 1 : 0);
        }
    }
    return a.localeCompare(b);
}

module.exports = {Resource, URI, BlankNode, Literal, compareValues, relativeReference, LOCAL_NAME_PATTERN};
