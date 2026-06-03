const browser = window.browser;
let options;

async function init() {
    const getting = await browser.storage.sync.get("options");
    options = getting.options;
    setCheckboxes();
    document.getElementById("settings").addEventListener("click", () => openSettings());
    await initSolid();
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
