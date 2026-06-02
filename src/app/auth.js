const browser = window.browser;

/*
 * Thin wrapper around @inrupt/solid-client-authn-browser.
 *
 * The library is bundled statically (esbuild cannot code-split a dynamic
 * import() into the single iife background bundle). Its top-level code is
 * harmless in the background context, which under MV2 is itself a DOM page; the
 * auth flow (login + per-request DPoP signing) only runs from the template page
 * context via content.js.
 *
 * Session lifetime is "session only": the library keeps its state in the
 * shared moz-extension localStorage so it survives the IdP login round-trip and
 * same-session page navigations, but main.js clears that storage on background
 * start-up, so a browser restart effectively logs the user out.
 */

const solidAuth = require("@inrupt/solid-client-authn-browser");

async function lib() {
    return solidAuth;
}

/**
 * Return the default Solid session (logged in or not).
 */
async function getSession() {
    const {getDefaultSession} = await lib();
    return getDefaultSession();
}

/**
 * Complete an incoming OIDC redirect (?code=&state=) if present and/or restore
 * a previously established session within the current browser session.
 * Records the WebID in storage.local for the toolbar status display.
 */
async function restore() {
    const {handleIncomingRedirect, getDefaultSession} = await lib();
    try {
        await handleIncomingRedirect({restorePreviousSession: true});
    } catch (e) {
        console.warn("Solid handleIncomingRedirect failed:", e);
    }
    const session = getDefaultSession();
    if (session.info.isLoggedIn)
        await browser.storage.local.set({solidWebId: session.info.webId || ""});
    else
        await browser.storage.local.remove("solidWebId");
    return session;
}

/**
 * Start the Solid-OIDC login flow by navigating the current tab to the identity
 * provider.
 *
 * A moz-extension:// page URL cannot be used as the OIDC redirect target:
 * Community Solid Server (solidcommunity.net) rejects registration of any
 * non-"web" redirect URI ("redirect_uris must only contain web uris"). So we
 * register with the identity API redirect URL
 * (https://<id>.extensions.allizom.org/), an https URI the server accepts. That
 * URL never actually loads: a background webRequest listener (interceptor.js)
 * catches the navigation to it and bounces the tab to the template page in auth
 * mode, carrying the OAuth code/state, where restore() completes the DPoP-bound
 * token exchange on our own (moz-extension) origin.
 *
 * This navigates the tab away and does not return; login() yields a promise
 * that never resolves once handleRedirect fires.
 *
 * @param oidcIssuer The identity provider, e.g. https://solidcommunity.net
 * @param originalResourceUrl The protected resource to render after login
 */
async function startLogin(oidcIssuer, originalResourceUrl) {
    const {login} = await lib();
    await browser.storage.local.set({solidPendingResource: originalResourceUrl || ""});
    const redirectUrl = browser.identity.getRedirectURL();
    // Register the client ourselves so registration failures surface a real
    // HTTP status / error_description instead of the library's opaque
    // "Client registration failed".
    const clientId = await registerClient(oidcIssuer, redirectUrl);

    // handleRedirect explicitly navigates THIS tab to the IdP authorization URL.
    await login({
        oidcIssuer,
        clientId,
        redirectUrl,
        clientName: "RDF Browser",
        handleRedirect: url => {
            window.location.href = url;
        }
    });
}

/**
 * Dynamically register a public client with the given Solid identity provider
 * and return its client_id. Throws a descriptive error on failure.
 */
async function registerClient(oidcIssuer, redirectUrl) {
    const base = oidcIssuer.endsWith("/") ? oidcIssuer : oidcIssuer + "/";
    let registrationEndpoint;
    try {
        const discovery = await fetch(base + ".well-known/openid-configuration", {
            headers: {Accept: "application/json"}
        });
        if (!discovery.ok)
            throw new Error("discovery returned HTTP " + discovery.status);
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
            detail = ": " + (await response.text()).slice(0, 200);
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
 * plain fetch() otherwise.
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
    if (!session.info.isLoggedIn)
        return fetch(input, init);
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
        return session.fetch(request.url, merged);
    }
    return session.fetch(input, init);
}

/**
 * Persist the resource to render after auth. Set before restore(), because
 * restoring a session can silently redirect to the IdP (which does not preserve
 * our ?url=); on return we recover the resource from here.
 */
async function setPendingResource(url) {
    await browser.storage.local.set({solidPendingResource: url || ""});
}

/**
 * Return the resource URL saved before the login redirect and clear it.
 */
async function takePendingResource() {
    const {solidPendingResource} = await browser.storage.local.get("solidPendingResource");
    await browser.storage.local.remove("solidPendingResource");
    return solidPendingResource || null;
}

/**
 * Return the resource URL saved before the login redirect without clearing it.
 */
async function peekPendingResource() {
    const {solidPendingResource} = await browser.storage.local.get("solidPendingResource");
    return solidPendingResource || null;
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
    await browser.storage.local.remove(["solidWebId", "solidPendingResource"]);
}

module.exports = {
    getSession,
    restore,
    startLogin,
    authFetch,
    setPendingResource,
    takePendingResource,
    peekPendingResource,
    logout
};
