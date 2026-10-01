const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { Api } = require("telegram");
const { readBigIntFromBuffer } = require("telegram/Helpers");
const { SOURCE_ID, SOURCE_USERNAME, TARGET_ID, extractDigestLinks } = require("./digest_links");
const { fetchVacancy } = require("./digest_fetch");
const { analyzeDigestVacancy, unavailable, validateAnalysis } = require("./digest_analyzer");
const { formatDigest } = require("./digest_format");
const { filterDigestVacancy, filterPolicy, filterInputHash } = require("./digest_filter");

function atomicWrite(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
    fs.renameSync(temporary, file);
}

function makeJob(message) {
    return { version: 1, source: SOURCE_ID, target: TARGET_ID, id: message.id,
        date: message.date instanceof Date ? Math.floor(message.date.getTime() / 1000) : Number(message.date),
        candidates: extractDigestLinks(message), pages: [], results: [], parts: null, completed: false };
}

async function prepareJob(job, { save = () => {}, fetch = fetchVacancy, analyze = analyzeDigestVacancy,
    filter = filterDigestVacancy, policy = filterPolicy(), log = console.log } = {}) {
    if (job.completed) return job;
    if (job.parts && job.filterPolicy === policy) return job;
    if (job.filterPolicy !== policy) {
        if (job.parts?.some((part) => part.sent)) throw new Error("Filter policy changed during partial publication; manual review required");
        job.filterPolicy = policy;
        job.filters = [];
        job.parts = null;
        save(job);
    }
    job.filters ||= [];
    for (let i = 0; i < job.candidates.length; i++) {
        const candidate = job.candidates[i];
        log(`Digest ${job.id}: ${i + 1}/${job.candidates.length} ${candidate.label}`);
        if (!job.pages[i]) {
            job.pages[i] = await fetch(candidate);
            save(job);
        }
        const page = job.pages[i];
        const inputHash = filterInputHash(candidate, page);
        if (job.filters[i]?.inputHash !== inputHash) {
            // API failures propagate without recording a rejection; retry this stage next poll.
            job.filters[i] = { ...await filter(candidate, page, { channelId: job.source }), inputHash };
            save(job);
        }
        const eligibility = job.filters[i];
        if (!eligibility.accepted) {
            job.results[i] = { status: "filtered", url: candidate.url, title: candidate.label, filter: eligibility };
            log(`Digest ${job.id}: skipped ${i + 1} (${eligibility.stage}: ${eligibility.reason})`);
            save(job);
            continue;
        }
        if (job.results[i] && !["filtered", "unavailable"].includes(job.results[i].status)) {
            job.results[i] = { ...job.results[i], ...validateAnalysis(job.results[i], candidate, page), relevanceDecision: eligibility.decision };
            save(job);
            continue;
        }
        // Model/API errors intentionally propagate: do not mark a failed analysis as completed.
        job.results[i] = page.status === "readable"
            ? await analyze(candidate, page)
            : unavailable(candidate, page.reason);
        if (["closed", "unavailable"].includes(job.results[i].status)) {
            job.filters[i] = { ...eligibility, accepted: false, stage: "description", reason: job.results[i].reason || "Вакансия закрыта" };
        }
        job.results[i].relevanceDecision = eligibility.decision;
        if (page.attribution) job.results[i].attribution = page.attribution;
        save(job);
    }
    const publishable = job.results.map((item, index) => ({ ...item, originalNumber: job.candidates[index].originalNumber ?? index + 1 }))
        .filter((item, index) => job.filters[index]?.accepted && !["filtered", "closed", "unavailable"].includes(item.status));
    job.acceptedCount = publishable.length;
    job.parts = formatDigest({ ...job, results: publishable }).map((part) => ({ ...part,
        randomIdHex: randomBytes(8).toString("hex"), sent: false, messageId: null }));
    save(job);
    return job;
}

async function sendPart(client, target, part) {
    const peer = await client.getInputEntity(target);
    const result = await client.invoke(new Api.messages.SendMessage({ peer, message: part.text,
        randomId: readBigIntFromBuffer(Buffer.from(part.randomIdHex, "hex"), true, true),
        noWebpage: true, entities: part.entities.map((entity) => new Api.MessageEntityBold(entity)) }));
    const mapping = result.updates?.find((update) => update.className === "UpdateMessageID" &&
        update.randomId?.toString() === readBigIntFromBuffer(Buffer.from(part.randomIdHex, "hex"), true, true).toString());
    return mapping?.id ?? result.id ?? null;
}

async function publishJob(job, { send, save, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
    if (!job.parts) throw new Error("Digest is not prepared");
    for (const part of job.parts) {
        if (part.sent) continue;
        while (true) {
            try {
                part.messageId = await send(part);
                part.sent = true;
                save(job);
                break;
            } catch (error) {
                if (error.errorMessage === "RANDOM_ID_DUPLICATE") {
                    // Telegram already accepted this exact persisted send identifier.
                    part.sent = true; save(job); break;
                }
                if (error.seconds && /FLOOD|FloodWait/iu.test(`${error.errorMessage} ${error.name} ${error.message}`)) {
                    await pause((error.seconds + 1) * 1000); continue;
                }
                throw error;
            }
        }
    }
    job.completed = true;
    save(job);
}

function acquireLock(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "worker.lock");
    if (fs.existsSync(file)) {
        const { pid } = JSON.parse(fs.readFileSync(file, "utf8"));
        let alive = true;
        try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") alive = false; }
        if (alive) throw new Error(`Digest worker already running (PID ${pid})`);
        fs.unlinkSync(file);
    }
    const fd = fs.openSync(file, "wx");
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
    return () => { fs.closeSync(fd); fs.unlinkSync(file); };
}

function createDigestWorker(client, { dir = path.resolve("config/digests"), intervalMs = 60000,
    log = console.log, prepare = prepareJob, publish = publishJob } = {}) {
    const stateFile = path.join(dir, "state.json");
    let state;
    let entity;
    let timer;
    let scanning;
    let processing;
    let stopped = false;
    let unlock;
    const jobPath = (id) => path.join(dir, `${id}.json`);
    const saveJob = (job) => atomicWrite(jobPath(job.id), job);

    async function scan() {
        if (stopped || scanning) return scanning;
        if (state.retryAfter > Date.now()) return;
        scanning = (async () => {
            // Advance the cursor only after the complete source snapshot is durable.
            for await (const message of client.iterMessages(entity, { minId: state.lastId, reverse: true })) {
                if (stopped) return;
                const job = makeJob(message);
                if (job.candidates.length && !fs.existsSync(jobPath(job.id))) saveJob(job);
                state.lastId = Math.max(state.lastId, message.id);
                atomicWrite(stateFile, state);
            }
        })().catch((error) => {
            if (error.seconds && /FLOOD|FloodWait/iu.test(`${error.errorMessage} ${error.name} ${error.message}`)) {
                state.retryAfter = Date.now() + (error.seconds + 1) * 1000;
                atomicWrite(stateFile, state);
            }
            log(`Digest scan retry next poll: ${error.message}`);
        }).finally(() => { scanning = null; });
        return scanning;
    }

    async function drain() {
        if (stopped || processing) return processing;
        processing = (async () => {
            const files = fs.readdirSync(dir).filter((file) => /^\d+\.json$/u.test(file)).sort((a, b) => parseInt(a) - parseInt(b));
            for (const file of files) {
                if (stopped) return;
                const job = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
                if (job.source !== SOURCE_ID || job.target !== TARGET_ID) throw new Error("Unexpected digest source/target in saved job");
                if (job.completed) continue;
                await prepare(job, { save: saveJob, log });
                if (stopped) return;
                await publish(job, { save: saveJob, send: (part) => sendPart(client, TARGET_ID, part) });
                log(`Digest ${job.id}: sent ${job.parts.length} part(s)`);
            }
        })().catch((error) => log(`Digest retry next poll: ${error.message}`)).finally(() => { processing = null; });
        return processing;
    }

    async function tick() {
        await scan();
        await drain();
    }

    return {
        async start() {
            unlock = acquireLock(dir);
            try {
                entity = await client.getEntity(SOURCE_USERNAME);
                if (`-100${entity.id}` !== SOURCE_ID) throw new Error("Unexpected GrowGlobalJobs channel ID");
                if (fs.existsSync(stateFile)) {
                    state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
                    if (state.source !== SOURCE_ID || !Number.isInteger(state.lastId)) throw new Error("Invalid digest cursor");
                } else {
                    const messages = await client.getMessages(entity, { limit: 1 });
                    state = { version: 1, source: SOURCE_ID, lastId: messages[0]?.id || 0 };
                    atomicWrite(stateFile, state);
                    log(`Digest baseline: ${state.lastId}; only newer posts will be published`);
                }
                stopped = false;
                timer = setInterval(() => { void tick(); }, intervalMs);
                void tick();
            } catch (error) { unlock(); unlock = null; throw error; }
        },
        tick,
        async stop() { stopped = true; clearInterval(timer); await scanning; await processing; if (unlock) { unlock(); unlock = null; } },
    };
}

module.exports = { atomicWrite, makeJob, prepareJob, publishJob, sendPart, createDigestWorker, acquireLock };
