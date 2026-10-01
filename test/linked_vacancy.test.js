const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { extractLinkedVacancies } = require('../src/linked_vacancy_links');
const { createLinkedVacancyWorker } = require('../src/linked_vacancy_worker');
const { TARGET_ID, SOURCE_ID } = require('../src/digest_links');
const { formatDigest } = require('../src/digest_format');
const id = '-1001234567890';
const source = { id, username: 'test_jobs' };
const msg = (n, date = 101) => ({ id: n, date, message: 'Senior React Developer https://example.com/jobs/' + n });
function hidden(text, pairs) { return { message: text, entities: pairs.map(([label, url]) => ({ className: 'MessageEntityTextUrl', offset: text.indexOf(label), length: label.length, url })) }; }

test('generic extraction: Unicode, hidden/plain URLs, numbering, duplicate URLs and ads', () => {
    const m = hidden('😀  Подборка\n1. Senior React Developer\n2. Senior Python Developer\n3. Senior Go Developer\nПодписаться на наш канал\nhttps://t.me/foo\nhttps://example.com/jobs/catalog', [
        ['Senior React Developer', 'https://example.com/jobs/1'], ['Senior Python Developer', 'https://example.com/jobs/1'],
        ['Senior Go Developer', 'https://example.com/jobs/3'], ['Подписаться на наш канал', 'https://ads.example/promo']]);
    const result = extractLinkedVacancies(m);
    assert.deepEqual(result.slice(0, 2).map(c => c.originalNumber), [1, 3]);
    assert.ok(result.every(c => !/ads.example|t.me/.test(c.url)));
    assert.ok(!result[0].context.includes('Python'));
});

test('single vacancy details are routed, unrelated company/social links are not', () => {
    assert.equal(extractLinkedVacancies(hidden('Senior React Developer\nПодробности и отклик', [['Подробности и отклик', 'https://example.com/opening/123']])).length, 1);
    assert.equal(extractLinkedVacancies(hidden('Senior React Developer\nСайт компании', [['Сайт компании', 'https://example.com/']])).length, 0);
    assert.equal(extractLinkedVacancies(hidden('Senior React Developer\nНаш LinkedIn', [['Наш LinkedIn', 'https://www.linkedin.com/company/acme/']])).length, 0);
    assert.equal(extractLinkedVacancies({ message: 'Senior React Developer — присылайте резюме @hr' }).length, 0);
});

test('young hidden vacancies preserve separate own contexts and original numbers', () => {
    const m = hidden('1. Senior Python Developer\n2. Senior React Developer', [['Senior Python Developer', 'https://wantapply.com/python'], ['Senior React Developer', 'https://wantapply.com/react']]);
    const result = extractLinkedVacancies(m, 'young_relocate');
    assert.deepEqual(result.map(c => c.originalNumber), [1, 2]);
    assert.ok(!result[1].context.includes('Python'));
});

test('private source header never points to GrowGlobalJobs', () => {
    const results = [{ title: 'Developer', url: 'https://example.com/jobs/1', status: 'open', conflicts: [], employment: [], application: [], summary: 'Описание.' }];
    const [p] = formatDigest({ id: 9, source: id, date: 100, results });
    assert.match(p.text, /t\.me\/c\/1234567890\/9/u);
    assert.doesNotMatch(p.text, /GrowGlobalJobs/u);
});

function harness(t, extra = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-worker-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    let messages = [msg(10, 99)], time = 100000;
    const published = [], prepared = [];
    const client = {
        getEntity: async sid => ({ id: sid === source.username ? id.slice(4) : sid.slice(4) }),
        iterMessages: async function* (entity, opts) {
            const rows = messages.filter(m => !opts.minId || m.id > opts.minId).slice();
            rows.sort((a, b) => opts.reverse ? a.id - b.id : b.id - a.id);
            for (const m of rows) yield m;
        },
    };
    const options = { dir, channels: [source, { id: SOURCE_ID }, { id: TARGET_ID }], now: () => time, intervalMs: 60000, log: () => {},
        prepare: async (job, { save }) => { prepared.push(job.id); job.parts = []; save(job); },
        publish: async (job, { save }) => { published.push(job.id); job.completed = true; save(job); }, ...extra };
    return { dir, client, options, published, prepared, setMessages: m => { messages = m; }, setTime: v => { time = v; },
        worker: () => createLinkedVacancyWorker(client, options) };
}

test('first activation ignores old posts; new links and restart catch-up are durable without duplicates', async t => {
    const h = harness(t);
    let w = h.worker(); await w.start(); await w.tick();
    assert.deepEqual(h.published, []);
    assert.equal(w.owns(id, msg(11)), true);
    assert.equal(w.owns(TARGET_ID, msg(11)), false);
    assert.equal(w.owns(SOURCE_ID, msg(11)), false);
    h.setMessages([msg(11), msg(12)]); await w.tick(); await w.stop();
    assert.deepEqual(h.published, [11, 12]);
    h.setMessages([msg(11), msg(12), msg(13)]);
    w = h.worker(); await w.start(); await w.tick(); await w.stop();
    assert.deepEqual(h.published, [11, 12, 13]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, 'state.json'))).sources[id].lastId, 13);
});

test('LLM failure keeps job pending, later jobs proceed, restart retries pending job', async t => {
    let fail = true;
    const h = harness(t, { prepare: async (job, { save }) => { if (job.id === 11 && fail) throw Error('LLM unavailable'); job.parts = []; save(job); } });
    let w = h.worker(); await w.start(); await w.tick();
    h.setMessages([msg(11), msg(12)]); await w.tick(); await w.stop();
    assert.deepEqual(h.published, [12]);
    const job = JSON.parse(fs.readFileSync(path.join(h.dir, 'jobs', `${id}_11.json`)));
    assert.equal(job.completed, false); assert.match(job.error, /LLM/);
    fail = false; h.setTime(200000);
    w = h.worker(); await w.start(); await w.tick(); await w.stop();
    assert.deepEqual(h.published, [12, 11]);
});

test('global FloodWait defers scans without advancing the source cursor', async t => {
    const h = harness(t);
    let fail = true;
    const base = h.client.getEntity;
    h.client.getEntity = async sid => { if (fail) throw Object.assign(Error('FLOOD_WAIT_2'), { seconds: 2 }); return base(sid); };
    const w = h.worker(); await w.start(); await w.tick();
    assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, 'state.json'))).sources[id].lastId, null);
    fail = false; h.setTime(104000); await w.tick(); await w.stop();
    assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, 'state.json'))).sources[id].lastId, 10);
});

test('collects new posts while prior linked vacancy analysis is still running', async t => {
    let release, began;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { began = resolve; });
    const h = harness(t, { prepare: async (job, { save }) => { began(); await gate; job.parts = []; save(job); } });
    const w = h.worker(); await w.start(); await w.tick();
    h.setMessages([msg(11)]);
    const first = w.tick(); await started;
    h.setMessages([msg(11), msg(12)]);
    const second = w.tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(fs.existsSync(path.join(h.dir, 'jobs', `${id}_12.json`)));
    assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, 'state.json'))).sources[id].lastId, 12);
    release(); await first; await second; await w.tick(); await w.stop();
    assert.deepEqual(h.published, [11, 12]);
});
