require("dotenv").config();

const fs = require("fs");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");

const apiId = Number(process.env.API_ID);
const apiHash = process.env.API_HASH;

const CHANNELS = JSON.parse(fs.readFileSync("config/channels.json", "utf8"));
const KEYWORDS = JSON.parse(fs.readFileSync("config/keywords.json", "utf8"));

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

    console.log("🚀 Сканирование истории каналов...\n");

    for (const channelId of CHANNELS) {
        try {
            const entity = await client.getEntity(channelId);

            const messages = await client.getMessages(entity, { limit: 20 });

            console.log(`\n📢 Канал: ${channelId}`);

            for (const msg of messages) {
                if (!msg.message) continue;

                if (isRelevant(msg.message)) {
                    console.log("\n🔥 НАЙДЕНО:");
                    console.log(msg.message);
                    console.log("-----");
                }
            }

        } catch (e) {
            console.log("Ошибка канала:", channelId, e.message);
        }
    }

    console.log("\n✅ Скан завершён");
    process.exit();
})();