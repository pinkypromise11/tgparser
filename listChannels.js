require("dotenv").config();

const fs = require("fs");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");

const apiId = Number(process.env.API_ID);
const apiHash = process.env.API_HASH;

(async () => {
    const session = fs.readFileSync("session.txt", "utf8").trim();

    const client = new TelegramClient(
        new StringSession(session),
        apiId,
        apiHash,
        { connectionRetries: 5 }
    );

    await client.connect();

    const dialogs = await client.getDialogs({ limit: 500 });

    console.log("\n=== КАНАЛЫ ===\n");

    for (const dialog of dialogs) {
        console.log(
            JSON.stringify({
                title: dialog.title,
                id: dialog.id?.toString(),
                isChannel: dialog.isChannel,
            })
        );
    }

    process.exit();
})();