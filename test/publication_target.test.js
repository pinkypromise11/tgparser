const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Api } = require("telegram");
const { SOURCE_ID } = require("../src/digest_links");
const { makeJob, atomicWrite, createDigestWorker } = require("../src/digest_worker");
const { createLinkedVacancyWorker } = require("../src/linked_vacancy_worker");
const { loadRuntimeConfig } = require("../src/runtime_config");

const config = loadRuntimeConfig({ argv: [], env: { TELEGRAM_PARSER_CONFIG: "telegram-parser.config.example.json" }, cwd: path.resolve(__dirname, "..") });

test("the installation config routes VEU Jobs to its separate queues", () => {
    assert.equal(config.targetChannel, "-1003963771418");
    assert.ok(config.digestStateDir.endsWith(path.join("targets", "3963771418", "digests")));
    assert.ok(config.linkedVacancyStateDir.endsWith(path.join("targets", "3963771418", "linked-vacancies")));
});

test("publication jobs and both workers require an explicit destination", () => {
    for (const target of [undefined, null, "", "  "]) {
        assert.throws(() => makeJob({ id: 1 }, { target }), /targetChannel/u);
        assert.throws(() => createDigestWorker({}, { target }), /targetChannel/u);
        assert.throws(() => createLinkedVacancyWorker({}, { target, channels: [] }), /targetChannel/u);
    }
});

for (const kind of ["digest", "linked"]) {
    async function runWorker(t, savedTarget) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publication-target-"));
        t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
        const source = kind === "digest" ? SOURCE_ID : "-1001234567";
        const requests = [], logs = [];
        const job = makeJob({ id: 42, date: 101 }, { source, target: savedTarget });
        const linked = kind === "linked";
        atomicWrite(path.join(dir, "state.json"), linked ?
            { version: 1, sources: { [source]: { since: 100, lastId: 42 } } } : { version: 1, source, lastId: 42 });
        const jobPath = path.join(dir, linked ? "jobs" : "", linked ? `${source}_42.json` : "42.json");
        atomicWrite(jobPath, job);
        const client = {
            getEntity: async () => ({ id: source.slice(4) }),
            iterMessages: async function* () {},
            getInputEntity: async (target) => {
                assert.equal(target, config.targetChannel);
                return new Api.InputPeerChannel({ channelId: BigInt(target.slice(4)), accessHash: 1n });
            },
            invoke: async (request) => { requests.push(request); return { id: 123 }; },
        };
        const options = { dir, target: config.targetChannel, channels: [{ id: source, username: "test_source" }],
            intervalMs: 100000, log: (message) => logs.push(message),
            prepare: async (pending, { save }) => {
                pending.parts = [{ text: "Test vacancy", entities: [], randomIdHex: "0123456789abcdef", sent: false }];
                save(pending);
            } };
        const worker = linked ? createLinkedVacancyWorker(client, options) : createDigestWorker(client, options);
        try { await worker.start(); await worker.tick(); }
        finally { await worker.stop(); }
        return { requests, logs, job: JSON.parse(fs.readFileSync(jobPath, "utf8")) };
    }

    test(`${kind} worker sends through Telegram transport to the configured VEU Jobs channel`, async (t) => {
        const result = await runWorker(t, config.targetChannel);
        assert.equal(result.requests.length, 1);
        assert.ok(result.requests[0] instanceof Api.messages.SendMessage);
        assert.equal(String(result.requests[0].peer.channelId), "3963771418");
        assert.equal(result.job.target, config.targetChannel);
        assert.equal(result.job.completed, true);
    });

    test(`${kind} worker refuses a saved job for another channel without sending`, async (t) => {
        const result = await runWorker(t, "-1009876543210");
        assert.equal(result.requests.length, 0);
        assert.equal(result.job.completed, false);
        assert.ok(result.logs.some((message) => /Unexpected.*target/u.test(message)));
    });
}
