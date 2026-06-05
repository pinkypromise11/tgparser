require("dotenv").config();

const fs = require("fs");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");

const apiId = Number(process.env.API_ID);
const apiHash = process.env.API_HASH;

const CHANNELS = JSON.parse(fs.readFileSync("config/channels.json", "utf8"));
const KEYWORDS = JSON.parse(fs.readFileSync("config/keywords.json", "utf8"));

const STATE_FILE = "state.json";
const TARGET_CHANNEL = -1004295313892;

function loadState() {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
}

function saveState(state) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function isRelevant(text = "") {
    const lower = text.toLowerCase();

    const hasInclude = KEYWORDS.include.some(k => lower.includes(k));
    const hasExclude = KEYWORDS.exclude.some(k => lower.includes(k));

    return hasInclude && !hasExclude;
}

(async () => {
    const session = fs.readFileSync("session.txt", "utf8").trim();

    const client = new TelegramClient(
        new StringSession(session),
        apiId,
        apiHash,
        { connectionRetries: 5 }
    );

    await client.connect();

    console.log("🚀 Мониторинг запущен");

    const state = loadState();

    client.addEventHandler(async (event) => {
        const msg = event.message;
        if (!msg || !msg.message) return;

        const channelId = msg.chatId?.toString();

        if (!CHANNELS.includes(channelId)) return;

        const uniqueId = `${channelId}_${msg.id}`;
        if (state.processed.includes(uniqueId)) return;

        state.processed.push(uniqueId);
        if (state.processed.length > 5000) state.processed.shift();

        saveState(state);

        const text = msg.message;

        if (!isRelevant(text)) return;

        console.log("\n🔥 НАЙДЕНО:");
        console.log(text);

        // пересылка в твой канал
        try {
            await client.sendMessage(TARGET_CHANNEL, {
                message: text
            });
        } catch (e) {
            console.log("Ошибка отправки:", e.message);
        }

    }, new NewMessage({}));

})();