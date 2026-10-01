// Read-only Telegram audit: no posting, editing, joining, or parser state changes.
require("dotenv").config({ quiet: true });
const fs = require("node:fs");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { isExcludedChannelId } = require("../src/excluded_channels");
const { canonicalUrl, extractDigestLinks, TARGET_ID } = require("../src/digest_links");
const { atomicWrite } = require("../src/digest_worker");

function externalLinks(message) {
    const text = message.message || "";
    const found = (message.entities || []).filter(e =>
        ["MessageEntityUrl", "MessageEntityTextUrl"].includes(e.className))
        .map(e => ({ url: e.url || text.slice(e.offset, e.offset + e.length),
            label: text.slice(e.offset, e.offset + e.length), offset: e.offset }));
    for (const m of text.matchAll(/https?:\/\/[^\s<>]+/giu)) {
        found.push({ url: m[0].replace(/[),.;!?\]}]+$/u, ""), label: "", offset: m.index });
    }
    const seen = new Set();
    return found.sort((a, b) => a.offset - b.offset).flatMap(item => {
        const url = canonicalUrl(/^www\./iu.test(item.url) ? `https://${item.url}` : item.url);
        if (!url || seen.has(url) || /(^|\.)(t\.me|telegram\.me|telegram\.org)$/iu.test(new URL(url).hostname)) return [];
        seen.add(url);
        return [{ ...item, url }];
    });
}

async function main() {
    const file = "config/recent-link-roundups-20261001.json";
    const report = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {
        end: new Date().toISOString(), start: new Date(Date.now() - 14 * 86400000).toISOString(), channels: [], posts: [],
    };
    const channels = [...new Map(JSON.parse(fs.readFileSync("config/channels_with_ids.json", "utf8"))
        .filter(c => !isExcludedChannelId(c.id)).map(c => [c.id, c])).values()];
    channels.unshift({ id: TARGET_ID, username: null, target: true });
    const client = new TelegramClient(new StringSession(fs.readFileSync("session.txt", "utf8").trim()),
        Number(process.env.API_ID), process.env.API_HASH, { connectionRetries: 2, floodSleepThreshold: 0 });
    const call = async fn => {
        for (;;) {
            try { return await fn(); } catch (error) {
                if (!error.seconds || !/FLOOD/iu.test(error.errorMessage || error.message)) throw error;
                console.log(`FLOOD_WAIT ${error.seconds}s`);
                await new Promise(resolve => setTimeout(resolve, (error.seconds + 1) * 1000));
            }
        }
    };
    try {
        await client.connect();
        await call(() => client.getDialogs({ limit: 200 }));
        for (const channel of channels) {
            if (report.channels.some(c => c.id === channel.id)) continue;
            const status = { ...channel, scanned: 0, matches: 0 };
            try {
                let entity;
                try { entity = await client.getInputEntity(channel.id); }
                catch { entity = await call(() => client.getEntity(channel.username)); }
                let offsetId = 0, done = false;
                while (!done) {
                    const messages = await call(() => client.getMessages(entity, { limit: 100, offsetId }));
                    if (!messages.length) break;
                    for (const message of messages) {
                        const time = Number(message.date) * 1000;
                        if (time < Date.parse(report.start)) { done = true; break; }
                        if (time > Date.parse(report.end)) continue;
                        status.scanned++;
                        const links = externalLinks(message);
                        if (links.length < 3) continue;
                        status.matches++;
                        report.posts.push({ channel: channel.username || "TARGET", channelId: channel.id,
                            target: !!channel.target, id: message.id, date: new Date(time).toISOString(),
                            link: channel.username ? `https://t.me/${channel.username}/${message.id}` :
                                `https://t.me/c/${channel.id.slice(4)}/${message.id}`,
                            text: message.message, links, jobLinks: extractDigestLinks(message) });
                    }
                    const nextOffset = messages[messages.length - 1].id;
                    if (nextOffset === offsetId) throw new Error("History pagination did not advance");
                    offsetId = nextOffset;
                    await new Promise(resolve => setTimeout(resolve, 250));
                }
                status.complete = true;
            } catch (error) { status.error = error.errorMessage || error.message; }
            report.channels.push(status);
            atomicWrite(file, report);
            console.log(`${report.channels.length}/${channels.length} ${status.username || "TARGET"}: scanned=${status.scanned} candidates=${status.matches} ${status.error || ""}`);
        }
        console.log(JSON.stringify({ start: report.start, end: report.end, candidates: report.posts.length, file }));
    } finally { await client.disconnect(); }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { externalLinks };
