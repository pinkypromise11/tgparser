// Explicit one-off batch. Nothing is sent without --publish; independent durable receipts.
require("dotenv").config({ quiet: true });
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { externalLinks } = require("./find_recent_link_roundups");
const { atomicWrite: writeOnce, prepareJob, publishJob, sendPart } = require("../src/digest_worker");
const { TARGET_ID } = require("../src/digest_links");
const { fetchVacancy } = require("../src/digest_fetch");
const { filterDigestVacancy, filterPolicy } = require("../src/digest_filter");
const SOURCE = "-1001788647101";
const IDS = [2115, 2116, 2120, 2122, 2123, 2125, 2129, 2130, 2132];
const DIR = path.resolve("config/young-roundups-20261001");
const jobFile = id => path.join(DIR, `${id}.json`);
const pageFile = url => path.join(DIR, "pages", `${crypto.createHash("sha256").update(url).digest("hex")}.json`);

function positionContext(text, candidate) {
    const start = text.lastIndexOf("\n", candidate.offset - 1) + 1;
    const end = text.indexOf("\n", candidate.offset);
    const line = text.slice(start, end < 0 ? text.length : end);
    return `${text.split(/\r?\n/u).slice(0, 3).join("\n")}\n${candidate.label}\n${line}`.slice(0, 1800);
}

function atomicWrite(file, value) {
    for (let attempt = 0; ; attempt++) {
        try { return writeOnce(file, value); }
        catch (error) {
            if (attempt >= 9 || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
            // Windows antivirus/indexers can briefly hold the destination during atomic rename.
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        }
    }
}

function candidates(message) {
    const text = message.message;
    let number = 0;
    return externalLinks(message).flatMap(link => {
        const host = new URL(link.url).hostname;
        if (!["wantapply.com", "jobs.ashbyhq.com", "docs.google.com"].includes(host)) return [];
        const orphan = !link.label.trim();
        const label = message.id === 2120 && /social-marketing-manager-at-muse-group/u.test(link.url)
            ? "SMM Manager / Muse Group" : link.label.trim() || new URL(link.url).pathname.slice(1);
        return [{ url: link.url, label, offset: link.offset, section: "", orphan,
            originalNumber: orphan ? null : ++number,
            context: positionContext(text, { ...link, label }) }];
    });
}

function parseWebPage(raw, candidate) {
    const sources = [...raw.matchAll(/Source: open\((\{[^\n]*?\})\);/gu)];
    const sourceIndex = sources.findIndex(m => JSON.parse(m[1]).ref_id === candidate.url);
    if (sourceIndex < 0) return null;
    const source = sources[sourceIndex];
    raw = raw.slice(source.index + source[0].length, sources[sourceIndex + 1]?.index ?? raw.length);
    // The web reader may place an empty next line marker after an inline link.
    raw = raw.replace(/ (?=L\d+:)/gu, "\n");
    const lines = [...raw.matchAll(/(?:^|\n)L(\d+): ?([^\n]*)/gu)].map(m => ({ n: Number(m[1]), text: m[2] }));
    const clean = s => s.replace(/cite[^†]+†([^]+)/gu, "$1");
    const titleLine = lines.find(l => / at .+\| Wantapply\.com/u.test(l.text));
    const titleMatch = titleLine?.text.match(/^(.*?) at (.*?)\s*\| Wantapply\.com/u);
    const start = lines.findIndex(l => /^# /u.test(l.text));
    if (start < 0 || /not accessible via this tool/u.test(raw)) return null;
    const description = lines.slice(start);
    const end = description.findIndex(l => /^(Published on:|## Similar jobs)/iu.test(l.text));
    if (end < 0) return null; // No truncated excerpts or neighboring roles accepted as a full description.
    const selected = description.slice(0, end + 1);
    if (selected.some((l, i) => i && l.n !== selected[i - 1].n + 1)) return null;
    const title = clean(titleMatch?.[1] || lines[start].text.replace(/^# /u, ""));
    const company = clean(titleMatch?.[2] || "");
    const notice = lines.slice(0, start).find(l => /this job has been archived|no longer active|no longer accepting applications|this (?:job|position) (?:is|has been) closed/iu.test(l.text))?.text;
    const text = clean(`${title}\n${company}\n${notice || ""}\n${selected.map(l => l.text).join("\n")}`);
    if (text.length < 250) return null;
    return { status: "readable", title, company, closed: !!notice,
        url: candidate.url, text, fetchedVia: "public-web-reader", fetchedAt: new Date().toISOString() };
}

async function main() {
    const args = process.argv.slice(2);
    fs.mkdirSync(DIR, { recursive: true });
    if (args.includes("--import-web")) {
        const jobs = IDS.map(id => JSON.parse(fs.readFileSync(jobFile(id), "utf8")));
        let imported = 0;
        for (const c of jobs.flatMap(j => j.candidates)) {
            const rawFile = pageFile(c.url).replace(/\.json$/u, ".web.json");
            if (!fs.existsSync(rawFile)) continue;
            const page = parseWebPage(JSON.parse(fs.readFileSync(rawFile, "utf8")).raw, c);
            if (page) { atomicWrite(pageFile(c.url), page); imported++; }
            else if (fs.existsSync(pageFile(c.url)) && JSON.parse(fs.readFileSync(pageFile(c.url), "utf8")).fetchedVia === "public-web-reader") {
                atomicWrite(pageFile(c.url), { status: "unavailable", url: c.url, reason: "Полное описание по точной ссылке не прочитано" });
            }
        }
        console.log(`Imported ${imported} readable occurrences`);
        return;
    }
    let client;
    try {
        if (args.includes("--init") || args.includes("--publish")) {
            client = new TelegramClient(new StringSession(fs.readFileSync("session.txt", "utf8").trim()),
                Number(process.env.API_ID), process.env.API_HASH, { connectionRetries: 2 });
            await client.connect();
        }
        if (args.includes("--init")) {
            const source = await client.getEntity("young_relocate");
            if (`-100${source.id}` !== SOURCE) throw new Error("Unexpected source identity");
            const messages = await client.getMessages(source, { ids: IDS });
            for (const id of IDS) {
                if (fs.existsSync(jobFile(id))) continue;
                const message = messages.find(m => m.id === id);
                if (!message?.message) throw new Error(`Missing source ${id}`);
                const job = { version: 1, source: SOURCE, sourceUsername: "young_relocate", target: TARGET_ID,
                    id, date: Number(message.date), sourceText: message.message, candidates: candidates(message),
                    pages: [], results: [], parts: null, completed: false };
                atomicWrite(jobFile(id), job);
                console.log(`Initialized ${id}: ${job.candidates.length} links, ${job.candidates.filter(c => !c.orphan).length} numbered roles`);
            }
            return;
        }
        const jobs = IDS.map(id => JSON.parse(fs.readFileSync(jobFile(id), "utf8")));
        if (jobs.some(j => j.source !== SOURCE || j.target !== TARGET_ID || j.sourceUsername !== "young_relocate")) throw new Error("Wrong batch scope");
        if (args.includes("--fetch")) {
            const unique = [...new Map(jobs.flatMap(j => j.candidates).map(c => [c.url, c])).values()];
            let cursor = 0;
            await Promise.all(Array.from({ length: 4 }, async () => {
                while (cursor < unique.length) {
                    const c = unique[cursor++];
                    if (fs.existsSync(pageFile(c.url))) continue;
                    const page = await fetchVacancy(c);
                    atomicWrite(pageFile(c.url), page);
                    console.log(`${page.status}: ${c.label} ${page.reason || ""}`);
                }
            }));
            return;
        }
        if (args.includes("--prepare")) {
            for (const job of jobs) {
                try {
                    // Never lend an adjacent vacancy's requirements to this position's Telegram evidence.
                    for (const c of job.candidates) c.context = positionContext(job.sourceText, c);
                    if (args.includes("--refresh-pages")) {
                        if (job.completed || job.parts?.some(p => p.sent)) throw new Error("Cannot rebuild published jobs");
                        job.pages = job.candidates.map(c => JSON.parse(fs.readFileSync(pageFile(c.url), "utf8")));
                        job.parts = null;
                    }
                    await prepareJob(job, { save: j => atomicWrite(jobFile(j.id), j), log: () => {},
                        fetch: async c => JSON.parse(fs.readFileSync(pageFile(c.url), "utf8")),
                        filter: async (c, p, options) => {
                            if (p.closed) return { accepted: false, stage: "description", reason: "На странице явно указано: вакансия в архиве/закрыта" };
                            const result = await filterDigestVacancy(c, p, options);
                            return result.accepted && c.orphan ? { accepted: false, stage: "identity", reason: "Ссылка привязана к пустой строке, позиция не подтверждена" } : result;
                        } });
                    console.log(`Prepared ${job.id}: accepted=${job.acceptedCount}/${job.candidates.length}`);
                } catch (error) {
                    console.error(`Pending ${job.id}: ${error.message}`);
                    process.exitCode = 1;
                }
            }
            return;
        }
        if (args.includes("--publish")) {
            const target = await client.getEntity(TARGET_ID);
            if (`-100${target.id}` !== TARGET_ID) throw new Error("Wrong publication target");
            const policy = filterPolicy();
            for (const job of jobs) {
                if (!job.parts || job.filterPolicy !== policy) throw new Error(`Unprepared or stale job ${job.id}`);
            }
            for (const job of jobs) {
                await publishJob(job, { save: j => atomicWrite(jobFile(j.id), j), send: part => sendPart(client, target, part) });
                for (const part of job.parts) {
                    if (!part.messageId) throw new Error(`Missing send receipt for ${job.id}`);
                    const [message] = await client.getMessages(target, { ids: [part.messageId] });
                    if (message?.message !== part.text) throw new Error(`Publication verification failed for ${part.messageId}`);
                }
                console.log(`Verified ${job.id}: accepted=${job.acceptedCount} messages=${job.parts.map(p => p.messageId).join(",")}`);
            }
            return;
        }
        console.log(JSON.stringify(jobs.map(j => ({ id: j.id, candidates: j.candidates.length, accepted: j.acceptedCount,
            stages: (j.filters || []).reduce((counts, f) => { const k = f.accepted ? "accepted" : f.stage; counts[k] = (counts[k] || 0) + 1; return counts; }, {}),
            parts: j.parts?.map(p => ({ text: p.text, messageId: p.messageId, sent: p.sent })) })), null, 2));
    } finally { if (client) await client.disconnect(); }
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { candidates, parseWebPage, pageFile, atomicWrite };
