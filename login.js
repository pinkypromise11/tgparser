require("dotenv").config();

const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const input = require("input");

const apiId = Number(process.env.API_ID);
const apiHash = process.env.API_HASH;

const stringSession = new StringSession("");

(async () => {
    console.log("Запуск...");

    const client = new TelegramClient(
        stringSession,
        apiId,
        apiHash,
        {
            connectionRetries: 5,
        }
    );

    await client.start({
        phoneNumber: async () => process.env.PHONE,
        password: async () => "",
        phoneCode: async () =>
            await input.text("Введите код из Telegram: "),
        onError: (err) => console.log(err),
    });

    console.log("Успешный вход!");

    const session = client.session.save();

    console.log("\nСОХРАНИ ЭТУ СЕССИЮ:");
    console.log(session);

    const dialogs = await client.getDialogs({ limit: 300 });

    console.log("\nПодписки:\n");

    for (const dialog of dialogs) {
        console.log(dialog.title);
    }

    process.exit();
})();