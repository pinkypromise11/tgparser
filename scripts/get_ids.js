require("dotenv").config();

const fs = require("fs");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const {
    isExcludedChannelUsername,
    normalizeUsername,
} = require("../src/excluded_channels");
const { loadRuntimeConfig } = require("../src/runtime_config");

const apiId = Number(process.env.API_ID);
const apiHash = process.env.API_HASH;
const runtimeConfig = loadRuntimeConfig();

async function loadIdsFromFile(client, filename, market) {
    const lines = fs
        .readFileSync(filename, "utf8")
        .split(/\r?\n/)
        .map(x => x.trim())
        .filter(Boolean);

    const result = [];

    for (const link of lines) {
        const username = normalizeUsername(link);

        if (isExcludedChannelUsername(username)) {
            console.log(`Skipped excluded channel: ${username}`);
            continue;
        }

        try {
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
        .readFileSync(runtimeConfig.sessionFile, "utf8")
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
        runtimeConfig.channelsFile,
        JSON.stringify(all, null, 2)
    );

    console.log(
        `🎉 Saved to ${runtimeConfig.channelsFile}`
    );

    process.exit(0);
})();
