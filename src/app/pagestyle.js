// Shared minimal-flat (light) styles for the extension's own pages — the auth
// screens (content.js) and the in-place error page (interceptor.js
// buildErrorPage). Kept as a string so it can be both injected into the auth
// template and embedded in the background-built error document.
const PAGE_CSS =
    "body{margin:0;background:#fff;color:#1b1b1b;line-height:1.55;" +
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;}" +
    // Explicit font/white-space: on the auth template, style.js applies the
    // Turtle theme (monospace, nowrap) to <main>, which this content would
    // otherwise inherit.
    ".rdfb-wrap{max-width:40rem;margin:0 auto;padding:3rem 1.5rem;white-space:normal;" +
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;}" +
    ".rdfb-wrap h1{font-size:1.35rem;font-weight:600;margin:0 0 1rem;padding-bottom:.6rem;border-bottom:1px solid #e6e6e6;}" +
    ".rdfb-wrap p{margin:1rem 0;}" +
    ".rdfb-muted{color:#5c5c5c;}" +
    ".rdfb-detail{background:#f6f6f6;border:1px solid #ececec;border-radius:6px;padding:.8rem;overflow:auto;" +
    "white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.85rem;}" +
    ".rdfb-actions{display:flex;gap:.6rem;flex-wrap:wrap;margin-top:1.5rem;}" +
    ".rdfb-btn{font:inherit;cursor:pointer;text-decoration:none;display:inline-block;" +
    "padding:.55rem 1.1rem;border-radius:6px;border:1px solid #ccc;background:#fff;color:#1b1b1b;}" +
    ".rdfb-btn:hover{background:#f4f4f4;}" +
    ".rdfb-btn-primary{background:#2563eb;color:#fff;border-color:transparent;}" +
    ".rdfb-btn-primary:hover{background:#1d4ed8;}";

module.exports = {PAGE_CSS};
