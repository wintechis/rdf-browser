const browser = window.browser;
const interceptor = require("./interceptor");
const serializer = require("./serializer");
const parser = require("./parser");
const ts = require("../bdo/triplestore");
let triplestore, options;
let reqUri, uri, baseURI, contentType;
let editMode = false, crawlerEnabled;

async function init() {
    options = (await browser.storage.sync.get("options")).options;
    const params = new URL(location.href).searchParams;
    const authParam = params.get("auth");
    if (authParam === "1" || authParam === "complete" || authParam === "loggedin")
        return initAuth(params);
    return initNormal(params);
}

/**
 * Normal rendering: fetch and display the RDF document referenced by the URL
 * parameters (set when the response interceptor redirects here).
 */
async function initNormal(params) {
    const tabId = (await browser.tabs.getCurrent()).id;
    const requestDetails = await browser.runtime.sendMessage(["requestDetails", tabId.toString()]);
    if (requestDetails === undefined) {
        reqUri = decodeURIComponent(params.get("url"));
        uri = reqUri;
    } else {
        reqUri = requestDetails.reqUrl ? requestDetails.reqUrl : decodeURIComponent(params.get("url"));
        uri = decodeURIComponent(params.get("url"));
    }
    crawlerEnabled = options.quickOptions.crawler;
    const encoding = params.has("encoding") ? decodeURIComponent(params.get("encoding")) : null;
    const format = params.has("format") ? decodeURIComponent(params.get("format")) : null;
    await loadContent(encoding, format);
    await crawl();
}

/**
 * Auth mode. The Solid session lives in the background page now, so this page
 * is only the login UI:
 *  - ?auth=complete : a spinner shown while the background completes the token
 *    exchange and then navigates this tab to the requested resource.
 *  - ?auth=1        : the login screen for a protected resource (the resource
 *    is in ?url=). On submit, the background runs the login and navigates this
 *    tab; once logged in, the resource renders in place at its real URL via the
 *    background (no further visit to this page).
 */
async function initAuth(params) {
    const authParam = params.get("auth");
    if (authParam === "complete") {
        showAuthLoading("Completing login…");
        return;
    }
    if (authParam === "loggedin") {
        // Logged in, but no resource to open (target was lost). Not an error.
        document.getElementById("title").innerText = "RDF Browser";
        document.getElementById("status").innerText = "logged in";
        return;
    }
    const target = params.has("url") ? decodeURIComponent(params.get("url")) : null;
    if (params.get("error")) {
        const desc = params.get("error_description");
        const message = (params.get("error") === "login_failed")
            ? (desc || "The login did not complete. Please try again.")
            : ("The identity provider returned an error: " + params.get("error") + (desc ? " - " + desc : ""));
        renderLoginScreen(target, message);
        return;
    }
    renderLoginScreen(target, null);
}

/**
 * Show a spinner with a message in the header status area while the
 * authenticated resource is being fetched after login. Leaves #main (and its
 * #prefixes / #triples targets) intact so loadContent can render into them;
 * loadContent overwrites the status text once it reaches serialization.
 */
function showAuthLoading(message) {
    ensureSpinnerStyle();
    const status = document.getElementById("status");
    while (status.firstChild)
        status.firstChild.remove();
    const spinner = document.createElement("span");
    spinner.setAttribute("class", "solid-spinner");
    const text = document.createElement("span");
    text.setAttribute("style", "margin-left: .5em;");
    text.innerText = message;
    status.appendChild(spinner);
    status.appendChild(text);
}

/**
 * Inject the spinner keyframes once (the template stylesheet has none).
 */
function ensureSpinnerStyle() {
    if (document.getElementById("#solid-spin-style"))
        return;
    const spinStyle = document.createElement("style");
    spinStyle.setAttribute("id", "#solid-spin-style");
    spinStyle.appendChild(document.createTextNode(
        "@keyframes solid-spin{to{transform:rotate(360deg)}}" +
        ".solid-spinner{display:inline-block;width:1em;height:1em;vertical-align:-0.15em;" +
        "border:2px solid currentColor;border-right-color:transparent;border-radius:50%;" +
        "animation:solid-spin 0.7s linear infinite;}"));
    document.head.appendChild(spinStyle);
}

/**
 * Render a Solid login prompt (issuer pre-filled, editable) for a protected
 * resource. On submit, the redirect-based login flow is started.
 * @param target The protected resource URL to render after login
 * @param errorMessage Optional message to show (e.g. a prior failed attempt)
 */
function renderLoginScreen(target, errorMessage) {
    document.getElementById("title").innerText = "Solid login required";
    const main = document.getElementById("main");
    while (main.firstChild)
        main.firstChild.remove();
    main.removeAttribute("style");

    ensureSpinnerStyle();

    const container = document.createElement("div");
    container.setAttribute("style", "padding: 2em; max-width: 44em; font-family: sans-serif; line-height: 1.4;");

    const heading = document.createElement("h2");
    heading.appendChild(document.createTextNode("Authentication required"));
    container.appendChild(heading);

    const intro = document.createElement("p");
    intro.appendChild(document.createTextNode("The resource "));
    const code = document.createElement("code");
    code.appendChild(document.createTextNode(target || "(unknown)"));
    intro.appendChild(code);
    intro.appendChild(document.createTextNode(" requires a Solid login. Enter your Solid identity provider and log in."));
    container.appendChild(intro);

    const label = document.createElement("label");
    label.appendChild(document.createTextNode("Identity provider: "));
    const input = document.createElement("input");
    input.setAttribute("type", "text");
    input.setAttribute("value", "https://solidcommunity.net");
    input.setAttribute("style", "width: 24em; margin-right: .5em;");
    label.appendChild(input);
    container.appendChild(label);

    const button = document.createElement("button");
    button.appendChild(document.createTextNode("Log in"));
    container.appendChild(button);

    // Inline progress indicator shown while the login flow is running.
    const progress = document.createElement("p");
    progress.setAttribute("style", "margin-top: 1em;");
    progress.setAttribute("hidden", "hidden");
    const spinner = document.createElement("span");
    spinner.setAttribute("class", "solid-spinner");
    const progressText = document.createElement("span");
    progressText.setAttribute("style", "margin-left: .6em;");
    progress.appendChild(spinner);
    progress.appendChild(progressText);
    container.appendChild(progress);

    const error = document.createElement("p");
    error.setAttribute("style", "color: darkred;");
    container.appendChild(error);

    function showProgress(message) {
        progressText.innerText = message;
        progress.removeAttribute("hidden");
        document.getElementById("status").innerText = message;
    }

    function hideProgress(statusMessage) {
        progress.setAttribute("hidden", "hidden");
        document.getElementById("status").innerText = statusMessage;
    }

    async function submit() {
        button.setAttribute("disabled", "disabled");
        input.setAttribute("disabled", "disabled");
        error.innerText = "";
        showProgress("Redirecting to identity provider…");
        // The background owns the session: it runs the login and navigates THIS
        // tab to the IdP (via sender.tab.id). The spinner stays up until the
        // page unloads. A failure before navigation comes back as {ok:false}.
        const result = await browser.runtime.sendMessage(["startLogin", input.value.trim(), target]);
        if (result && result.ok === false) {
            error.innerText = "Login failed: " + (result.error || "unknown error");
            button.removeAttribute("disabled");
            input.removeAttribute("disabled");
            hideProgress("login required");
        }
    }

    button.addEventListener("click", submit);
    input.addEventListener("keypress", event => {
        if (event.key === "Enter")
            submit();
    });

    if (errorMessage)
        error.innerText = errorMessage;

    main.appendChild(container);
    document.getElementById("status").innerText = "login required";
}

/**
 * Redirect to the shared error page for an HTTP error response, passing the
 * status so the error page can offer a (re-)login button for 401/403.
 * @param info {{httpError:number, statusText:string, url:string, detail:string}}
 */
function renderHttpError(info) {
    // Log the full error context so the fetched URL / server status / response
    // body are visible in the Browser Console even if the on-page URI is empty.
    const phrases = {
        401: "Unauthorized — authentication is required to access this resource.",
        403: "Forbidden — you are authenticated, but not authorized to access this resource.",
        404: "Not Found — the resource does not exist.",
        500: "Internal Server Error.",
        502: "Bad Gateway.",
        503: "Service Unavailable."
    };
    const reason = info.statusText || phrases[info.httpError] || "The resource could not be retrieved.";
    const message = "HTTP " + info.httpError + " — " + reason;
    const sendUrl = browser.runtime.getURL("build/view/error.html?url=")
        + encodeURIComponent(info.url)
        + "&httpStatus=" + encodeURIComponent(info.httpError)
        + "&message=" + encodeURIComponent(message);
    window.location.replace(sendUrl);
}

async function loadContent(encoding, format) {
    contentType = format;
    document.getElementById("title").innerText = reqUri;
    document.getElementById("#navbar").setAttribute("value", reqUri);
    document.getElementById("#navbar").addEventListener("focusin", event => event.target.select());
    document.getElementById("#navbar").addEventListener("keypress", event => {
        if (event.key === "Enter")
            navigate();
    });
    document.getElementById("#navButton").addEventListener("click", navigate);
    document.getElementById("#editButton").addEventListener("click", handleEdit);
    const urlElement = document.createElement("a");
    baseURI = uri.split("#")[0];
    urlElement.setAttribute("href", reqUri);
    urlElement.appendChild(document.createTextNode(reqUri));
    document.getElementById("#uri").appendChild(urlElement);

    try {
        triplestore = await interceptor.fetchDocument(uri, null, null, encoding, format);
        if (triplestore && typeof triplestore === "object" && triplestore.httpError) {
            renderHttpError(triplestore);
            return;
        }
        if (typeof triplestore === "string") {
            handleError(triplestore);
            return;
        }
        document.getElementById("status").innerText = "serializing triples...";
        serializer.serializePrefixes(triplestore, document.getElementById("prefixes"));
        serializer.serializeTriples(triplestore, document.getElementById("triples"));
        document.querySelectorAll(".uri a,.postfix a").forEach(element => {
            element.addEventListener("mouseover", showDescription);
        });
        const fragment = (uri.includes("#") ? uri.split("#")[1] : null);
        if (fragment !== null && fragment.length > 0)
            window.location.replace("#" + fragment);
        browser.webNavigation.onReferenceFragmentUpdated.addListener(details => {
            const val = details.url.split("#");
            if (val.length === 2)
                document.getElementById("#navbar").setAttribute("value", baseURI + '#' + val[1]);
            else
                document.getElementById("#navbar").setAttribute("value", baseURI);
        });
        document.getElementById("#editButton").removeAttribute("disabled");
        await updateSolidSessionUI();
    } catch (e) {
        handleError(e);
    }

    function handleError(e) {
        const sendUrl = browser.runtime.getURL("build/view/error.html?url=")
            + encodeURIComponent(uri) + "&message=" + encodeURIComponent(e);
        window.location.replace(sendUrl);
    }
}

/**
 * Show the WebID and a "Log out" button in the page header when a Solid session
 * is active; hide both otherwise. Logging out clears the session and reloads
 * the current resource (which will prompt for login again if it is protected).
 */
async function updateSolidSessionUI() {
    const sessionElement = document.getElementById("#solidSession");
    const logoutElement = document.getElementById("#solidLogout");
    if (!sessionElement || !logoutElement)
        return;
    // The session lives in the background page; query it via a message.
    const status = await browser.runtime.sendMessage(["sessionStatus"]);
    if (!status || !status.isLoggedIn) {
        sessionElement.setAttribute("hidden", "hidden");
        logoutElement.setAttribute("hidden", "hidden");
        return;
    }
    const webId = status.webId || "";
    sessionElement.innerText = "🔓";
    sessionElement.setAttribute("title", "Logged in as " + webId);
    sessionElement.removeAttribute("hidden");
    logoutElement.removeAttribute("hidden");
    logoutElement.addEventListener("click", async () => {
        logoutElement.setAttribute("disabled", "disabled");
        await browser.runtime.sendMessage(["logout"]);
        // Reload the resource: a protected one will return 401 and re-prompt.
        window.location.replace(reqUri || uri);
    });
}

async function crawl() {
    if (typeof triplestore === "string")
        return;
    const stopButton = document.createElement("button");
    document.getElementById("status").parentElement.appendChild(stopButton);
    stopButton.setAttribute("id", "#stopButton");
    stopButton.innerText = "stop";
    stopButton.addEventListener("click", () => stopCrawler());
    document.getElementById("#editButton").addEventListener("click", () => stopCrawler());
    let nonHttpCount = 0, rdfCount = 0, brokenCount = 0;
    let ldp4 = false;
    document.getElementById("status").innerText = "crawling documents";
    showDescription(null, uri.replace("https://", "http://"));
    const uris = [baseURI.split('#')[0]];
    for (const prefix of triplestore.prefixes) {
        if (prefix.used)
            addURI(prefix.value);
    }
    let baseUriContained = false, reqUriContained = false;
    for (const u in triplestore.uris) {
        if (u.replace("https://", "http://").split('#')[0] === baseURI.replace("https://", "http://").split('#')[0])
            baseUriContained = true;
        if (u.replace("https://", "http://").split('#')[0] === reqUri.replace("https://", "http://").split('#')[0])
            reqUriContained = true;
        addURI(triplestore.uris[u]);
    }
    let numberOfCrawls = 0;
    const crawls = [[]];
    const nonHttpUris = [];
    const hashLinks = document.querySelectorAll("a[href^=\'#\']");
    for (const link of hashLinks)
        markURI((baseURI.endsWith('#') ? baseURI : (baseURI + "#")) + link.getAttribute("href").substring(1), link, "color: #00A000;");
    for (const uri of uris) {
        if (!uri.startsWith("http")) {
            if (!nonHttpUris.includes(uri)) {
                nonHttpCount++;
                nonHttpUris.push(uri);
            }
            const links = document.querySelectorAll("a[href=\'" + uri + "\']");
            for (const link of links)
                link.setAttribute("style", "color: dimgray;");
            continue;
        }
        if (crawls[crawls.length - 1].length >= 3)
            crawls.push([]);
        crawls[crawls.length - 1].push(uri);
        numberOfCrawls++;
    }
    const allCount = baseUriContained ? numberOfCrawls : (numberOfCrawls - 1);
    if (allCount > 0)
        document.getElementById("#ldp1").setAttribute("class", "ldpFulfilled");
    else
        document.getElementById("#ldp1").setAttribute("class", "ldpNotFulfilled");
    if ((allCount - nonHttpCount) > 0)
        document.getElementById("#ldp2").setAttribute("class", "ldpFulfilled");
    else
        document.getElementById("#ldp2").setAttribute("class", "ldpNotFulfilled");
    if (reqUriContained)
        document.getElementById("#ldp3").setAttribute("class", "ldpFulfilled");
    else
        document.getElementById("#ldp3").setAttribute("class", "ldpNotFulfilled");
    document.getElementById("#links").innerText = allCount.toString();
    document.getElementById("#httplinks").innerText = (allCount - nonHttpCount).toString();
    document.getElementById("#rdflinks").innerText = rdfCount.toString();
    document.getElementById("#brokenlinks").innerText = brokenCount.toString();
    let crawlCount = 0;
    for (const crawl of crawls) {
        if (!crawlerEnabled)
            break;
        const uris = [];
        const arr = [];
        for (const uri of crawl) {
            uris.push(uri);
            arr.push(new Promise(resolve => {
                interceptor.fetchDocument(uri, triplestore, triplestore).then(resolve);
            }));
        }
        document.getElementById("status").innerText = "crawling documents... (" + crawlCount + "/" + numberOfCrawls + ")";
        const result = await Promise.all(arr);
        if (!crawlerEnabled)
            break;
        handleCrawlResults(uris.slice(0, 3), result, crawlCount);
        crawlCount += 3;
        if (!ldp4 && rdfCount > 1) {
            document.getElementById("#ldp4").setAttribute("class", "ldpFulfilled");
            ldp4 = true;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!ldp4)
        document.getElementById("#ldp4").setAttribute("class", "ldpNotFulfilled");
    ts.removeUnusedPrefixes(triplestore);

    stopButton.remove();
    document.getElementById("status").innerText = "ready";

    function addURI(uri) {
        const uriValue = uri.value.split('#')[0];
        if (uris.includes(uriValue))
            return;
        uris.push(uriValue);
    }

    function markURI(uri, link, style) {
        if (link !== null)
            link.setAttribute("style", style);
        if (triplestore.uris.hasOwnProperty(uri)) {
            const tsUri = triplestore.uris[uri];
            if (tsUri.html === null)
                tsUri.createHtml();
            const href = tsUri.html.querySelector("a");
            if (href && !href.hasAttribute("style"))
                href.setAttribute("style", style);
        } else if (link !== null)
            markURI(uri.startsWith("https://") ? uri.replace("https://", "http://") : uri.replace("http://", "https://"), null, style);
    }

    function handleCrawlResults(uris, results, count) {
        for (let i = 0; i < uris.length; ++i) {
            const links = document.querySelectorAll("a[href=\'" + uris[i] + "\']");
            let hashLinks = [];
            if (!uris[i].endsWith("#"))
                hashLinks = document.querySelectorAll("a[href^=\'" + uris[i] + "#\']");
            let style = "";
            if (typeof results[i] === "object") {
                style += "color: #00A000;";
                if (count > 0) {
                    rdfCount++;
                    document.getElementById("#rdflinks").innerText = rdfCount.toString();
                }
            } else if (results[i] === "timeout")
                style += "color: dimgray;";
            else if (results[i] === "error" || (typeof results[i] === "number" && results[i] >= 400)) {
                style += "color: red;";
                if (count > 0) {
                    brokenCount++;
                    document.getElementById("#brokenlinks").innerText = brokenCount.toString();
                }
            }
            for (const link of links)
                if (style !== "")
                    markURI(uris[i], link, style);
            for (const link of hashLinks)
                if (style !== "")
                    markURI(link.getAttribute("href"), link, style);
            count++;
        }
    }
}

async function stopCrawler() {
    if (!crawlerEnabled)
        return;
    const stopButton = document.getElementById("#stopButton");
    if (stopButton)
        stopButton.setAttribute("disabled", "disabled");
    crawlerEnabled = false;
    await new Promise(resolve => setTimeout(resolve, 500));
}

function showDescription(event, href = null) {
    if (event !== null) {
        const element = event.target;
        if (element.localName !== "a")
            return;
        href = element.getAttribute("href");
        if (href.startsWith('#'))
            href = (baseURI + href).replace("https://", "http://");
    }
    const uri = triplestore.uris[href];
    if (!uri)
        return;
    const refUri = document.getElementById("#ref-uri");
    while (refUri.firstElementChild)
        refUri.firstElementChild.remove();
    refUri.appendChild(uri.html);
    const refTriples = document.getElementById("#ref-triples");
    while (refTriples.firstElementChild)
        refTriples.firstElementChild.remove();
    serializer.serializeTriples(triplestore, refTriples, uri);
}

function navigate() {
    document.getElementById("#navButton").setAttribute("disabled", "disabled");
    let target = document.getElementById("#navbar").value;
    if (!target.startsWith("http"))
        target = "http://" + target;
    window.location.href = target;
}

async function handleEdit() {
    const main = document.getElementById("main");
    const status = document.getElementById("status");
    const navbarLabel = document.getElementById("#navbarLabel");
    const uploadMethodLabel = document.getElementById("#uploadMethodLabel");
    const uploadMethod = document.getElementById("#uploadMethod");
    const uploadFormatLabel = document.getElementById("#uploadFormatLabel");
    const uploadFormat = document.getElementById("#uploadFormat");
    const uploadURILabel = document.getElementById("#uploadURILabel");
    const uploadURI = document.getElementById("#uploadURI");
    const elements = document.querySelectorAll("main *");
    const editButton = document.getElementById("#editButton");
    const editStyle = "color: black !important; text-decoration: none !important;"
    const backgroundStyle = "background-color: #d8ecf3 !important;"
    if (!editMode) {
        await stopCrawler();
        for (const element of elements)
            element.setAttribute("style", (element.getAttribute("style") || "") + editStyle);
        editButton.removeAttribute("disabled");
        editButton.innerText = "Upload changes";
        navbarLabel.setAttribute("hidden", "hidden");
        uploadMethodLabel.removeAttribute("hidden");
        uploadFormatLabel.removeAttribute("hidden");
        for (const option of uploadFormat) {
            if (option.value.toLowerCase() === contentType.toLowerCase()) {
                option.setAttribute("selected", "selected");
                break;
            }
        }
        uploadURILabel.removeAttribute("hidden");
        uploadURI.setAttribute("value", uri);
        main.setAttribute("contenteditable", "true");
        main.setAttribute("style", (main.getAttribute("style") || "") + backgroundStyle);
        main.addEventListener("input", handleInput);
        status.innerText = "document editable";
    } else {
        for (const element of elements)
            if (element.hasAttribute("style"))
                element.setAttribute("style", element.getAttribute("style").replace(editStyle, ""));
        main.removeAttribute("contenteditable");
        main.setAttribute("style", main.getAttribute("style").replace(backgroundStyle, ""));
        navbarLabel.removeAttribute("hidden");
        uploadMethodLabel.setAttribute("hidden", "hidden");
        uploadFormatLabel.setAttribute("hidden", "hidden");
        uploadURILabel.setAttribute("hidden", "hidden");
        editButton.setAttribute("disabled", "disabled");
        status.removeAttribute("style");
        status.innerText = "uploading...";
        const success = await handleUpload();
        if (!success) {
            editMode = !editMode;
            await handleEdit();
            return;
        }
        editButton.innerText = "Edit document";
        editButton.removeAttribute("disabled");
        status.innerText = "ready";
        let redirectURI = baseURI;
        if (uploadMethod.value === "DELETE") {
            const split = uploadURI.value.split('/');
            redirectURI = redirectURI.substring(0, uploadURI.value.length - split[split.length - 1].length);
        } else if (["POST", "PUT"].includes(uploadMethod.value))
            redirectURI = uploadURI.value;
        window.location.replace(redirectURI);
    }
    editMode = !editMode;

    function handleInput() {
        const turtleString = document.getElementById("main").textContent.toString().trim();
        const status = document.getElementById("status");
        const error = parser.validateTurtle(turtleString, baseURI);
        if (!error) {
            status.setAttribute("style", "color: darkgreen;");
            status.innerText = "no syntax errors";
        } else {
            status.setAttribute("style", "color: darkred;");
            status.innerText = (error.toString().split("Error: "))[1];
        }
    }

    async function handleUpload() {
        const turtleString = document.getElementById("main").textContent.toString().trim();
        const error = parser.validateTurtle(turtleString, baseURI);
        if (error)
            return handleError(error, "parsing");
        const method = uploadMethod.value;
        const target = uploadURI.value;
        const format = uploadFormat.value;
        let body;
        try {
            body = await parser.convertTurtle(turtleString, baseURI, format);
        } catch (e) {
            return handleError(e, "parsing");
        }
        try {
            const response = await fetch(target, {
                method: method,
                headers: {
                    'Content-Type': format
                },
                body: body
            });
            if (response.status >= 400)
                return handleError(new Error("Server responded: " + response.status + " " + response.statusText), "uploading");
            return true;
        } catch (e) {
            return handleError(e, "uploading");
        }

        function handleError(e, activity) {
            alert("An error occurred when " + activity + " the document:\n\n" + e.message);
            return false;
        }
    }
}

module.exports = {init};
