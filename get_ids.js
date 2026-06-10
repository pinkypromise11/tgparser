require("dotenv").config();

const fs = require("fs");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");

const apiId = Number(process.env.API_ID);
const apiHash = process.env.API_HASH;

async function loadIdsFromFile(client, filename, market) {
    const lines = fs
        .readFileSync(filename, "utf8")
        .split(/\r?\n/)
        .map(x => x.trim())
        .filter(Boolean);

    const result = [];

    for (const link of lines) {
        try {
            const username = link
                .replace("https://t.me/", "")
                .replace("@", "")
                .trim();

            const entity =
                await client.getEntity(username);

            const fullId =
                `-100${entity.id}`;

            console.log(
                `✅ ${username} -> ${fullId}`
            );

            result.push({
                market,
                username,
                id: fullId,
                link
            });

        } catch (e) {
            console.log(
                `❌ ${link}: ${e.message}`
            );
        }
    }

    return result;
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

    console.log("🚀 Connected");

    const ru =
        await loadIdsFromFile(
            client,
            "ru.txt",
            "RU"
        );

    const en =
        await loadIdsFromFile(
            client,
            "en.txt",
            "EN"
        );

    const all = [...ru, ...en];

    fs.writeFileSync(
        "channels_with_ids.json",
        JSON.stringify(all, null, 2)
    );

    console.log(
        "🎉 Saved to channels_with_ids.json"
    );

    process.exit(0);
})();