require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const input = require("input");
const { loadRuntimeConfig } = require("../src/runtime_config");

const apiId = Number(process.env.API_ID);
const apiHash = process.env.API_HASH;
const runtimeConfig = loadRuntimeConfig();

const stringSession = new StringSession("");

(async () => {
    console.log("Запуск...");
    const phone = (process.env.PHONE || "").trim();
    if (!phone) {
        console.error("Укажите PHONE в .env");
        process.exitCode = 1;
        return;
    }
    if (!Number.isSafeInteger(apiId) || apiId <= 0 || !/^[a-f0-9]{32}$/i.test(apiHash || "")) {
        console.error("Проверьте API_ID и API_HASH в .env: ожидаются положительное целое число и 32 шестнадцатеричных символа.");
        process.exitCode = 1;
        return;
    }
    console.log(`Файл .env: ${path.resolve(".env")}`);
    console.log(`Конфигурация: ${runtimeConfig.configPath}`);
    console.log(`Новая сессия после входа будет сохранена: ${runtimeConfig.sessionFile}`);

    const client = new TelegramClient(
        stringSession,
        apiId,
        apiHash,
        {
            connectionRetries: 5,
            floodSleepThreshold: 0,
        }
    );

    // Observe only delivery metadata; never print credentials, code hashes or tokens.
    const invoke = client.invoke.bind(client);
    client.invoke = async (request, ...args) => {
        const result = await invoke(request, ...args);
        if (request instanceof Api.auth.SendCode || request instanceof Api.auth.ResendCode) {
            console.log(`Ответ Telegram: ${result.className}`);
            if (result.type) console.log(`Доставка кода: ${result.type.className}`);
            if (result.nextType) console.log(`Следующий способ: ${result.nextType.className}`);
            if (typeof result.timeout === "number") {
                console.log(`Интервал до повторного запроса: ${result.timeout} с (автоматически не запрашивается)`);
            }
        }
        return result;
    };

    try {
        await client.start({
            phoneNumber: async () => {
                console.log(`Номер для входа: ***${phone.slice(-4)} (из PHONE)`);
                return phone;
            },
            password: async () => await input.password("Облачный пароль Telegram: "),
            phoneCode: async (isCodeViaApp) => {
                console.log(isCodeViaApp
                    ? "Telegram сообщил об отправке кода в служебный чат Telegram на устройствах с активным входом."
                    : "Telegram выбрал другой способ доставки кода. Эта версия GramJS не уточняет его здесь; это не обязательно SMS.");
                return await input.text("Введите код входа: ");
            },
            onError: (err) => {
                console.error("Ошибка авторизации:", err.errorMessage || err.message);
                if (typeof err.seconds === "number") console.error(`Повторить можно через ${err.seconds} с.`);
                // Allow correcting input, but do not repeatedly request codes on server errors.
                return !["PHONE_CODE_INVALID", "PHONE_CODE_EMPTY", "PASSWORD_HASH_INVALID"].includes(err.errorMessage);
            },
        });
    
        console.log("Успешный вход!");
    
        const session = client.session.save();

        fs.mkdirSync(path.dirname(runtimeConfig.sessionFile), { recursive: true });
        fs.writeFileSync(runtimeConfig.sessionFile, session, "utf8");

        console.log(`\nСессия сохранена: ${runtimeConfig.sessionFile}`);
    
        const dialogs = await client.getDialogs({ limit: 300 });
    
        console.log("\nПодписки:\n");
    
        for (const dialog of dialogs) {
            console.log(dialog.title);
        }
    } finally {
        await client.destroy();
    }
})().then(() => process.exit(process.exitCode || 0)).catch((err) => {
    console.error("Вход не завершён:", err.errorMessage || err.message);
    process.exit(1);
});
