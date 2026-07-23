require("dotenv").config();

const fs = require("fs");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");

const { FloodWaitError } = require("telegram/errors");

async function safeSendMessage(client, target, formatted) {
    while (true) {
        try {
            await client.sendMessage(target, {
                message: formatted,
            });

            return;
        } catch (e) {

            if (e instanceof FloodWaitError) {
                console.log(`⏳ FloodWait: ${e.seconds}s`);

                await new Promise(resolve =>
                    setTimeout(resolve, (e.seconds + 5) * 1000)
                );

                continue;
            }

            throw e;
        }
    }
}

const apiId = Number(process.env.API_ID);
const apiHash = process.env.API_HASH;

const CHANNELS_INFO = JSON.parse(
    fs.readFileSync(
        "config/channels_with_ids.json",
        "utf8"
    )
);

const CHANNELS = CHANNELS_INFO.map(
    item => item.id
);

const KEYWORDS = JSON.parse(
    fs.readFileSync("config/keywords.json", "utf8")
);

const MARKET_BY_CHANNEL = {};

for (const item of CHANNELS_INFO) {
    MARKET_BY_CHANNEL[item.id] =
        item.market;
}

const TARGET_CHANNEL = -1004295313892;
let sentCounter = 0;
const STATE_FILE = "config/state.json";

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

                if (!isRelevant(msg.message)) {
                    continue;
                }

                state.processed.push(uid);
                

                const formatted =
                    await buildMessage(
                        client,
                        channelId,
                        msg
                    );

                console.log("🔥 HISTORICAL MATCH");

                try {
                    await safeSendMessage(client, TARGET_CHANNEL, formatted);

                    sentCounter++;

                    if (sentCounter % 20 === 0) {
                        console.log(
                            "⏳ Пауза 226 секунд..."
                        );

                        await new Promise(resolve =>
                            setTimeout(resolve, 226000)
                        );
                    }
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
})();
