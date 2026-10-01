require("dotenv").config();

const fs = require("fs");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");

(async () => {
    const client = new TelegramClient(
        new StringSession(fs.readFileSync("session.txt", "utf8").trim()),
        Number(process.env.API_ID),
        process.env.API_HASH,
        { connectionRetries: 5 }
    );

    await client.connect();

    const dialogs = await client.getDialogs({ limit: 500 });

    console.log("\n=== НАЙДЕННЫЕ КАНАЛЫ ===\n");

    for (const d of dialogs) {
        if (d.isChannel) {
            console.log(d.title, "=>", d.id.toString());
        }
    }

    process.exit();
})();