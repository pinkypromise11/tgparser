const test = require("node:test");
const assert = require("node:assert/strict");
const { candidates, parseWebPage } = require("../scripts/process_young_roundups");
const { formatDigest } = require("../src/digest_format");

test("young source skips company links, records orphan URLs without shifting visible numbers", () => {
    const message = { id: 2132, message: "Company\nSenior React Developer\n\nSenior Python Developer", entities: [
        { className: "MessageEntityTextUrl", offset: 0, length: 7, url: "https://example.com/" },
        { className: "MessageEntityTextUrl", offset: 8, length: 22, url: "https://wantapply.com/react-at-company" },
        { className: "MessageEntityTextUrl", offset: 30, length: 1, url: "https://wantapply.com/orphan" },
        { className: "MessageEntityTextUrl", offset: 32, length: 23, url: "https://wantapply.com/python-at-company" },
    ] };
    const result = candidates(message);
    assert.deepEqual(result.map(c => c.originalNumber), [1, null, 2]);
    assert.equal(result[1].orphan, true);
});

test("web reader isolates exact URL across combined tool results and removes recommendations", () => {
    function page(url, title) { return `Source: open({"ref_id":"${url}","lineno":null}); Total lines: 8\nL0: ${title} at Company | Wantapply.com\nL1: # ${title}\nL2: Requirements ${"TypeScript experience and development. ".repeat(12)}\nL3: Published on: 9/20/2026\nL4: ## Similar jobs\nL5: unrelated forbidden stack`; }
    const raw = page("https://wantapply.com/one", "First Job") + "\n" + page("https://wantapply.com/two", "Second Job");
    const parsed = parseWebPage(raw, { url: "https://wantapply.com/two" });
    assert.equal(parsed.title, "Second Job");
    assert.ok(!parsed.text.includes("First Job"));
    assert.ok(!parsed.text.includes("forbidden"));
    assert.equal(parseWebPage(raw, { url: "https://wantapply.com/missing" }), null);
    assert.equal(parseWebPage(raw.replace("L2: Requirements", "L7: Requirements"), { url: "https://wantapply.com/one" }), null);
    assert.equal(parseWebPage(raw.replace("\nL2: Requirements", " L2: Requirements"), { url: "https://wantapply.com/one" }).title, "First Job");
});

test("roundup formatter uses explicit source and preserves supplied original number", () => {
    const parts = formatDigest({ sourceUsername: "young_relocate", id: 2132, date: 1790000000,
        results: [{ originalNumber: 14, title: "Senior Frontend", company: "Company", status: "unknown", conflicts: [],
            direction: "frontend", stack: "react", employment: [], application: [], evidence: [], summary: "Описание", url: "https://example.com/job" }] });
    assert.match(parts[0].text, /https:\/\/t.me\/young_relocate\/2132/u);
    assert.match(parts[0].text, /14\. Senior Frontend/u);
    assert.ok(!parts[0].text.includes("GrowGlobalJobs"));
});
