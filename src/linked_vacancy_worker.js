const fs = require('node:fs');
const path = require('node:path');
const { SOURCE_ID, TARGET_ID } = require('./digest_links');
const { isExcludedChannelId } = require('./excluded_channels');
const { extractLinkedVacancies } = require('./linked_vacancy_links');
const { atomicWrite, acquireLock, prepareJob, publishJob, sendPart } = require('./digest_worker');

function createLinkedVacancyWorker(client, { channels, dir = path.resolve('config/linked-vacancies'),
    intervalMs = 60000, log = console.log, prepare = prepareJob, publish = publishJob, now = Date.now } = {}) {
    const sources = new Map(channels.filter(c => String(c.id) !== SOURCE_ID && String(c.id) !== TARGET_ID && !isExcludedChannelId(c.id))
        .map(c => [String(c.id), { id: String(c.id), username: c.username || '' }]));
    const stateFile = path.join(dir, 'state.json');
    const jobsDir = path.join(dir, 'jobs');
    let state, unlock, timer, scanning, processing, stopped = true;
    const entities = new Map();
    const jobPath = (source, id) => path.join(jobsDir, `${source}_${id}.json`);
    const saveJob = job => atomicWrite(jobPath(job.source, job.id), job);
    const saveState = () => atomicWrite(stateFile, state);

    function owns(channelId, message) {
        const source = sources.get(String(channelId));
        return !!source && extractLinkedVacancies(message, source.username).length > 0;
    }

    function collect(source, message, cursor) {
        if (!message.message || Number(message.date) < cursor.since) return;
        const candidates = extractLinkedVacancies(message, source.username);
        const file = jobPath(source.id, message.id);
        if (!candidates.length || fs.existsSync(file)) return;
        saveJob({ version: 1, source: source.id, sourceUsername: source.username, target: TARGET_ID,
            id: message.id, date: Number(message.date), sourceText: message.message,
            candidates, pages: [], results: [], parts: null, completed: false });
        log(`Linked vacancies queued: ${source.username || source.id}/${message.id} (${candidates.length})`);
    }

    async function scan() {
        if (stopped || scanning) return scanning;
        scanning = (async () => {
            if (state.retryAfter > now()) return;
            for (const source of sources.values()) {
                if (stopped || state.retryAfter > now()) break;
                const cursor = state.sources[source.id];
                if (cursor.retryAfter > now()) continue;
                try {
                    let entity = entities.get(source.id);
                    if (!entity) {
                        entity = await client.getEntity(source.username || source.id);
                        if (`-100${entity.id}` !== source.id) throw Error('Unexpected source channel ID');
                        entities.set(source.id, entity);
                    }
                    // First scan captures a baseline and only posts newer than activation time.
                    // Descending scan stops at activation, so years of history are not traversed.
                    if (cursor.lastId === null) {
                        let latest = 0;
                        for await (const message of client.iterMessages(entity, {})) {
                            latest = Math.max(latest, message.id);
                            if (Number(message.date) < cursor.since) break;
                            collect(source, message, cursor);
                        }
                        cursor.lastId = latest;
                        saveState();
                    } else {
                        for await (const message of client.iterMessages(entity, { minId: cursor.lastId, reverse: true })) {
                            if (stopped) return;
                            collect(source, message, cursor); // journal BEFORE advancing the cursor
                            cursor.lastId = Math.max(cursor.lastId, message.id);
                            saveState();
                        }
                    }
                    cursor.retryAfter = 0;
                    delete cursor.error;
                } catch (error) {
                    const flood = error.seconds && /FLOOD|FloodWait/iu.test(`${error.errorMessage} ${error.name} ${error.message}`);
                    if (flood) state.retryAfter = now() + (error.seconds + 1) * 1000;
                    else cursor.retryAfter = now() + (/PRIVATE|INVALID|BANNED|USERNAME_NOT_OCCUPIED/iu.test(error.message) ? 3600000 : intervalMs);
                    cursor.error = error.message;
                    saveState();
                    log(`Linked source retry (${source.username || source.id}): ${error.message}`);
                }
            }
        })().catch(e => log(`Linked scan retry: ${e.message}`)).finally(() => { scanning = null; });
        return scanning;
    }

    async function drain() {
        if (stopped || processing) return processing;
        processing = (async () => {
            const jobs = fs.readdirSync(jobsDir).filter(f => /^-100\d+_\d+\.json$/u.test(f))
                .map(f => JSON.parse(fs.readFileSync(path.join(jobsDir, f), 'utf8')))
                .sort((a, b) => a.date - b.date || a.id - b.id);
            for (const job of jobs) {
                if (stopped) break;
                if (job.completed || job.retryAfter > now() || !sources.has(job.source)) continue;
                if (job.target !== TARGET_ID) throw Error('Unexpected linked vacancy target');
                try {
                    await prepare(job, { save: saveJob, log });
                    if (stopped) break;
                    await publish(job, { save: saveJob, send: part => sendPart(client, TARGET_ID, part) });
                    delete job.error; delete job.retryAfter; saveJob(job);
                    log(`Linked vacancies completed: ${job.sourceUsername}/${job.id}; accepted=${job.acceptedCount || 0}, parts=${job.parts.length}`);
                } catch (error) {
                    job.error = error.message;
                    job.attempts = (job.attempts || 0) + 1;
                    job.retryAfter = now() + Math.min(3600000, intervalMs * 2 ** Math.min(job.attempts - 1, 6));
                    saveJob(job);
                    log(`Linked job retry ${job.sourceUsername}/${job.id}: ${error.message}`);
                }
            }
        })().catch(e => log(`Linked queue retry: ${e.message}`)).finally(() => { processing = null; });
        return processing;
    }

    async function tick() { await scan(); await drain(); }
    return {
        owns, tick,
        async start() {
            unlock = acquireLock(dir);
            try {
                fs.mkdirSync(jobsDir, { recursive: true });
                state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { version: 1, sources: {} };
                if (state.version !== 1 || !state.sources) throw Error('Invalid linked vacancy state');
                for (const source of sources.values()) {
                    state.sources[source.id] ||= { since: Math.floor(now() / 1000), lastId: null };
                    const c = state.sources[source.id];
                    if (!Number.isInteger(c.since) || !(c.lastId === null || Number.isInteger(c.lastId))) throw Error('Invalid linked vacancy cursor');
                }
                saveState();
                stopped = false;
                log(`Linked vacancy worker active: ${sources.size} sources, interval=${intervalMs}ms`);
                timer = setInterval(() => { void tick(); }, intervalMs);
                void tick();
            } catch (error) { unlock(); unlock = null; throw error; }
        },
        async stop() { stopped = true; clearInterval(timer); await scanning; await processing; if (unlock) { unlock(); unlock = null; } },
    };
}
module.exports = { createLinkedVacancyWorker };
