const browser = window.browser;

/*
 * Thin wrapper around @inrupt/solid-client-authn-browser.
 *
 * The library is bundled statically (esbuild cannot code-split a dynamic
 * import() into the single iife background bundle). Under MV2 the background
 * page is itself a DOM page, so the whole session lifecycle runs THERE:
 * startLogin() begins the flow, completeLogin() does the token exchange, and
 * the resulting session (including its in-memory DPoP key) lives in the
 * persistent background page. Because that page survives across tab
 * navigations, session.fetch keeps working without re-authenticating — the
 * DPoP private key is never persisted by the library, so the session can only
 * be reused from the one context that created it.
 *
 * Session lifetime is "session only": a browser restart tears down the
 * background page (and main.js clears any leftover library storage on
 * start-up), so the user is effectively logged out on restart.
 */

const solidAuth = require("@inrupt/solid-client-authn-browser");
const {withRetry} = require("./retryFetch");

// In-memory record of an in-flight login: the resource to open afterwards and
// the tab that initiated it. Lives in the persistent background page, so it
// survives the IdP round-trip without needing storage.
let pendingLogin = null;

async function lib() {
    return solidAuth;
}

/**
 * Return {isLoggedIn, webId} for the background session.
 */
async function getStatus() {
    const {getDefaultSession} = await lib();
    const info = getDefaultSession().info;
    return {isLoggedIn: info.isLoggedIn, webId: info.webId || null};
}

/**
 * Start the Solid-OIDC login flow by navigating the initiating tab to the
 * identity provider. Runs in the background page.
 *
 * A moz-extension:// page URL cannot be used as the OIDC redirect target:
 * Community Solid Server (solidcommunity.net) rejects registration of any
 * non-"web" redirect URI ("redirect_uris must only contain web uris"). So we
 * register with the identity API redirect URL
 * (https://<id>.extensions.allizom.org/), an https URI the server accepts. That
 * URL never actually loads: a background webRequest listener (interceptor.js)
 * catches the navigation to it and runs completeLogin() in the background,
 * then sends the tab on to the requested resource.
 *
 * @param oidcIssuer The identity provider, e.g. https://solidcommunity.net
 * @param target The protected resource to open after login
 * @param tabId The tab that initiated the login (navigated to the IdP)
 */
async function startLogin(oidcIssuer, target, tabId) {
    const {login} = await lib();
    pendingLogin = {target: target || null, tabId, issuer: oidcIssuer};
    const redirectUrl = browser.identity.getRedirectURL();
    // Register the client ourselves so registration failures surface a real
    // HTTP status / error_description instead of the library's opaque
    // "Client registration failed".
    const clientId = await registerClient(oidcIssuer, redirectUrl);

    // handleRedirect navigates the INITIATING TAB to the IdP authorization URL
    // (the background page itself must not navigate).
    await login({
        oidcIssuer,
        clientId,
        redirectUrl,
        clientName: "RDF Browser",
        handleRedirect: url => {
            browser.tabs.update(tabId, {url});
        }
    });
}

/**
 * Complete the authorization-code exchange for the given OIDC redirect URL
 * (the allizom redirect carrying ?code=&state=). Runs in the background, so the
 * resulting session + DPoP key stay in the persistent background page. Records
 * the WebID for the popup status display.
 *
 * @param redirectUrl The full redirect URL including the OAuth query params
 * @returns {{isLoggedIn, webId, target, tabId}} session result + where to go
 */
async function completeLogin(redirectUrl) {
    const {handleIncomingRedirect, getDefaultSession} = await lib();
    let error = null;

    // The library hides the token-endpoint response behind an opaque error
    // (e.g. a JSON parse error for a Cloudflare HTML 429). Wrap fetch for the
    // duration of the exchange to capture the IdP's raw failing response
    // (status + body). Filter to the issuer host so a concurrent background
    // fetch (crawler, prefix.cc) can't be mistaken for the login failure. The
    // wrapper only observes — it returns the real response unchanged — and is
    // restored in finally.
    const issuerHost = (pendingLogin && pendingLogin.issuer) ? hostOf(pendingLogin.issuer) : null;
    let captured = null;
    const realFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async function (input, init) {
        const response = await realFetch(input, init);
        try {
            if (!response.ok) {
                const reqUrl = (typeof input === "string") ? input : (input && input.url) || "";
                if (!issuerHost || hostOf(reqUrl) === issuerHost)
                    captured = {
                        url: reqUrl,
                        status: response.status,
                        statusText: response.statusText,
                        body: (await response.clone().text()).slice(0, 600)
                    };
            }
        } catch (ignored) {
        }
        return response;
    };
    // handleIncomingRedirect finishes by stripping the OAuth params from the
    // address: it does history.replaceState(cleanedUrl) and then BUSY-POLLS
    // until window.location.href === cleanedUrl, where cleanedUrl is the URL we
    // pass with code/state/iss/error removed. In the background page,
    // window.location is a moz-extension URL that can never become the
    // cross-origin allizom redirect URL — so it would spin forever (and a
    // cross-origin replaceState throws SecurityError). Build the URL we pass
    // from THIS page's own location plus the OAuth params: cleanedUrl then
    // equals window.location.href, the poll exits immediately, and replaceState
    // stays same-origin. The token request still uses the stored (allizom)
    // redirect_uri, so the exchange itself is unaffected.
    const exchange = new URL(window.location.href);
    try {
        const incoming = new URL(redirectUrl);
        for (const k of ["code", "state", "iss", "error", "error_description"]) {
            const v = incoming.searchParams.get(k);
            if (v !== null)
                exchange.searchParams.set(k, v);
        }
    } catch (ignored) {
    }
    try {
        // Bound the exchange so a stalled token endpoint (e.g. rate limited)
        // surfaces as an error instead of an endless "Completing login…" spinner.
        await Promise.race([
            handleIncomingRedirect({url: exchange.href}),
            new Promise((_, reject) => setTimeout(
                () => reject(new Error("Login timed out after 20s — the identity provider did not respond (it may be rate limiting; try again shortly).")),
                20000))
        ]);
    } catch (e) {
        error = describeError(e);
        console.warn("Solid handleIncomingRedirect failed:", e);
    } finally {
        globalThis.fetch = realFetch;
    }

    const session = getDefaultSession();
    if (session.info.isLoggedIn)
        await browser.storage.local.set({solidWebId: session.info.webId || ""});
    else
        await browser.storage.local.remove("solidWebId");

    // If login failed and we caught the IdP's raw response, lead with it — it is
    // the most concrete diagnostic (exact status + body).
    if (!session.info.isLoggedIn && captured) {
        const raw = "Identity provider returned HTTP " + captured.status +
            (captured.statusText ? " " + captured.statusText : "") +
            " for " + captured.url +
            (captured.body ? ":\n\n" + captured.body : "");
        error = error ? (raw + "\n\n(" + error + ")") : raw;
    }

    const result = {
        isLoggedIn: session.info.isLoggedIn,
        webId: session.info.webId || null,
        target: pendingLogin ? pendingLogin.target : null,
        tabId: pendingLogin ? pendingLogin.tabId : null,
        error: error
    };
    pendingLogin = null;
    return result;
}

/**
 * Reduce an arbitrary thrown error to as much detail as we can surface to a
 * (technical) user: name, message, any HTTP status / response body the error
 * carries, and the cause chain. The auth library wraps token-exchange failures
 * opaquely, so we dig for whatever is attached. Bodies are sliced, not dropped.
 */
function hostOf(u) {
    try {
        return new URL(u).host;
    } catch (e) {
        return null;
    }
}

function describeError(e) {
    if (e == null)
        return "unknown error";
    if (typeof e === "string")
        return e;
    const parts = [];
    if (e.name && e.name !== "Error")
        parts.push(e.name);
    if (e.message)
        parts.push(e.message);
    const status = e.statusCode || e.status || (e.response && e.response.status);
    if (status)
        parts.push("HTTP " + status);
    let body = e.responseBody || e.body || (e.response && (e.response.body || e.response.data));
    if (body && typeof body !== "string") {
        try {
            body = JSON.stringify(body);
        } catch (ignored) {
            body = String(body);
        }
    }
    if (body)
        parts.push(String(body).slice(0, 600));
    let cause = e.cause, depth = 0;
    while (cause && depth < 3) {
        parts.push("caused by: " + (cause.message || String(cause)));
        cause = cause.cause;
        depth++;
    }
    return parts.length ? parts.join(" — ") : String(e);
}

/**
 * Dynamically register a public client with the given Solid identity provider
 * and return its client_id. Throws a descriptive error (status + body) on
 * failure.
 */
async function registerClient(oidcIssuer, redirectUrl) {
    const base = oidcIssuer.endsWith("/") ? oidcIssuer : oidcIssuer + "/";
    let registrationEndpoint;
    try {
        const discovery = await fetch(base + ".well-known/openid-configuration", {
            headers: {Accept: "application/json"}
        });
        if (!discovery.ok) {
            let detail = "";
            try {
                detail = ": " + (await discovery.text()).slice(0, 400);
            } catch (ignored) {
            }
            throw new Error("discovery returned HTTP " + discovery.status + detail);
        }
        registrationEndpoint = (await discovery.json()).registration_endpoint;
    } catch (e) {
        throw new Error("Could not read the identity provider configuration (" +
            (e && e.message ? e.message : e) + ")");
    }
    if (!registrationEndpoint)
        throw new Error("The identity provider does not support dynamic client registration.");
    let response;
    try {
        response = await fetch(registrationEndpoint, {
            method: "POST",
            headers: {"Content-Type": "application/json", Accept: "application/json"},
            body: JSON.stringify({
                redirect_uris: [redirectUrl],
                grant_types: ["authorization_code", "refresh_token"],
                response_types: ["code"],
                scope: "openid offline_access webid",
                client_name: "RDF Browser",
                application_type: "web",
                token_endpoint_auth_method: "none"
            })
        });
    } catch (e) {
        // A network-level failure here (as opposed to an HTTP error response)
        // points at the extension page being unable to reach the IdP, e.g. a
        // CORS rejection of the cross-origin request.
        throw new Error("Could not reach the registration endpoint (" +
            (e && e.message ? e.message : e) + "). This is usually a CORS/network issue.");
    }
    if (!response.ok) {
        let detail = "";
        try {
            detail = ": " + (await response.text()).slice(0, 400);
        } catch (ignored) {
        }
        throw new Error("Registration was rejected with HTTP " + response.status + detail);
    }
    const data = await response.json();
    if (!data.client_id)
        throw new Error("Registration response did not include a client_id.");
    return data.client_id;
}

/**
 * fetch() that is DPoP-authenticated when a Solid session is active, and a
 * plain fetch() otherwise. Intended to run in the background page, where the
 * session lives.
 *
 * The Solid session.fetch derives the request URL via new URL(input) to build
 * the DPoP proof, which throws on a Request object ("[object Request] is not a
 * valid URL"). Native fetch accepts a Request, but session.fetch does not, so
 * when given a Request we decompose it into (url, init) for the authenticated
 * path. Plain fetch keeps receiving the Request unchanged.
 */
async function authFetch(input, init) {
    const {getDefaultSession} = await lib();
    const session = getDefaultSession();
    // Solid pod providers sit behind Cloudflare, which throttles bursts with a
    // transient 429 (and can stall the connection without ever answering). Retry
    // those automatically with backoff and bound each attempt with a timeout, so
    // a throttled lookup recovers on its own instead of hanging or rendering an
    // empty page — i.e. do for the user what reloading the page does by hand.
    if (!session.info.isLoggedIn)
        return withRetry((i, n) => fetch(i, n))(input, init);
    const retryingFetch = withRetry((u, n) => session.fetch(u, n));
    if (input instanceof Request) {
        const request = input;
        const headers = {};
        request.headers.forEach((value, key) => {
            headers[key] = value;
        });
        const merged = Object.assign({
            method: request.method,
            headers,
            credentials: request.credentials,
            mode: request.mode,
            redirect: request.redirect
        }, init);
        return retryingFetch(request.url, merged);
    }
    return retryingFetch(input, init);
}

/**
 * Log out of the current Solid session and clear stored auth state.
 */
async function logout() {
    try {
        const {getDefaultSession} = await lib();
        await getDefaultSession().logout();
    } catch (e) {
        console.warn("Solid logout failed:", e);
    }
    pendingLogin = null;
    await browser.storage.local.remove("solidWebId");
}

module.exports = {
    getStatus,
    startLogin,
    completeLogin,
    authFetch,
    logout
};
