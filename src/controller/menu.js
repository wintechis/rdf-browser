const browser = window.browser;
let options;

async function init() {
    const getting = await browser.storage.sync.get("options");
    options = getting.options;
    setCheckboxes();
    document.getElementById("settings").addEventListener("click", () => openSettings());
    await initSiteToggle();
    await initSolid();
}

/**
 * Per-hostname on/off switch for the current page. "Off" adds (and "on" removes)
 * a `https://<host>/*` entry in the blacklist — the interceptor already skips
 * blacklisted hosts, so this just drives that list from one click. Hidden when
 * the current tab isn't an http(s) resource.
 */
async function initSiteToggle() {
    const tabs = await browser.tabs.query({active: true, currentWindow: true});
    const tab = tabs[0];
    const host = tab ? resourceHost(tab.url) : null;
    if (!host)
        return;
    const pattern = "https://" + host + "/*";
    const box = document.getElementById("siteToggleOption");
    const hostLabel = document.getElementById("siteHost");
    const button = document.getElementById("siteToggle");

    const lines = () => (options.blacklist || "").split("\n").map(l => l.trim()).filter(l => l.length > 0);
    const render = () => {
        const disabled = lines().includes(pattern);
        hostLabel.innerText = host;
        button.innerText = disabled ? "Turn RDF Browser on for this site" : "Turn RDF Browser off for this site";
    };
    render();
    box.removeAttribute("hidden");

    button.addEventListener("click", async () => {
        const current = lines();
        const index = current.indexOf(pattern);
        if (index >= 0)
            current.splice(index, 1);
        else
            current.push(pattern);
        options.blacklist = current.join("\n");
        await browser.storage.sync.set({options: options});
        // Re-load the page so the change takes effect immediately.
        browser.tabs.reload(tab.id);
        window.close();
    });
}

/**
 * The http(s) host of the resource shown in the tab. Resolves the real resource
 * URL behind the extension's auth/error pages (carried in their ?url= param).
 */
function resourceHost(url) {
    if (!url)
        return null;
    try {
        let u = new URL(url);
        if (u.protocol === "moz-extension:") {
            const target = u.searchParams.get("url");
            if (!target)
                return null;
            u = new URL(decodeURIComponent(target));
        }
        if (u.protocol === "http:" || u.protocol === "https:")
            return u.host;
    } catch (e) {
    }
    return null;
}

async function initSolid() {
    const {solidWebId} = await browser.storage.local.get("solidWebId");
    const statusElement = document.getElementById("solidStatus");
    const logoutElement = document.getElementById("solidLogout");
    if (solidWebId) {
        statusElement.innerText = "Solid: " + solidWebId;
        logoutElement.removeAttribute("hidden");
        logoutElement.addEventListener("click", () => solidLogout());
    } else {
        statusElement.innerText = "Solid: not logged in";
        logoutElement.setAttribute("hidden", "hidden");
    }
}

function solidLogout() {
    // The session lives in the (persistent) background page's memory, so logout
    // must run there; the background clears the session and the solidWebId.
    browser.runtime.sendMessage(["logout"]).then(() => window.close());
}

function setCheckboxes() {
    for (const option in options.quickOptions) {
        document.getElementById(option).checked = options.quickOptions[option];
        document.getElementById(option).addEventListener("change", save);
    }
}

function save() {
    for (const option in options.quickOptions)
        options.quickOptions[option] = document.getElementById(option).checked;
    browser.storage.sync.set({
        options: options
    });
}

function openSettings() {
    browser.runtime.openOptionsPage().then(() => window.close());
}

init().then();
