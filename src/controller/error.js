const pedanticURI = "https://aharth.inrupt.net/public/2020/pedanticweb/";
let baseIRI = document.getElementById("url").getAttribute("href");
if (baseIRI === null) {
    baseIRI = new URLSearchParams(window.location.search).get('url');
    document.getElementById("url").setAttribute("href", baseIRI);
    document.getElementById("url").appendChild(document.createTextNode(baseIRI));
    const message = new URLSearchParams(window.location.search).get('message');
    document.getElementById("message").appendChild(document.createTextNode(message));
    document.getElementById("sources").remove();
}

// For authentication/authorization failures (HTTP 401/403), offer a login
// button that (re-)starts the Solid login flow for this resource.
const httpStatus = parseInt(new URLSearchParams(window.location.search).get('httpStatus'), 10);
if (httpStatus === 401 || httpStatus === 403) {
    // Show which Solid identity (WebID) the failed request was authenticated as,
    // to help the user notice if they are logged in as the wrong identity.
    browser.storage.local.get("solidWebId").then(({solidWebId}) => {
        const identityElement = document.getElementById("identity");
        if (solidWebId) {
            identityElement.appendChild(document.createTextNode("You are authenticated as: "));
            const webIdLink = document.createElement("a");
            webIdLink.setAttribute("href", solidWebId);
            webIdLink.appendChild(document.createTextNode(solidWebId));
            identityElement.appendChild(webIdLink);
        } else {
            identityElement.appendChild(document.createTextNode("You are not currently authenticated (no Solid session)."));
        }
        identityElement.removeAttribute("hidden");
    });
    const loginButton = document.getElementById("login");
    loginButton.innerText = (httpStatus === 403) ? "Log in as a different identity" : "Log in";
    loginButton.removeAttribute("hidden");
    loginButton.addEventListener("click", () => {
        // Clear any stale Solid session so the auth page presents a fresh login
        // (the library state lives in the shared moz-extension localStorage).
        try {
            for (const key of Object.keys(localStorage)) {
                if (key.toLowerCase().includes("solid") || key.toLowerCase().includes("oidc"))
                    localStorage.removeItem(key);
            }
        } catch (ignored) {
        }
        browser.storage.local.remove(["solidWebId", "solidPendingResource"]).finally(() => {
            window.location.replace(browser.runtime.getURL("build/view/template.html?auth=1")
                + "&url=" + encodeURIComponent(baseIRI));
        });
    });
}

function handleRefresh() {
    window.location.href = baseIRI;
}

function handleReport() {
    fetch(pedanticURI, {
        method: "POST",
        body: baseIRI
    })
        .then(success)
        .catch(failure);

    function success() {
        document.getElementById("report").setAttribute("disabled", "disabled");
        document.getElementById("report").innerText = "Reported successfully";
        document.getElementById("status").innerText = "Successfully reported this URI to " + pedanticURI;
    }

    function failure(error) {
        const textNode = document.createTextNode(error.toString());
        document.getElementById("status").appendChild(textNode);
    }
}

document.getElementById("refresh").addEventListener("click", handleRefresh);
document.getElementById("report").addEventListener("click", handleReport);
