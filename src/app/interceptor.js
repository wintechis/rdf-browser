const browser = window.browser;
const parser = require("./parser");
const serializer = require("./serializer");
const utils = require('./utils');
const auth = require('./auth');
const pagestyle = require('./pagestyle');
const {withRetry} = require('./retryFetch');
const styleScriptPath = "build/controller/style.js";
const templatePath = "build/view/template.html";
const filter = {
    urls: ["<all_urls>"]
};
const requests = {};
let options;

function getFormats(uri = "") {
    const formats = [];
    if (options.json && !uri.includes("://dbpedia.org"))
        formats.push("application/ld+json");
    if (options.n4)
        formats.push("application/n-quads");
    if (options.nt)
        formats.push("application/n-triples");
    if (options.xml)
        formats.push("application/rdf+xml");
    if (options.trig)
        formats.push("application/trig");
    if (options.ttl)
        formats.push("text/turtle");
    if (options.n3)
        formats.push("text/n3");
    return formats;
}

function getFileTypes() {
    const fileTypes = [];
    if (options.rdfext)
        fileTypes.push("rdf");
    if (options.jsonldext)
        fileTypes.push("jsonld");
    if (options.ttlext)
        fileTypes.push("ttl");
    if (options.ntext)
        fileTypes.push("nt");
    if (options.nqext)
        fileTypes.push("nq");
    return fileTypes;
}

function getFormatFor(fileType) {
    switch (fileType) {
        case "rdf":
            return "application/rdf+xml";
        case "jsonld":
            return "application/ld+json";
        case "ttl":
        case "nt":
        case "nq":
            return "text/turtle";
        default:
            return false;
    }
}


/**
 * Modify the accept header for all HTTP requests to include the content types specified in formats
 * with higher priority than the remaining content types
 * @param details The details of the HTTP request
 * @returns {{requestHeaders: *}} The modified request header
 */
function modifyRequestHeader(details) {
    if (!options.quickOptions.header || (options.xhr && details.type !== "main_frame"))
        return {};
    const url = new URL(details.url);
    const isInitialRequest = (!requests.hasOwnProperty(details.tabId) || !requests[details.tabId].redirect);
    const isBlacklisted = utils.onList(options, "blacklist", url, true) || (!isInitialRequest && requests[details.tabId].blacklist);
    if (isInitialRequest)
        requests[details.tabId] = {reqUrl: details.url, redirect: false, blacklist: isBlacklisted};
    if (isBlacklisted)
        return {};
    for (let headerField of details.requestHeaders) {
        if (headerField.name.toLowerCase() === "accept") {
            headerField.value = getNewAcceptHeader(headerField.value, details.url);
        } else if (headerField.name.toLowerCase() === "accept-language") {
            headerField.value = options.acceptLanguage
        }
    }
    return {requestHeaders: details.requestHeaders};
}

/**
 * Modify the header of an HTTP response if format of content-type matches any in formats
 * @param details The details of the HTTP response
 * @returns {{}|{responseHeaders: {name: string, value: string}[]}} The modified response header
 */
async function modifyResponseHeader(details) {
    const redirect = (details.statusCode >= 300 && details.statusCode < 400);
    if (requests.hasOwnProperty(details.tabId))
        requests[details.tabId].redirect = redirect;
    if (!options.quickOptions.response || details.type !== "main_frame" || utils.onList(options, "blacklist", new URL(details.url)))
        return {};
    // A protected Solid resource answers an unauthenticated navigation with
    // 401 + a WWW-Authenticate challenge. If the background already holds a
    // Solid session, render the resource in place via an authenticated fetch
    // (session.fetch — DPoP-signed in the background). Otherwise redirect to the
    // template page to show a login screen. The challenge gate avoids hijacking
    // ordinary 401s from non-Solid sites.
    let authenticated = false;
    if (details.statusCode === 401) {
        const wwwAuth = details.responseHeaders.find(h => h.name.toLowerCase() === "www-authenticate");
        if (wwwAuth && /dpop|solid|bearer/i.test(wwwAuth.value)) {
            const status = await auth.getStatus();
            if (!status.isLoggedIn)
                return {
                    redirectUrl: browser.runtime.getURL(templatePath
                        + "?url=" + encodeURIComponent(details.url) + "&auth=1")
                };
            authenticated = true;
        }
    }
    const cl = details.responseHeaders.find(h => h.name.toLowerCase() === "content-length");
    if (cl) {
        const length = parseInt(cl.value);
        if (length === undefined || length > options.maxsize)
            return {};
    }
    const onWhitelist = utils.onList(options, "whitelist", new URL(details.url));
    const contentType = details.responseHeaders.find(h => h.name.toLowerCase() === "content-type");
    let format = contentType ? getFormats().find(f => contentType.value.includes(f)) : false;
    let fileType = new URL(details.url).pathname.split(".");
    fileType = (fileType !== undefined && fileType.length >= 1) ? fileType[fileType.length - 1] : false;
    let encoding = contentType ? contentType.value.split("charset=") : false;
    encoding = (encoding && encoding.length >= 2) ? encoding[1] : false;
    if (!format && !getFileTypes().includes(fileType) && !onWhitelist)
        return {};
    if (!format && !(format = getFormatFor(fileType))) {
        if (onWhitelist)
            console.warn(details.url + " is on the RDF Browser Whitelist, but the page content was not identified as RDF.");
        return {};
    }
    if (!encoding) {
        console.warn("The HTTP response does not include encoding information. Encoding in utf-8 is assumed.");
        encoding = "utf-8";
    }
    if (authenticated)
        return await renderAuthenticatedResource(cl, details, encoding, format);
    return await rewriteResponse(cl, details, encoding, format, redirect);
}

/**
 * Fetch a protected resource with the background Solid session and render it in
 * place. On success the body is rendered as Turtle; on a non-2xx result
 * (403/404/5xx) or a network error a styled error page is written INTO the
 * stream filter at the resource's real URL. The error must be written to the
 * filter (not returned as a redirect): a redirect returned from
 * onHeadersReceived after the async authFetch arrives too late, so Firefox
 * drops it and the navigation reverts to the previous page.
 */
async function renderAuthenticatedResource(cl, details, encoding, format) {
    let response;
    try {
        response = await auth.authFetch(details.url);
    } catch (e) {
        return writeErrorPage(details, 0, "Could not load the resource", (e && e.message) || String(e));
    }
    if (!response.ok) {
        let detail = "";
        try {
            detail = (await response.text()).slice(0, 600);
        } catch (ignored) {
        }
        return writeErrorPage(details, response.status, response.statusText, detail);
    }
    // Prefer the real resource's own content-type now that we have it; the
    // format/encoding guessed from the 401 challenge may not match the resource.
    const contentType = response.headers.get("Content-Type") || "";
    const resolvedFormat = getFormats().find(f => contentType.includes(f)) || format;
    const charset = contentType.split("charset=")[1];
    return await rewriteResponse(cl, details, charset || encoding, resolvedFormat, false, response);
}

/**
 * Replace a response body with the given HTML by writing it into an already
 * attached stream filter, and return the html response headers to commit the
 * navigation at the real URL. Writes on the first filter event (onstart or
 * onstop) and exactly once: relying on onstop alone can leave a blank page if
 * the original response delivers no body or the event timing shifts under a
 * slow/retried upstream. The original body is never forwarded, so the HTML
 * fully replaces it.
 */
function respondWithHtml(filter, html) {
    const encoder = new TextEncoder();
    let written = false;
    const writeOnce = () => {
        if (written)
            return;
        written = true;
        filter.write(encoder.encode(html));
        filter.close();
    };
    filter.onstart = writeOnce;
    filter.onstop = writeOnce;
    filter.onerror = () => {
    };
    return {
        responseHeaders: [
            {name: "Content-Type", value: "text/html; charset=utf-8"},
            {name: "Cache-Control", value: "no-cache, no-store, must-revalidate"},
            {name: "Pragma", value: "no-cache"},
            {name: "Expires", value: "0"}
        ]
    };
}

/**
 * Render a styled error page for the current main_frame request by writing it
 * into the response stream filter (so the navigation commits at the real URL).
 */
function writeErrorPage(details, status, statusText, detail) {
    const filter = browser.webRequest.filterResponseData(details.requestId);
    const html = buildErrorPage(details.url, status, statusText, detail);
    return respondWithHtml(filter, html);
}

/**
 * Build a self-contained, minimal-flat error page (no external script) for an
 * HTTP/network failure on a protected resource, with a Log in action for
 * 401/403 and a Refresh link. Rendered in place at the resource's URL.
 */
function buildErrorPage(url, status, statusText, detail) {
    const phrases = {
        401: "Unauthorized — authentication is required.",
        403: "Forbidden — you are authenticated, but not authorized to access this resource.",
        404: "Not Found — the resource does not exist.",
        500: "Internal Server Error.",
        502: "Bad Gateway.",
        503: "Service Unavailable."
    };
    const reason = statusText || phrases[status] || "The resource could not be retrieved.";
    const statusLine = status ? ("HTTP " + status + " — " + reason) : reason;
    const esc = s => String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const loginUrl = browser.runtime.getURL(templatePath) + "?auth=1&url=" + encodeURIComponent(url);
    const loginBtn = (status === 401 || status === 403)
        ? '<a class="rdfb-btn rdfb-btn-primary" href="' + esc(loginUrl) + '">'
        + (status === 403 ? "Log in as a different identity" : "Log in") + "</a>"
        : "";
    const detailBlock = detail ? ('<pre class="rdfb-detail">' + esc(detail) + "</pre>") : "";
    return "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"UTF-8\">"
        + "<title>RDF Browser — Error</title><style>"
        + ":root{color-scheme:light}"
        + pagestyle.PAGE_CSS
        + "a.rdfb-url{color:#2563eb;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;"
        + "font-size:.95em;word-break:break-all}"
        + "</style></head><body><div class=\"rdfb-wrap\">"
        + "<h1>This resource couldn’t be displayed</h1>"
        + "<p class=\"rdfb-muted\">RDF Browser could not render <a class=\"rdfb-url\" href=\"" + esc(url) + "\">"
        + esc(url) + "</a>.</p>"
        + "<p>" + esc(statusLine) + "</p>"
        + detailBlock
        + "<div class=\"rdfb-actions\">" + loginBtn
        + "<a class=\"rdfb-btn\" href=\"" + esc(url) + "\">Refresh</a></div>"
        + "</div></body></html>";
}

/**
 * Rewrite the HTTP response (background script) or redirect to the html template (content script)
 * @param prefetched An already-fetched Response whose body should be rendered
 *   in place of the original response (used to render a protected resource from
 *   an authenticated fetch, discarding the original 401 body). null otherwise.
 */
async function rewriteResponse(cl, details, encoding, format, redirect, prefetched = null) {
    const responseHeaders = [
        {name: "Content-Type", value: "text/html; charset=utf-8"},
        {name: "Cache-Control", value: "no-cache, no-store, must-revalidate"},
        {name: "Content-Length", value: cl ? cl.value : "0"},
        {name: "Pragma", value: "no-cache"},
        {name: "Expires", value: "0"}
    ];
    let url = details.url;
    if (redirect) {
        const location = details.responseHeaders.find(h => h.name.toLowerCase() === "location");
        // Location may be a relative reference (RFC 7231 §7.1.2); resolve it
        // against the request URL, otherwise fetch() below would resolve it
        // against the extension origin and never reach the origin server.
        url = location ? new URL(location.value, details.url).href : details.url;
    }
    const filter = browser.webRequest.filterResponseData(details.requestId);
    let stream;
    // We read from a getReader() (rather than the in-flight filter) when the
    // body comes from a separate fetch: a cross-URL redirect, or an already
    // fetched authenticated response (whose original 401 body we discard).
    const fromReader = !!prefetched || (redirect && url !== details.url);
    if (prefetched) {
        const body = await prefetched.body;
        stream = body.getReader();
    } else if (redirect && url !== details.url) {
        let response;
        try {
            // Retry transient Cloudflare throttling (429/503) with backoff and a
            // per-attempt timeout, so a redirected RDF lookup recovers instead of
            // hanging or going blank.
            response = await withRetry((u, n) => fetch(u, n))(url);
        } catch (e) {
            // The filter is already attached; write an error page into it rather
            // than closing it empty (a blank tab) or leaving the navigation hung.
            return respondWithHtml(filter, buildErrorPage(url, 0, "Could not load the resource", (e && e.message) || String(e)));
        }
        if (!response.ok) {
            let detail = "";
            try {
                detail = (await response.text()).slice(0, 600);
            } catch (ignored) {
            }
            return respondWithHtml(filter, buildErrorPage(url, response.status, response.statusText, detail));
        }
        const body = await response.body;
        stream = body.getReader();
    } else
        stream = filter;
    let decoder;
    try {
        decoder = new TextDecoder(encoding);
    } catch (e) {
        console.error("The RDF document is encoded in an unsupported format and can hence not be displayed:\n" + e);
        return {};
    }
    const encoder = new TextEncoder();
    // The base IRI of a document never includes a fragment (RFC 3986 §3.5).
    // Firefox keeps the #fragment in details.url for fragment navigations, so
    // strip it here: otherwise a self-reference (e.g. <…#it> in a document
    // whose IRI is <…#it>) would compare equal to the base and be rendered
    // with an empty href, dropping the fragment when clicked.
    const baseIRI = url.toString().split("#")[0];
    // processRDFPayload reads via a .read() loop when given a getReader(), and
    // via filter on/ondata events otherwise; fromReader selects the right path.
    processRDFPayload(stream, fromReader, decoder, format, baseIRI).then(output => {
        filter.write(encoder.encode(output));
        filter.close();
    })
        .catch(e => {
            // Malformed RDF (or an unsupported encoding): show the shared error
            // page instead of a blank document.
            const html = buildErrorPage(baseIRI, 0, "Could not parse the RDF document", (e && e.message) ? e.message : String(e));
            filter.write(encoder.encode(html));
            filter.close();
        });
    return {
        responseHeaders: responseHeaders
    };
}

/**
 * Return the modified accept header as a string
 * @returns {string} The modified accept header
 */
function getNewAcceptHeader(oldHeader, uri = "") {
    let newHeader = "";
    for (const f of getFormats(uri))
        newHeader += f + ";q=1,";
    for (let f of oldHeader.split(",")) {
        let q = 1.0;
        let arr = f.split(";q=");
        if (arr.length > 1) {
            q = parseFloat(arr[1]);
            f = arr[0];
        }
        q -= .05;
        q = (q < 0 ? .0 : q);
        newHeader += f + ";q=" + q.toFixed(3) + ",";
    }
    newHeader = newHeader.substring(0, newHeader.length - 1);
    return newHeader;
}

/**
 * Parse the RDF payload and render it as HTML document using the serializer
 * @param stream The response stream
 * @param redirect Flag whether the response stream is result of fetch() or filterResponseData()
 * @param decoder The decoder for the response stream
 * @param format The serialization format of the RDF resource
 * @param baseIRI The IRI of the RDF document
 * @returns The HTML payload as string (in background script mode only)
 */
async function processRDFPayload(stream, redirect, decoder, format, baseIRI) {
    const triplestore = await parser.obtainTriplestore(stream, redirect, decoder, format, baseIRI);
    let template = await getTemplate();
    template = await utils.injectScript(template, styleScriptPath);
    return createDocument(template, triplestore);

    function getTemplate() {
        return new Promise(resolve => {
            fetch(templatePath)
                .then(file => {
                    return file.text();
                })
                .then(text => {
                    resolve(text);
                })
        });
    }

    function createDocument(html, store) {
        const document = new DOMParser().parseFromString(html, "text/html");
        document.getElementById("title").innerText = baseIRI;
        document.getElementById("content-script").remove();
        document.getElementById("script").removeAttribute("src");
        document.getElementById("main").setAttribute("style",
            "position: static; height: 100%; margin: 0 auto;");
        const scriptElement = document.getElementById("script");
        const scriptString = JSON.stringify(options.allStyleTemplate[options.allStyleTemplate.selected]);
        const script = "\nconst style = " + scriptString + ";\n";
        scriptElement.insertBefore(document.createTextNode(script), scriptElement.firstChild);
        document.getElementById("prefixes").appendChild(serializer.serializePrefixes(store));
        document.getElementById("triples").appendChild(serializer.serializeTriples(store));
        return new XMLSerializer().serializeToString(document);
    }
}

/**
 * Intercept the Solid-OIDC redirect (a navigation to the identity API redirect
 * URL, https://<id>.extensions.allizom.org/, which does not resolve). On a
 * successful authorization, complete the token exchange IN THE BACKGROUND (so
 * the session + DPoP key stay in the persistent background page), then navigate
 * the originating tab to the requested resource; meanwhile park the defunct
 * redirect navigation on a lightweight "completing login" page. On an error,
 * bounce to the login screen with the error details.
 *
 * This is a blocking onBeforeRequest listener, so it cannot await the async
 * exchange and still return a redirect synchronously — it fires completeLogin()
 * and returns the spinner redirect immediately.
 * @param details The details of the intercepted request
 * @returns {{redirectUrl: string}|{}} A redirect, or {}
 */
function loginErrorUrl(target, errorDescription) {
    let u = browser.runtime.getURL(templatePath) + "?auth=1";
    if (target)
        u += "&url=" + encodeURIComponent(target);
    u += "&error=" + encodeURIComponent("login_failed");
    if (errorDescription)
        u += "&error_description=" + encodeURIComponent(errorDescription);
    return u;
}

function interceptAuthRedirect(details) {
    const url = new URL(details.url);
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    if (!code && !error)
        return {};
    if (code) {
        auth.completeLogin(details.url).then(result => {
            const tabId = (result && result.tabId != null) ? result.tabId : details.tabId;
            if (result && result.isLoggedIn && result.target) {
                browser.tabs.update(tabId, {url: result.target});
            } else if (result && result.isLoggedIn) {
                // Logged in but the target was lost (e.g. background restarted
                // mid-login); land on a neutral "logged in" page instead of
                // leaving the spinner up forever.
                browser.tabs.update(tabId, {url: browser.runtime.getURL(templatePath) + "?auth=loggedin"});
            } else {
                // Token exchange failed (e.g. an expired code, or a 429 from the
                // IdP under rate limiting). Show the login screen with the error
                // rather than a stuck spinner.
                browser.tabs.update(tabId, {url: loginErrorUrl(result && result.target, result && result.error)});
            }
        }).catch(e => {
            browser.tabs.update(details.tabId, {url: loginErrorUrl(null, (e && e.message) ? e.message : String(e))});
        });
        return {redirectUrl: browser.runtime.getURL(templatePath) + "?auth=complete"};
    }
    let target = browser.runtime.getURL(templatePath) + "?auth=1";
    target += "&error=" + encodeURIComponent(error);
    const desc = url.searchParams.get("error_description");
    if (desc)
        target += "&error_description=" + encodeURIComponent(desc);
    return {redirectUrl: target};
}

/**
 * Add the listeners for modifying HTTP request and response headers and for showing the page action button
 */
function addListeners() {
    browser.storage.onChanged.addListener(() => {
        utils.getOptions().then(res => options = res);
    });
    utils.getOptions().then(res => {
        options = res;
        browser.webRequest.onBeforeSendHeaders.addListener(modifyRequestHeader, filter, ["blocking", "requestHeaders"]);
        browser.webRequest.onHeadersReceived.addListener(modifyResponseHeader, filter, ["blocking", "responseHeaders"]);
        try {
            const redirectBase = browser.identity.getRedirectURL();
            browser.webRequest.onBeforeRequest.addListener(
                interceptAuthRedirect,
                {urls: [redirectBase + "*"], types: ["main_frame"]},
                ["blocking"]
            );
        } catch (e) {
            console.warn("Could not register Solid auth redirect interceptor:", e);
        }
    });
}

module.exports = {
    addListeners
}
