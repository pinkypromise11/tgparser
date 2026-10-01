require("dotenv").config({ quiet: true });
const fs = require("node:fs");
const path = require("node:path");
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { SOURCE_ID, TARGET_ID } = require("../src/digest_links");
const { atomicWrite } = require("../src/digest_worker");
const { filterDigestVacancy, filterPolicy } = require("../src/digest_filter");

function retainPositions(text, accepted) {
    const matches = [...text.matchAll(/(?:^|\n\n)(\d+)\. /gu)];
    if (!matches.length) throw new Error("Expected numbered digest positions");
    const header = text.slice(0, matches[0].index).trimEnd();
    let result = header;
    const entities = [];
    const retained = [];
    matches.forEach((match, index) => {
        const number = Number(match[1]);
        if (!accepted.has(number)) return;
        const block = text.slice(match.index, matches[index + 1]?.index ?? text.length).trim();
        const offset = result.length + 2;
        result += `\n\n${block}`;
        entities.push({ offset, length: block.split("\n")[0].length });
        retained.push(number);
    });
    if (!retained.length) result += "\n\nПодходящих вакансий по актуальным фильтрам нет.";
    return { text: result, entities, retained };
}

async function main() {
    const id = Number(process.argv[2]);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Usage: refilter_published_digest.js <post-id> [--apply]");
    const receipt = JSON.parse(fs.readFileSync(path.resolve(`config/digest-publications/${id}.json`), "utf8"));
    if (receipt.source !== SOURCE_ID || receipt.target !== TARGET_ID || receipt.id !== id || !receipt.completed ||
        !receipt.parts.length || receipt.parts.some((p) => !Number.isSafeInteger(p.messageId))) throw new Error("Invalid publication receipt");
    const file = path.resolve(`config/digest-refilter/${id}.json`);
    const policy = filterPolicy();
    let plan;
    if (fs.existsSync(file)) {
        plan = JSON.parse(fs.readFileSync(file, "utf8"));
        if (plan.policy !== policy || plan.target !== TARGET_ID || plan.source !== SOURCE_ID || plan.id !== id ||
            plan.edits.length !== receipt.parts.length || plan.edits.some((e, i) => e.messageId !== receipt.parts[i].messageId)) {
            throw new Error("Existing refilter plan differs from current policy/receipt; review it first");
        }
    } else {
        const decisions = [];
        for (let index = 0; index < receipt.candidates.length; index++) {
            const page = receipt.pages[index];
            if (!page) throw new Error(`Missing captured description for position ${index + 1}`);
            decisions.push({ number: index + 1, ...await filterDigestVacancy(receipt.candidates[index], page) });
        }
        const accepted = new Set(decisions.filter((d) => d.accepted).map((d) => d.number));
        plan = { id, source: SOURCE_ID, target: TARGET_ID, policy, decisions, createdAt: new Date().toISOString(),
            edits: receipt.parts.map((part) => ({ messageId: part.messageId, before: part.text,
                after: retainPositions(part.text, accepted), applied: false })) };
    }
    const client = new TelegramClient(new StringSession(fs.readFileSync("session.txt", "utf8").trim()),
        Number(process.env.API_ID), process.env.API_HASH, { connectionRetries: 2 });
    try {
        await client.connect();
        const target = await client.getEntity(TARGET_ID);
        if (`-100${target.id}` !== TARGET_ID) throw new Error("Unexpected target channel");
        const ids = plan.edits.map((edit) => edit.messageId);
        const current = await client.getMessages(target, { ids });
        for (const edit of plan.edits) {
            const actual = current.find((m) => m.id === edit.messageId)?.message;
            if (actual !== edit.before && actual !== edit.after.text) throw new Error(`Message ${edit.messageId} changed since publication; refusing to overwrite`);
        }
        // Store the original text and decisions before the first external edit.
        atomicWrite(file, plan);
        console.log(JSON.stringify({ acceptedNumbers: plan.decisions.filter((d) => d.accepted).map((d) => d.number),
            edits: plan.edits.map((e) => ({ messageId: e.messageId, retained: e.after.retained, text: e.after.text })) }, null, 2));
        if (!process.argv.includes("--apply")) return;
        for (const edit of plan.edits) {
            const latest = (await client.getMessages(target, { ids: [edit.messageId] }))[0];
            if (latest?.message !== edit.after.text) {
                if (latest?.message !== edit.before) throw new Error(`Message ${edit.messageId} changed during editing`);
                while (true) {
                    try {
                        await client.editMessage(target, { message: edit.messageId, text: edit.after.text, linkPreview: false,
                            formattingEntities: edit.after.entities.map((entity) => new Api.MessageEntityBold(entity)) });
                        break;
                    } catch (error) {
                        if (error.seconds && /FLOOD/iu.test(`${error.errorMessage} ${error.message}`)) {
                            await new Promise((resolve) => setTimeout(resolve, (error.seconds + 1) * 1000)); continue;
                        }
                        throw error;
                    }
                }
            }
            const verified = (await client.getMessages(target, { ids: [edit.messageId] }))[0];
            if (verified?.message !== edit.after.text) throw new Error(`Verification failed for ${edit.messageId}`);
            edit.applied = true;
            atomicWrite(file, plan);
        }
        plan.verifiedAt = new Date().toISOString();
        atomicWrite(file, plan);
        console.log("Verified all edits; original numbering preserved. Backup: " + file);
    } finally { await client.disconnect(); }
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { retainPositions };
