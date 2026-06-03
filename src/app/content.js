const browser = window.browser;

// content.js runs only on the extension's template page, which is now used
// solely for the Solid auth UI (login screen / "completing login" spinner).
// RDF resources themselves render in the background and are written straight to
// the page by the response interceptor, so there is no in-page rendering here.
async function init() {
    const params = new URL(location.href).searchParams;
    const authParam = params.get("auth");
    if (authParam === "1" || authParam === "complete" || authParam === "loggedin")
        return initAuth(params);
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
        renderAuthMessage("Signing in", "Completing login…", true);
        return;
    }
    if (authParam === "loggedin") {
        // Logged in, but no resource to open (target was lost). Not an error.
        renderAuthMessage("Signed in",
            "You are logged in. Enter a resource URL in the address bar to open it.", false);
        return;
    }
    const target = params.has("url") ? decodeURIComponent(params.get("url")) : null;
    let errorMessage = null;
    if (params.get("error")) {
        const desc = params.get("error_description");
        errorMessage = (params.get("error") === "login_failed")
            ? (desc || "The login did not complete. Please try again.")
            : ("The identity provider returned an error: " + params.get("error") + (desc ? " — " + desc : ""));
    }
    renderLoginScreen(target, errorMessage);
}

/**
 * Inject the minimal-flat stylesheet for the auth pages (login / completing /
 * signed-in) and the spinner keyframes. Scoped to body.rdfb-auth so it also
 * hides the Turtle-view chrome (header/aside) and lets #main flow normally.
 */
function ensureAuthStyle() {
    if (document.getElementById("rdfb-auth-style"))
        return;
    const style = document.createElement("style");
    style.setAttribute("id", "rdfb-auth-style");
    style.appendChild(document.createTextNode(
        "@keyframes solid-spin{to{transform:rotate(360deg)}}" +
        ".solid-spinner{display:inline-block;width:1em;height:1em;vertical-align:-0.15em;" +
        "border:2px solid currentColor;border-right-color:transparent;border-radius:50%;" +
        "animation:solid-spin .7s linear infinite;}" +
        "body.rdfb-auth{margin:0;background:#fff;color:#1b1b1b;line-height:1.55;" +
        "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;}" +
        "body.rdfb-auth>header,body.rdfb-auth>aside{display:none!important;}" +
        "body.rdfb-auth>main{position:static!important;width:auto!important;height:auto!important;" +
        "margin:0!important;overflow:visible!important;}" +
        // Set font/white-space explicitly: style.js applies the Turtle theme
        // (monospace, nowrap) to <main>, which this content would otherwise
        // inherit.
        ".rdfb-wrap{max-width:40rem;margin:0 auto;padding:3rem 1.5rem;white-space:normal;" +
        "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;}" +
        ".rdfb-wrap h1{font-size:1.35rem;font-weight:600;margin:0 0 1rem;padding-bottom:.6rem;" +
        "border-bottom:1px solid #e6e6e6;}" +
        ".rdfb-wrap p{margin:1rem 0;}" +
        ".rdfb-muted{color:#5c5c5c;}" +
        ".rdfb-wrap code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;" +
        "font-size:.95em;word-break:break-all;}" +
        ".rdfb-label{display:block;font-size:.8rem;color:#444;margin:1.5rem 0 .4rem;}" +
        ".rdfb-input{width:100%;box-sizing:border-box;padding:.6rem .7rem;font-size:1rem;" +
        "border:1px solid #ccc;border-radius:6px;background:#fff;color:inherit;}" +
        ".rdfb-input:focus{outline:none;border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.15);}" +
        ".rdfb-actions{display:flex;gap:.6rem;flex-wrap:wrap;margin-top:1.5rem;}" +
        ".rdfb-btn{font:inherit;cursor:pointer;padding:.55rem 1.1rem;border-radius:6px;border:1px solid transparent;}" +
        ".rdfb-btn-primary{background:#2563eb;color:#fff;}" +
        ".rdfb-btn-primary:hover{background:#1d4ed8;}" +
        ".rdfb-btn-primary:disabled{background:#9db8ef;cursor:default;}" +
        ".rdfb-error{color:#b00020;white-space:pre-wrap;word-break:break-word;}"));
    document.head.appendChild(style);
}

/**
 * Prepare the page as a clean auth screen: inject styles, hide the Turtle-view
 * chrome, reset #main, and return a centred content wrapper to fill.
 */
function renderAuthShell() {
    ensureAuthStyle();
    document.body.classList.add("rdfb-auth");
    const main = document.getElementById("main");
    while (main.firstChild)
        main.firstChild.remove();
    main.removeAttribute("style");
    const wrap = document.createElement("div");
    wrap.className = "rdfb-wrap";
    main.appendChild(wrap);
    return wrap;
}

/**
 * Render a simple titled message page (optionally with a spinner) — used for
 * the "Completing login…" and "Signed in" states.
 */
function renderAuthMessage(title, message, withSpinner) {
    document.getElementById("title").innerText = "RDF Browser";
    const wrap = renderAuthShell();
    const h1 = document.createElement("h1");
    h1.textContent = title;
    wrap.appendChild(h1);
    const p = document.createElement("p");
    p.className = "rdfb-muted";
    if (withSpinner) {
        const spinner = document.createElement("span");
        spinner.className = "solid-spinner";
        p.appendChild(spinner);
        const text = document.createElement("span");
        text.style.marginLeft = ".6rem";
        text.textContent = message;
        p.appendChild(text);
    } else {
        p.textContent = message;
    }
    wrap.appendChild(p);
}

/**
 * Render a Solid login prompt (issuer pre-filled, editable) for a protected
 * resource. On submit, the background-driven login flow is started.
 * @param target The protected resource URL to render after login
 * @param errorMessage Optional message to show (e.g. a prior failed attempt)
 */
function renderLoginScreen(target, errorMessage) {
    document.getElementById("title").innerText = "Sign in to Solid";
    const wrap = renderAuthShell();

    const heading = document.createElement("h1");
    heading.textContent = "Sign in to Solid";
    wrap.appendChild(heading);

    const intro = document.createElement("p");
    intro.className = "rdfb-muted";
    intro.appendChild(document.createTextNode("The resource "));
    const code = document.createElement("code");
    code.textContent = target || "(unknown)";
    intro.appendChild(code);
    intro.appendChild(document.createTextNode(" requires authentication."));
    wrap.appendChild(intro);

    const label = document.createElement("label");
    label.className = "rdfb-label";
    label.setAttribute("for", "rdfb-idp");
    label.textContent = "Identity provider";
    wrap.appendChild(label);

    const input = document.createElement("input");
    input.className = "rdfb-input";
    input.setAttribute("type", "text");
    input.setAttribute("id", "rdfb-idp");
    input.setAttribute("spellcheck", "false");
    input.value = "https://solidcommunity.net";
    wrap.appendChild(input);

    const actions = document.createElement("div");
    actions.className = "rdfb-actions";
    const button = document.createElement("button");
    button.className = "rdfb-btn rdfb-btn-primary";
    button.textContent = "Log in";
    actions.appendChild(button);
    wrap.appendChild(actions);

    // Inline progress indicator shown while the login flow is running.
    const progress = document.createElement("p");
    progress.className = "rdfb-muted";
    progress.hidden = true;
    const spinner = document.createElement("span");
    spinner.className = "solid-spinner";
    const progressText = document.createElement("span");
    progressText.style.marginLeft = ".6rem";
    progress.appendChild(spinner);
    progress.appendChild(progressText);
    wrap.appendChild(progress);

    const error = document.createElement("p");
    error.className = "rdfb-error";
    if (errorMessage)
        error.textContent = errorMessage;
    wrap.appendChild(error);

    function showProgress(message) {
        progressText.textContent = message;
        progress.hidden = false;
    }

    async function submit() {
        button.disabled = true;
        input.disabled = true;
        error.textContent = "";
        showProgress("Redirecting to identity provider…");
        // The background owns the session: it runs the login and navigates THIS
        // tab to the IdP (via sender.tab.id). The spinner stays up until the
        // page unloads. A failure before navigation comes back as {ok:false}.
        const result = await browser.runtime.sendMessage(["startLogin", input.value.trim(), target]);
        if (result && result.ok === false) {
            error.textContent = "Login failed: " + (result.error || "unknown error");
            button.disabled = false;
            input.disabled = false;
            progress.hidden = true;
        }
    }

    button.addEventListener("click", submit);
    input.addEventListener("keypress", event => {
        if (event.key === "Enter")
            submit();
    });
    input.focus();
}

module.exports = {init};
