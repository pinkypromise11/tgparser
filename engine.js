require("dotenv").config();

const fs = require("fs");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");

const apiId = Number(process.env.API_ID);
const apiHash = process.env.API_HASH;

const CHANNELS = JSON.parse(
    fs.readFileSync("config/channels.json", "utf8")
);

const KEYWORDS = JSON.parse(
    fs.readFileSync("config/keywords.json", "utf8")
);

const TARGET_CHANNEL = -1004295313892;
const STATE_FILE = "state.json";

function loadState() {
    if (!fs.existsSync(STATE_FILE)) {
        return { processed: [] };
    }

    return JSON.parse(
        fs.readFileSync(STATE_FILE, "utf8")
    );
}

function saveState(state) {
    fs.writeFileSync(
        STATE_FILE,
        JSON.stringify(state, null, 2)
    );
}

function isRelevant(text = "") {
    const lower = text.toLowerCase();

    const hasInclude = KEYWORDS.include.some(word =>
        lower.includes(word.toLowerCase())
    );

    const hasExclude = KEYWORDS.exclude.some(word =>
        lower.includes(word.toLowerCase())
    );

    return hasInclude && !hasExclude;
}

async function buildMessage(client, channelId, msg) {
    try {
        const entity = await client.getEntity(channelId);

        const sourceTitle =
            entity?.title || "Неизвестный канал";

        let postLink = "Приватный канал";

        if (entity?.username) {
            postLink = `https://t.me/${entity.username}/${msg.id}`;
        }

        return `
💼 ВАКАНСИЯ

📢 Источник: ${sourceTitle}
🔗 ${postLink}

────────────────

${msg.message}
`;
    } catch (e) {
        return `
💼 ВАКАНСИЯ

${msg.message}
`;
    }
}

(async () => {
    const session = fs
        .readFileSync("session.txt", "utf8")
        .trim();

    const client = new TelegramClient(
        new StringSession(session),
        apiId,
        apiHash,
        {
            connectionRetries: 5,
        }
    );

    await client.connect();

    console.log("🚀 ENGINE запущен");

    const state = loadState();

    console.log("📦 Проверка истории...");

    for (const channelId of CHANNELS) {
        try {
            const entity = await client.getEntity(channelId);

            const messages = await client.getMessages(
                entity,
                {
                    limit: 30,
                }
            );

            for (const msg of messages) {
                if (!msg.message) continue;

                const uid = `${channelId}_${msg.id}`;

                if (state.processed.includes(uid)) {
                    continue;
                }

                state.processed.push(uid);

                if (!isRelevant(msg.message)) {
                    continue;
                }

                const formatted =
                    await buildMessage(
                        client,
                        channelId,
                        msg
                    );

                console.log("🔥 HISTORICAL MATCH");

                try {
                    await client.sendMessage(
                        TARGET_CHANNEL,
                        {
                            message: formatted,
                        }
                    );
                } catch (e) {
                    console.log(
                        "❌ Send error:",
                        e.message
                    );
                }
            }
        } catch (e) {
            console.log(
                "⚠️ Channel error:",
                channelId,
                e.message
            );
        }
    }

    saveState(state);

    console.log("📡 Live monitoring...");

    client.addEventHandler(
        async (event) => {
            try {
                const msg = event.message;

                if (!msg || !msg.message) {
                    return;
                }

                const channelId =
                    msg.chatId?.toString();

                if (
                    !CHANNELS.includes(channelId)
                ) {
                    return;
                }

                const uid =
                    `${channelId}_${msg.id}`;

                if (
                    state.processed.includes(uid)
                ) {
                    return;
                }

                state.processed.push(uid);

                if (
                    state.processed.length > 5000
                ) {
                    state.processed.shift();
                }

                saveState(state);

                if (
                    !isRelevant(msg.message)
                ) {
                    return;
                }

                const formatted =
                    await buildMessage(
                        client,
                        channelId,
                        msg
                    );

                console.log("🔥 NEW MATCH");

                await client.sendMessage(
                    TARGET_CHANNEL,
                    {
                        message: formatted,
                    }
                );
            } catch (e) {
                console.log(
                    "❌ Live error:",
                    e.message
                );
            }
        },
        new NewMessage({})
    );
})();