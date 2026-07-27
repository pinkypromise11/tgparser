require("dotenv").config();

const fs = require("fs");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const {
    isExcludedChannelId,
    isExcludedChannelUsername,
} = require("./excluded_channels");
const { isRelevant } = require("./post_filter");

const CHANNELS_FILE = "config/channels_with_ids.json";
const KEYWORDS_FILE = "config/keywords.json";
const OUTPUT_FILE = "posts.json";
const HOURS = 72;

const channels = JSON.parse(
    fs.readFileSync(CHANNELS_FILE, "utf8")
).filter((channel) =>
    !isExcludedChannelId(channel.id) &&
    !isExcludedChannelUsername(channel.username || channel.link)
);
const keywords = JSON.parse(fs.readFileSync(KEYWORDS_FILE, "utf8"));

function unixSeconds(value) {
    if (value instanceof Date) {
        return Math.floor(value.getTime() / 1000);
    }

    return Number(value);
}

(async () => {
    const cutoff = Math.floor(Date.now() / 1000) - HOURS * 60 * 60;
    const session = fs.readFileSync("session.txt", "utf8").trim();
    const client = new TelegramClient(
        new StringSession(session),
        Number(process.env.API_ID),
        process.env.API_HASH,
        { connectionRetries: 5 }
    );
    const posts = [];

    await client.connect();

    try {
        for (const channel of channels) {
            try {
                const entity = await client.getEntity(channel.id);

                for await (const message of client.iterMessages(entity, {})) {
                    const timestamp = unixSeconds(message.date);

                    if (timestamp < cutoff) break;
                    if (
                        !message.message ||
                        !isRelevant(message.message, channel.id, keywords)
                    ) continue;

                    posts.push({
                        channel_id: String(channel.id),
                        market: channel.market ?? null,
                        source: entity.title ?? null,
                        post_id: message.id,
                        date: new Date(timestamp * 1000).toISOString(),
                        link: entity.username
                            ? `https://t.me/${entity.username}/${message.id}`
                            : null,
                        text: message.message,
                    });
                }
            } catch (error) {
                console.error(`Channel ${channel.id}: ${error.message}`);
            }
        }
    } finally {
        await client.disconnect();
    }

    posts.sort((a, b) => new Date(b.date) - new Date(a.date));

    const numberedPosts = posts.map((post, index) => ({
        number: index + 1,
        ...post,
    }));

    fs.writeFileSync(
        OUTPUT_FILE,
        `${JSON.stringify(numberedPosts, null, 2)}\n`,
        "utf8"
    );

    console.log(`Saved ${numberedPosts.length} posts to ${OUTPUT_FILE}`);
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
