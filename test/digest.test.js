const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { extractDigestLinks, SOURCE_ID } = require("../src/digest_links");
const { publicAddress, resolvePublicUrl, extractPage, fetchVacancy, fetchHimalayas, renderPage } = require("../src/digest_fetch");
const { validateAnalysis, unavailable, analyzeDigestVacancy } = require("../src/digest_analyzer");
const { hashtags, formatDigest } = require("../src/digest_format");
const { makeJob, prepareJob, publishJob, sendPart, createDigestWorker, atomicWrite } = require("../src/digest_worker");

const candidate = { url: "https://example.com/jobs/1", label: "Senior Backend Engineer, Acme", context: "Senior Backend Engineer, Acme · UK" };
const page = { status: "readable", url: candidate.url, text: "Senior Backend Engineer at Acme. Build Java services. Full Time. Remote in UK. Apply now." };
function analysis() {
    return { matches: true, title: "Senior Backend Engineer", company: "Acme", direction: "backend", stack: "java", level: "senior",
        location: "outside", work_mode: "remote", employment: ["full_time"], application: [], status: "open",
        summary: "Разработка сервисов на Java. Полная занятость, удалённая работа из Великобритании.", conflicts: [],
        evidence: Object.entries({ title: "Senior Backend Engineer", company: "Acme", direction: "Backend Engineer", stack: "Java",
            level: "Senior", location: "Remote in UK", work_mode: "Remote in UK", employment: "Full Time", status: "Apply now", summary: "Build Java services" })
            .map(([field, quote]) => ({ field, quote, source: "page" })) };
}
function item(overrides = {}) { return { ...analysis(), url: candidate.url, ...overrides }; }
function response(html, url = candidate.url, status = 200) { return { body: Buffer.from(html), url, status, headers: { "content-type": "text/html" } }; }
const html = `<html><body><h1>Senior Backend Engineer</h1><main><h2>Requirements</h2>${"Build Java services with Acme. ".repeat(20)}</main></body></html>`;

test("digest links preserve UTF-16 order, sections, hidden/visible URLs and deduplicate tracking", () => {
    const message = "Вакансии 👩‍💻\nBackend\n• Senior Backend Engineer, Acme\nQA\n• Junior QA Engineer https://example.com/jobs/2\n• Senior Backend Engineer https://example.com/jobs/1?utm_source=tg\n→ готовый промпт https://example.com/jobs/promo\nНаш канал https://t.me/GrowGlobalJobs";
    const result = extractDigestLinks({ message, entities: [{ className: "MessageEntityTextUrl", offset: message.indexOf("Senior Backend"), length: "Senior Backend Engineer, Acme".length, url: candidate.url }] });
    assert.deepEqual(result.map((v) => v.url), [candidate.url, "https://example.com/jobs/2"]);
    assert.deepEqual(result.map((v) => v.section), ["Backend", "QA"]);
    assert.match(result[0].label, /Acme/);
    assert.doesNotMatch(result[0].context, /Junior QA/);
});

test("public URL guard rejects loopback, mapped IPv6, private DNS, non-http and credentials", async () => {
    for (const ip of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "::ffff:127.0.0.1", "fc00::1", "64:ff9b::a00:1"]) assert.equal(publicAddress(ip), false, ip);
    assert.equal(publicAddress("8.8.8.8"), true);
    for (const url of ["http://127.1/", "http://2130706433/", "https://[::1]/", "file:///etc/passwd", "https://user:password@example.com", "https://example.com:444/"]) await assert.rejects(resolvePublicUrl(url));
    await assert.rejects(resolvePublicUrl("https://example.com", async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]));
});

test("extracts JobPosting JSON-LD and removes unrelated recommendation sections", () => {
    const result = extractPage(`<script type="application/ld+json">${JSON.stringify({ "@graph": [{ "@type": "JobPosting", title: "Developer", hiringOrganization: { name: "Acme" }, description: "Build services. ".repeat(30) }] })}</script><main>${html}<aside>Unrelated PHP job</aside></main>`, candidate.url);
    assert.equal(result.readable, true);
    assert.equal(result.company, "Acme");
    assert.doesNotMatch(result.text, /Unrelated/);
    assert.equal(extractPage(html, "https://example.com/").readable, false);
});

test("browser fallback handles a JavaScript-only job description", async () => {
    let rendered = 0;
    const result = await fetchVacancy(candidate, { request: async () => response("<div id='app'></div>"),
        render: async () => { rendered++; return extractPage(html, candidate.url); } });
    assert.equal(rendered, 1);
    assert.equal(result.status, "readable");
});

test("temporary failures retry three times, 404 and redirected homepage remain unavailable", async () => {
    let attempts = 0;
    const failed = await fetchVacancy(candidate, { request: async () => { attempts++; throw new Error("timeout"); }, pause: async () => {} });
    assert.equal(attempts, 3);
    assert.equal(failed.status, "unavailable");
    for (const r of [response(html, "https://example.com/"), response("missing", candidate.url, 404)]) {
        const result = await fetchVacancy(candidate, { request: async () => r, render: () => assert.fail("Must not render a missing/catalog page") });
        assert.equal(result.status, "unavailable");
        assert.notEqual(result.status, "closed");
    }
});

test("Himalayas API requires exact canonical URL, not first search result", async () => {
    const c = { ...candidate, url: "https://himalayas.app/companies/acme/jobs/senior" };
    const jobs = [{ guid: "https://himalayas.app/companies/acme/jobs/wrong", description: "Wrong job ".repeat(40) },
        { guid: c.url, title: "Senior", companyName: "Acme", description: "Correct job ".repeat(40) }];
    const fetched = await fetchHimalayas(c, async () => response(JSON.stringify({ jobs, totalCount: 2 })), async () => {});
    assert.equal(fetched.attribution, "Himalayas");
    assert.match(fetched.text, /Correct job/);
    assert.doesNotMatch(fetched.text, /Wrong job/);
});

test("analysis validates evidence, rejects fabricated quotes and marks mismatched pages", () => {
    assert.equal(validateAnalysis(analysis(), candidate, page).stack, "java");
    const madeUp = analysis(); madeUp.evidence[0].quote = "Invented $200000 salary";
    assert.throws(() => validateAnalysis(madeUp, candidate, page), /Unverifiable/);
    const tooLong = analysis(); tooLong.summary = "я".repeat(451);
    assert.throws(() => validateAnalysis(tooLong, candidate, page), /length/);
    assert.equal(validateAnalysis({ matches: false }, candidate, page).status, "unavailable");
});

test("closed jobs and conflicting locations are retained with review tags", () => {
    const closed = item({ status: "closed" });
    assert.match(hashtags(closed), /#проверить #закрыта/);
    const conflicting = item({ conflicts: ["Telegram: UK; страница: US."] });
    assert.match(hashtags(conflicting), /^#проверить/);
    const parts = formatDigest({ id: 37, date: 1790533977, results: [conflicting, unavailable(candidate, "HTTP 404")] });
    assert.match(parts[0].text, /Расхождения: Telegram: UK/);
    assert.match(parts[0].text, /Описание недоступно: HTTP 404/);
    assert.doesNotMatch(parts[0].text, /#закрыта/);
});

test("tag order, partial employment and Telegram-only attribution are stable", () => {
    assert.equal(hashtags(item({ employment: ["part_time"], application: ["company_form"] })), "#достоверно #backend #java #senior #ву #remote #part_time #анкета");
    const v = item(); v.evidence = v.evidence.filter((e) => e.field !== "location"); v.evidence.push({ field: "location", source: "telegram", quote: "Acme · UK" });
    const part = formatDigest({ id: 37, date: 1790533977, results: [v] })[0];
    assert.match(part.text, /#проверить/);
    assert.match(part.text, /По Telegram:/);
});

test("digest splits only between entries, with continuous numbering and UTF-16 bold offsets", () => {
    const results = Array.from({ length: 15 }, (_, i) => item({ title: `👩‍💻 Вакансия ${i}`, summary: "Описание. ".repeat(40) }));
    const parts = formatDigest({ id: 37, date: 1790533977, results });
    assert.ok(parts.length > 1);
    assert.ok(parts.every((part) => part.text.length <= 3900));
    let number = 0;
    for (const part of parts) for (const entity of part.entities) {
        assert.equal(part.text.slice(entity.offset, entity.offset + entity.length), `${++number}. 👩‍💻 Вакансия ${number - 1} — Acme`);
    }
    assert.equal(number, 15);
});

test("LLM outage preserves fetched pages and resumes completed positions", async () => {
    const job = { ...makeJob({ id: 37, date: 1790533977 }), candidates: [candidate, { ...candidate, url: candidate.url + "2" }] };
    let fetched = 0, analyzed = 0;
    let snapshot;
    const options = { log: () => {}, filter: async () => ({ accepted: true, stage: "ai" }), save: (j) => { snapshot = structuredClone(j); }, fetch: async () => { fetched++; return page; },
        analyze: async () => { analyzed++; if (analyzed === 2) throw new Error("API unavailable"); return item(); } };
    await assert.rejects(prepareJob(job, options), /API unavailable/);
    assert.equal(snapshot.results.length, 1);
    await prepareJob(snapshot, { ...options, analyze: async () => item() });
    assert.equal(fetched, 2);
    assert.equal(snapshot.results.length, 2);
    assert.ok(snapshot.parts[0].randomIdHex);
});

test("publishing resumes after accepted-but-unacknowledged send with the same random ID", async () => {
    let persisted;
    let job = { parts: [{ randomIdHex: "0123456789abcdef", sent: false }, { randomIdHex: "1123456789abcdef", sent: false }] };
    persisted = structuredClone(job);
    const accepted = new Set(); let crash = true;
    const send = async (part) => {
        if (accepted.has(part.randomIdHex)) throw Object.assign(new Error("duplicate"), { errorMessage: "RANDOM_ID_DUPLICATE" });
        accepted.add(part.randomIdHex);
        if (crash) { crash = false; throw new Error("connection lost after acceptance"); }
        return 42;
    };
    await assert.rejects(publishJob(job, { send, save: (j) => { persisted = structuredClone(j); } }));
    job = structuredClone(persisted);
    await publishJob(job, { send, save: (j) => { persisted = structuredClone(j); } });
    assert.equal(accepted.size, 2);
    assert.equal(persisted.completed, true);
    await publishJob(persisted, { send: () => assert.fail("already sent"), save: () => {} });
});

test("Telegram transport uses persisted signed random ID, bold entities and disabled previews", async () => {
    let request;
    const { Api } = require("telegram");
    const client = { getInputEntity: async () => new Api.InputPeerSelf(), invoke: async (r) => { r.getBytes(); request = r; return { id: 23 }; } };
    const part = { text: "1. Title", randomIdHex: "ffffffffffffffff", entities: [{ offset: 0, length: 8 }] };
    assert.equal(await sendPart(client, "me", part), 23);
    assert.equal(request.randomId.toString(), "-1");
    assert.equal(request.noWebpage, true);
    assert.equal(request.entities[0].className, "MessageEntityBold");
});

test("FloodWait retries the same part without marking it sent prematurely", async () => {
    const waits = []; let attempts = 0;
    const job = { parts: [{ sent: false }] };
    await publishJob(job, { save: () => {}, pause: async (ms) => waits.push(ms), send: async () => {
        if (++attempts === 1) throw Object.assign(new Error("FLOOD_WAIT_2"), { seconds: 2 }); return 7;
    } });
    assert.deepEqual(waits, [3000]);
    assert.equal(job.parts[0].messageId, 7);
});

test("worker baselines first run, catches up after restart and journals before advancing cursor", async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "digest-test-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    let messages = [];
    const client = { getEntity: async () => ({ id: SOURCE_ID.slice(4) }), getMessages: async () => [{ id: 37 }],
        iterMessages: async function* ({}, { minId }) { for (const m of messages) if (m.id > minId) yield m; } };
    const prepared = [], published = [];
    const opts = { dir, intervalMs: 100000, log: () => {},
        prepare: async (job, { save }) => { prepared.push(job.id); job.parts = []; save(job); },
        publish: async (job, { save }) => { published.push(job.id); job.completed = true; save(job); } };
    let worker = createDigestWorker(client, opts);
    await worker.start(); await worker.tick(); await worker.stop();
    assert.deepEqual(prepared, []);
    messages = [{ id: 38, date: 1790533977, message: "Senior Developer https://example.com/jobs/38" }, { id: 39, date: 1790533977, message: "News" }];
    worker = createDigestWorker(client, opts);
    await worker.start(); await worker.tick(); await worker.stop();
    assert.deepEqual(published, [38]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "state.json"))).lastId, 39);
    worker = createDigestWorker(client, opts);
    await worker.start(); await worker.tick(); await worker.stop();
    assert.deepEqual(published, [38]);
});

test("analyzer retries invalid structured output but propagates API outages", async () => {
    let calls = 0;
    const client = { responses: { create: async () => ({ output_text: ++calls === 1 ? "invalid" : JSON.stringify(analysis()) }) } };
    assert.equal((await analyzeDigestVacancy(candidate, page, client)).company, "Acme");
    assert.equal(calls, 2);
    await assert.rejects(analyzeDigestVacancy(candidate, page, { responses: { create: async () => { throw new Error("credits exhausted"); } } }), /credits exhausted/);
});

test("worldwide country metadata and optional office perks do not imply Russia or hybrid", () => {
    const countries = Array.from({ length: 200 }, (_, i) => ({ "@type": "Country", name: i === 0 ? "Russia" : `Country${i}` }));
    const result = extractPage(`<script type="application/ld+json">${JSON.stringify({ "@type": "JobPosting", title: "Engineer", description: "Build services. ".repeat(30), applicantLocationRequirements: countries })}</script>`, candidate.url);
    assert.doesNotMatch(result.text, /"name":"Russia"/);
    assert.match(result.text, /Worldwide/);
    const v = analysis(); v.work_mode = "hybrid";
    v.evidence = v.evidence.filter((e) => e.field !== "work_mode");
    v.evidence.push({ field: "work_mode", source: "page", quote: "Flexible home or office" });
    assert.throws(() => validateAnalysis(v, candidate, { ...page, text: page.text + " Flexible home or office" }), /Hybrid requires/);
});

test("short explicit closure notices are read, but 'Job expired?' report buttons are not closure evidence", () => {
    assert.equal(extractPage("<main><h1>Senior Engineer at Acme</h1><p>This job is closed.</p></main>", candidate.url).readable, true);
    assert.equal(extractPage("<main><h1>Senior Engineer at Acme</h1><button>Job expired?</button></main>", candidate.url).readable, false);
});

test("a Europe/Asia regional requirement is not evidence of mandatory residence outside Russia", () => {
    const v = analysis();
    v.evidence = v.evidence.filter((e) => e.field !== "location");
    v.evidence.push({ field: "location", source: "page", quote: "Europe or Americas" });
    const result = validateAnalysis(v, candidate, { ...page, text: page.text + " Europe or Americas" });
    assert.equal(result.location, null);
    assert.match(hashtags(result), /^#проверить/);
    assert.doesNotMatch(hashtags(result), /#ву/);
});

test("polling continues collecting new posts while a prior digest is being analyzed", async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "digest-concurrency-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    let messages = [], release;
    const gate = new Promise((resolve) => { release = resolve; });
    let began;
    const started = new Promise((resolve) => { began = resolve; });
    const client = { getEntity: async () => ({ id: SOURCE_ID.slice(4) }), getMessages: async () => [{ id: 37 }],
        iterMessages: async function* ({}, { minId }) { for (const m of [...messages]) if (m.id > minId) yield m; } };
    const worker = createDigestWorker(client, { dir, intervalMs: 100000, log: () => {},
        prepare: async (job, { save }) => { began(); await gate; job.parts = []; save(job); },
        publish: async (job, { save }) => { job.completed = true; save(job); } });
    await worker.start(); await worker.tick();
    messages = [{ id: 38, date: 1790533977, message: "Senior Engineer https://example.com/jobs/38" }];
    const first = worker.tick(); await started;
    messages.push({ id: 39, date: 1790533977, message: "Senior Engineer https://example.com/jobs/39" });
    const second = worker.tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "state.json"))).lastId, 39);
    assert.equal(fs.existsSync(path.join(dir, "39.json")), true);
    release(); await first; await second; await worker.stop();
});
