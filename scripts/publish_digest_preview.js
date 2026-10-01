require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { SOURCE_ID, TARGET_ID } = require("../src/digest_links");
const { atomicWrite, prepareJob, publishJob, sendPart } = require("../src/digest_worker");

async function main() {
    const id = Number(process.argv[2]);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Usage: node scripts/publish_digest_preview.js <post-id>");
    // A separate outbox prevents the background poller from racing a manual publication.
    const receipt = path.resolve(`config/digest-publications/${id}.json`);
    const preview = path.resolve(`config/digest-preview/${id}.json`);
    const job = JSON.parse(fs.readFileSync(fs.existsSync(receipt) ? receipt : preview, "utf8"));
    if (job.source !== SOURCE_ID || job.target !== TARGET_ID || job.id !== id || !Array.isArray(job.parts) ||
        job.parts.some((part) => !part.text || part.text.length > 3900 || !/^[a-f0-9]{16}$/u.test(part.randomIdHex))) {
        throw new Error("Invalid prepared digest or unexpected source/target");
    }
    if (!job.completed) await prepareJob(job, { save: (value) => atomicWrite(receipt, value) });
    if (!job.parts.length) { job.completed = true; atomicWrite(receipt, job); console.log("No matching vacancies; nothing sent."); return; }
    const client = new TelegramClient(new StringSession(fs.readFileSync("session.txt", "utf8").trim()),
        Number(process.env.API_ID), process.env.API_HASH, { connectionRetries: 2 });
    try {
        await client.connect();
        const target = await client.getEntity(TARGET_ID);
        if (`-100${target.id}` !== TARGET_ID) throw new Error("Unexpected target channel");
        atomicWrite(receipt, job);
        await publishJob(job, { save: (value) => atomicWrite(receipt, value), send: (part) => sendPart(client, TARGET_ID, part) });
        if (job.parts.some((part) => !part.messageId)) {
            const latest = await client.getMessages(target, { limit: 100 });
            for (const part of job.parts) {
                if (!part.messageId) part.messageId = latest.find((message) => message.message === part.text)?.id || null;
            }
            atomicWrite(receipt, job);
        }
        if (job.parts.some((part) => !part.messageId)) throw new Error("Sent, but some message IDs could not be recovered; inspect receipt before retrying");
        const messages = await client.getMessages(target, { ids: job.parts.map((part) => part.messageId) });
        for (const part of job.parts) {
            const message = messages.find((m) => m.id === part.messageId);
            if (message?.message !== part.text) throw new Error(`Verification failed for message ${part.messageId}`);
            const bold = (message.entities || []).filter((e) => e.className === "MessageEntityBold");
            if (!part.entities.every((expected) => bold.some((actual) => actual.offset === expected.offset && actual.length === expected.length))) {
                throw new Error(`Title formatting verification failed for ${part.messageId}`);
            }
        }
        job.verifiedAt = new Date().toISOString();
        atomicWrite(receipt, job);
        console.log(JSON.stringify({ verified: true, positions: job.results.length, parts: job.parts.map((part) => ({
            id: part.messageId, url: target.username ? `https://t.me/${target.username}/${part.messageId}` : `https://t.me/c/${target.id}/${part.messageId}`,
        })) }, null, 2));
    } finally { await client.disconnect(); }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
