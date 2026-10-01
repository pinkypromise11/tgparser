require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { SOURCE_USERNAME } = require("../src/digest_links");
const { makeJob, prepareJob, atomicWrite } = require("../src/digest_worker");
const { fetchVacancy } = require("../src/digest_fetch");

async function main() {
    const args = process.argv.slice(2);
    const post = args.find((arg) => /^https:\/\/t\.me\//u.test(arg)) || "https://t.me/GrowGlobalJobs/37";
    const match = /^https:\/\/t\.me\/GrowGlobalJobs\/(\d+)$/iu.exec(post);
    if (!match) throw new Error("Expected https://t.me/GrowGlobalJobs/<post-id>");
    const id = Number(match[1]);
    const dir = path.resolve("config/digest-preview");
    const file = path.join(dir, `${id}.json`);
    let job;
    if (fs.existsSync(file) && !args.includes("--refresh")) job = JSON.parse(fs.readFileSync(file, "utf8"));
    else {
        const client = new TelegramClient(new StringSession(fs.readFileSync("session.txt", "utf8").trim()),
            Number(process.env.API_ID), process.env.API_HASH, { connectionRetries: 2 });
        try {
            await client.connect();
            const messages = await client.getMessages(SOURCE_USERNAME, { ids: [id] });
            if (!messages[0]?.message) throw new Error("Telegram post not found");
            job = makeJob(messages[0]);
            atomicWrite(file, job);
        } finally { await client.disconnect(); }
    }
    console.log(`Found ${job.candidates.length} vacancy links`);
    if (args.includes("--refetch")) { job.pages = []; job.results = []; job.parts = null; atomicWrite(file, job); }
    if (args.includes("--reanalyze")) { job.results = []; job.parts = null; atomicWrite(file, job); }
    const itemOption = args.find((arg) => arg.startsWith("--reanalyze-item="));
    if (itemOption) {
        const index = Number(itemOption.split("=")[1]) - 1;
        if (!Number.isInteger(index) || index < 0 || index >= job.candidates.length) throw new Error("Invalid --reanalyze-item number");
        job.results[index] = null; job.parts = null; atomicWrite(file, job);
    }
    if (args.includes("--retry-unavailable")) {
        job.pages.forEach((page, i) => {
            if (page?.status === "unavailable") { job.pages[i] = null; job.results[i] = null; }
        });
        job.parts = null;
        atomicWrite(file, job);
    }
    if (args.includes("--extract-only")) { console.log(JSON.stringify(job.candidates, null, 2)); return; }
    if (args.includes("--fetch-only")) {
        for (let i = 0; i < job.candidates.length; i++) {
            job.pages[i] ||= await fetchVacancy(job.candidates[i]);
            atomicWrite(file, job);
            console.log(`${i + 1}: ${job.pages[i].status} ${job.pages[i].reason || job.pages[i].title}`);
        }
        return;
    }
    await prepareJob(job, { save: (value) => atomicWrite(file, value) });
    const textFile = path.join(dir, `${id}.txt`);
    fs.writeFileSync(textFile, job.parts.length ? job.parts.map((part) => part.text).join("\n\n==========\n\n") + "\n" : "Подходящих вакансий нет. Причины отбора сохранены в JSON.\n", "utf8");
    console.log(`Preview only, nothing sent. ${job.acceptedCount ?? job.results.length}/${job.candidates.length} positions accepted, ${job.parts.length} parts.\n${textFile}`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
