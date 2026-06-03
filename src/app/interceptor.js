const browser = window.browser;
const parser = require("./parser");
const serializer = require("./serializer");
const utils = require('./utils');
const auth = require('./auth');
const styleScriptPath = "build/controller/style.js";
const errorScriptPath = "build/controller/error.js";
const templatePath = "build/view/template.html";
const filter = {
    urls: ["<all_urls>"]
};
const requests = {};
let acceptHeader = "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8";
let options;
let conformanceEvaluation = false;
let performanceEvaluation = false;
let conformanceOffset = 1;
let conformanceData = {};

function getRequestDetails(tabId) {
    return requests[tabId];
}

function getFormats(considerOptions = true, uri = "") {
    const formats = [];
    if ((!considerOptions || options.json) && !uri.includes("://dbpedia.org"))
        formats.push("application/ld+json");
    if (!considerOptions || options.n4)
        formats.push("application/n-quads");
    if (!considerOptions || options.nt)
        formats.push("application/n-triples");
    if (!considerOptions || options.xml)
        formats.push("application/rdf+xml");
    if (!considerOptions || options.trig)
        formats.push("application/trig");
    if (!considerOptions || options.ttl)
        formats.push("text/turtle");
    if (!considerOptions || options.n3)
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

function setConformanceEvaluation(value) {
    conformanceEvaluation = value;
    if (!value)
        conformanceData = {};
}

function getConformanceData() {
    return conformanceData;
}

function setPerformanceEvaluation(value) {
    performanceEvaluation = value;
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
            acceptHeader = getNewAcceptHeader(headerField.value, true, details.url);
            headerField.value = acceptHeader;
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
    if (conformanceEvaluation) {
        if (conformanceOffset === 1)
            conformanceOffset -= details.tabId;
        if (!conformanceData.hasOwnProperty((details.tabId + conformanceOffset).toString()))
            conformanceData[details.tabId + conformanceOffset] = {
                number: details.tabId + conformanceOffset,
                uri: details.url,
                turtle: null
            };
    }
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
 * Render a styled error page for the current main_frame request by writing it
 * into the response stream filter (so the navigation commits at the real URL).
 */
function writeErrorPage(details, status, statusText, detail) {
    const filter = browser.webRequest.filterResponseData(details.requestId);
    const encoder = new TextEncoder();
    const html = buildErrorPage(details.url, status, statusText, detail);
    // Write at onstop so the filter is connected; the original (401) body is
    // received but not forwarded, so our HTML fully replaces it.
    filter.onstop = () => {
        filter.write(encoder.encode(html));
        filter.close();
    };
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
        + "body{margin:0;background:#fff;color:#1b1b1b;line-height:1.55;"
        + "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}"
        + ".wrap{max-width:40rem;margin:0 auto;padding:3rem 1.5rem}"
        + "h1{font-size:1.35rem;font-weight:600;margin:0 0 1rem;padding-bottom:.6rem;border-bottom:1px solid #e6e6e6}"
        + "p{margin:1rem 0}.muted{color:#5c5c5c}"
        + "a.rdfb-url{color:#2563eb;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;"
        + "font-size:.95em;word-break:break-all}"
        + ".rdfb-detail{background:#f6f6f6;border:1px solid #ececec;border-radius:6px;padding:.8rem;overflow:auto;"
        + "white-space:pre-wrap;word-break:break-word;"
        + "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.85rem}"
        + ".rdfb-actions{display:flex;gap:.6rem;flex-wrap:wrap;margin-top:1.5rem}"
        + ".rdfb-btn{font:inherit;cursor:pointer;text-decoration:none;display:inline-block;"
        + "padding:.55rem 1.1rem;border-radius:6px;border:1px solid #ccc;background:#fff;color:#1b1b1b}"
        + ".rdfb-btn:hover{background:#f4f4f4}"
        + ".rdfb-btn-primary{background:#2563eb;color:#fff;border-color:transparent}"
        + ".rdfb-btn-primary:hover{background:#1d4ed8}"
        + "</style></head><body><div class=\"wrap\">"
        + "<h1>This resource couldn’t be displayed</h1>"
        + "<p class=\"muted\">RDF Browser could not render <a class=\"rdfb-url\" href=\"" + esc(url) + "\">"
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
    // Authenticated rendering always runs in the background (the session lives
    // there); the content-script template redirect can't reach it.
    if (options.contentScript && !prefetched) {
        const req = requests[details.tabId];
        req.url = url;
        req.encoding = encoding;
        req.format = format;
        req.crawl = options.quickOptions.crawler;
        return {
            responseHeaders: responseHeaders,
            redirectUrl: browser.runtime.getURL(templatePath
                + "?url=" + encodeURIComponent(req.url)
                + "&encoding=" + encodeURIComponent(encoding)
                + "&format=" + encodeURIComponent(format)
            )
        };
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
            response = await fetch(url);
        } catch (e) {
            // Closing the filter is essential: returning while it is still
            // attached leaves the original response stream open and the tab
            // hangs until it times out.
            filter.close();
            return {};
        }
        if (!response.ok) {
            filter.close();
            return {};
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
    const baseIRI = url.toString();
    // processRDFPayload reads via a .read() loop when given a getReader(), and
    // via filter on/ondata events otherwise; fromReader selects the right path.
    processRDFPayload(stream, fromReader, decoder, format, baseIRI).then(output => {
        if (conformanceEvaluation) {
            const html = new DOMParser().parseFromString(output, 'text/html');
            conformanceData[details.tabId + conformanceOffset].turtle = html.body.textContent;
        }
        filter.write(encoder.encode(output));
        filter.close();
    })
        .catch(e => {
            handleError(e).then(document => {
                filter.write(encoder.encode(document.toString()));
                filter.close();
            });
        });
    return {
        responseHeaders: responseHeaders
    };

    async function handleError(error) {
        const file = await fetch("build/view/error.html");
        let text = await file.text();
        text = await utils.injectScript(text, errorScriptPath);
        const document = new DOMParser().parseFromString(text.toString(), "text/html");
        document.title = baseIRI;
        document.getElementById("script").removeAttribute("src");
        const url = document.createTextNode(baseIRI);
        document.getElementById("url").setAttribute("href", baseIRI);
        document.getElementById("url").appendChild(url);
        const message = document.createTextNode(error.toString());
        document.getElementById("message").appendChild(message);
        return new XMLSerializer().serializeToString(document);
    }
}

/**
 * Return the modified accept header as a string
 * @returns {string} The modified accept header
 */
function getNewAcceptHeader(oldHeader, considerOptions = true, uri = "") {
    let newHeader = "";
    for (const f of getFormats(considerOptions, uri))
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
 * Fetch an RDF document as response to a content script request and return the triplestore
 * @param url The URI of the document to fetch
 * @param store The metaTriplestore
 * @param baseTriplestore The triplestore of the base document (if any)
 * @param encoding The encoding of the document to fetch
 * @param format The format of the document to fetch
 */
async function fetchDocument(url, store, baseTriplestore, encoding = null, format = null) {
    const accept = getNewAcceptHeader(acceptHeader, false);
    const request = new Request(url, {
        headers: new Headers({
            'Accept': accept
        })
    });
    try {
        let response;
        if (baseTriplestore !== null)
            response = await Promise.race([
                auth.authFetch(request, {
                    credentials: "omit"
                }),
                new Promise(resolve => setTimeout(() => resolve("timeout"), 2500))
            ]);
        else
            response = await auth.authFetch(request);
        if (baseTriplestore !== null && response === "timeout")
            return "timeout";
        if (baseTriplestore !== null && !response.ok)
            return response.status;
        if (baseTriplestore === null && !response.ok) {
            // The (possibly authenticated) main-document request returned an
            // HTTP error. Rather than rendering the server's error graph (e.g.
            // CSS's ForbiddenHttpError triples) as if it were the resource,
            // surface a structured error so the page can show a clear message
            // and, for 401, offer to (re-)authenticate.
            let detail = "";
            try {
                detail = (await response.text()).slice(0, 1000);
            } catch (ignored) {
            }
            return {
                httpError: response.status,
                statusText: response.statusText || "",
                url: url,
                detail: detail
            };
        }
        if (encoding === null)
            encoding = response.headers.get("Encoding") || "utf-8";
        if (format === null)
            format = (response.headers.get("Content-type").split(";"))[0];
        if (baseTriplestore !== null && !getFormats(false).includes(format))
            return format;
        if (baseTriplestore === null) {
            const server = response.headers.get("Server") || "unknown";
            document.getElementById("#server").appendChild(document.createTextNode(server));
            document.getElementById("#ctype").appendChild(document.createTextNode(format));
            const contentLength = response.headers.get("Content-Length") || "unknown";
            document.getElementById("#clen").appendChild(document.createTextNode(contentLength));
        }
        response = await response.body;
        if (baseTriplestore === null)
            return await parser.obtainTriplestore(response.getReader(), false, new TextDecoder(encoding), format, true, url);
        else
            return await parser.obtainDescriptions(response.getReader(), new TextDecoder(encoding), format, url, store, baseTriplestore);
    } catch (ignored) {
        if (baseTriplestore !== null)
            return "error";
        else
            return ignored.message;
    }
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
    const triplestore = await parser.obtainTriplestore(stream, redirect, decoder, format, false, baseIRI);
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
        if (performanceEvaluation)
            document.getElementById("title").innerText = triplestore.triples;
        else
            document.getElementById("title").innerText = baseIRI;
        document.getElementById("content-script").remove();
        document.getElementById("script").removeAttribute("src");
        document.getElementById("header").remove();
        document.getElementById("aside").remove();
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
        browser.webNavigation.onCommitted.addListener(details => {
            if (options.quickOptions.pageAction)
                browser.pageAction.show(details.tabId);
        });
    });
}

module.exports = {
    addListeners,
    fetchDocument,
    acceptHeader,
    getRequestDetails,
    setPerformanceEvaluation,
    setConformanceEvaluation,
    getConformanceData
}
