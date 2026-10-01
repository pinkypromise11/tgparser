const test = require("node:test");
const assert = require("node:assert/strict");
const { filterDigestVacancy, buildVacancyText } = require("../src/digest_filter");
const { makeJob, prepareJob, publishJob } = require("../src/digest_worker");
const { hashtags } = require("../src/digest_format");
const { isRelevant } = require("../src/post_filter");
const { SOURCE_ID } = require("../src/digest_links");
const keywords = require("../config/keywords.json");
const candidate = { url: "https://example.com/jobs/1", label: "Senior Node.js Developer", context: "Other positions: Junior QA PHP" };
const page = { status: "readable", title: "Senior Node.js Developer", company: "Acme",
    text: "We are hiring a Senior Node.js Developer. Responsibilities: build Node.js services. Requirements: Senior backend experience." };
const decision = { verdict: "certain", confidence: 97, primary_stack: "nodejs", reason: "Senior Node.js role" };
const result = { matches: true, title: page.title, company: "Acme", direction: "backend", stack: "nodejs", level: "senior",
    location: null, work_mode: null, employment: [], application: [], conflicts: [], status: "unknown", summary: "Разработка сервисов Node.js.",
    evidence: [ { field: "summary", quote: "build Node.js services", source: "page" },
        { field: "title", quote: page.title, source: "page" }, { field: "company", quote: "Acme", source: "page" },
        { field: "direction", quote: "backend", source: "page" }, { field: "stack", quote: "Node.js", source: "page" },
        { field: "level", quote: "Senior", source: "page" } ], url: candidate.url };
const fullPage = { ...page, text: page.text + " Acme" };
const quiet = { log: () => {}, save: () => {} };
const jobFor = (candidates = [candidate]) => ({ ...makeJob({ id: 42, date: 1790533977 }), candidates });

test("digest keyword gate is identical to normal filtering, and excludes other positions' context", async () => {
    let calls = 0;
    const analyze = async (text) => { calls++; assert.doesNotMatch(text, /Junior QA PHP/); return decision; };
    assert.equal(isRelevant(buildVacancyText(candidate, page), SOURCE_ID, keywords), true);
    assert.equal((await filterDigestVacancy(candidate, page, { analyze })).accepted, true);
    for (const text of [page.text + " PHP", page.text.replaceAll("Senior", "Junior"), "Discussion about Node.js"]) {
        const p = { ...page, title: "Developer", text };
        assert.equal(isRelevant(buildVacancyText(candidate, p), SOURCE_ID, keywords), false);
        const rejected = await filterDigestVacancy(candidate, p, { analyze });
        assert.equal(rejected.accepted, false);
        assert.equal(rejected.stage, "keywords");
    }
    assert.equal(calls, 1);
});

test("AI reject is excluded; review and certain use the existing confidence rules", async () => {
    for (const verdict of ["certain", "review", "reject"]) {
        const r = await filterDigestVacancy(candidate, page, { analyze: async () => ({ ...decision, verdict }) });
        assert.equal(r.accepted, verdict !== "reject");
        assert.equal(r.decision.verdict, verdict);
    }
    const r = await filterDigestVacancy(candidate, page, { analyze: async () => ({ ...decision, confidence: 80 }) });
    assert.equal(r.decision.verdict, "review");
    assert.match(hashtags({ ...result, status: "open", relevanceDecision: r.decision }), /^#проверить/);
});

test("unreadable pages never pass based on the Telegram title alone", async () => {
    const rejected = await filterDigestVacancy(candidate, { status: "unavailable", reason: "HTTP 403" }, { analyze: () => assert.fail("No AI call") });
    assert.equal(rejected.accepted, false);
    assert.equal(rejected.stage, "unavailable");
});

test("old unsent cached digests are re-filtered, and zero matches produces no send", async () => {
    const job = jobFor(); job.pages = [page]; job.results = [result]; job.parts = [{ text: "OLD UNFILTERED DIGEST", sent: false }];
    await prepareJob(job, { ...quiet, filter: async () => ({ accepted: false, stage: "ai", reason: "Wrong role" }), analyze: () => assert.fail("Rejected entries need no summary") });
    assert.equal(job.acceptedCount, 0); assert.deepEqual(job.parts, []);
    await publishJob(job, { send: () => assert.fail("Must not send an empty digest"), save: () => {} });
    assert.equal(job.completed, true);
});

test("filter API failure stays pending, then resumes without refetching pages", async () => {
    const job = jobFor(); let fetched = 0;
    await assert.rejects(prepareJob(job, { ...quiet, fetch: async () => { fetched++; return fullPage; },
        filter: async () => { throw new Error("API down"); } }), /API down/);
    assert.equal(job.filters[0], undefined);
    await prepareJob(job, { ...quiet, fetch: () => assert.fail("Already cached"),
        filter: async () => ({ accepted: true, stage: "ai", decision }), analyze: async () => result });
    assert.equal(fetched, 1); assert.equal(job.acceptedCount, 1); assert.equal(job.parts.length, 1);
});

test("accepted items keep original numbers with gaps, policy changes invalidate old decisions", async () => {
    const candidates = [candidate, { ...candidate, url: candidate.url + "2" }, { ...candidate, url: candidate.url + "3" }];
    const job = jobFor(candidates);
    await prepareJob(job, { ...quiet, policy: "v1", fetch: async () => fullPage,
        filter: async (c) => ({ accepted: !c.url.endsWith("2"), stage: "ai", decision }), analyze: async (c) => ({ ...result, url: c.url }) });
    assert.equal(job.acceptedCount, 2);
    assert.match(job.parts[0].text, /\n1\. Senior/); assert.match(job.parts[0].text, /\n3\. Senior/);
    assert.doesNotMatch(job.parts[0].text, /\n2\. Senior/);
    let calls = 0;
    await prepareJob(job, { ...quiet, policy: "v2", filter: async () => { calls++; return { accepted: false, stage: "keywords" }; } });
    assert.equal(calls, 3); assert.equal(job.acceptedCount, 0);
});

test("previously sent digests are preserved, partially sent old policies cannot silently continue", async () => {
    const complete = { ...jobFor(), completed: true, parts: [{ sent: true }] };
    await prepareJob(complete, { ...quiet, filter: () => assert.fail("Do not reprocess published posts") });
    await assert.rejects(prepareJob({ ...jobFor(), parts: [{ sent: true }] }, quiet), /partial publication/);
});
