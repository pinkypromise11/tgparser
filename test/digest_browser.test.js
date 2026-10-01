const test = require("node:test");
const assert = require("node:assert/strict");
const { renderPage } = require("../src/digest_fetch");

test("Chromium executes a JS-only description using intercepted public HTTP requests", {
    skip: process.env.DIGEST_BROWSER_TEST !== "1", timeout: 30000,
}, async () => {
    const html = `<main id="job"></main><script>
        setTimeout(() => { document.getElementById('job').innerHTML = '<h1>Senior Engineer at Acme</h1><h2>Requirements</h2><p>' + 'Build Java services. '.repeat(40) + '</p>'; }, 20);
    </script>`;
    const result = await renderPage("https://example.com/jobs/1", { request: async (url) => ({ url, status: 200,
        headers: { "content-type": "text/html" }, body: Buffer.from(html) }) });
    assert.equal(result.readable, true);
    assert.match(result.text, /Build Java services/);
});
