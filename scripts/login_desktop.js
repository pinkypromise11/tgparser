const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const input = require("input");
const { loadRuntimeConfig } = require("../src/runtime_config");

function argumentValue(argv, name) {
    const index = argv.indexOf(name);
    if (index === -1) return undefined;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Укажите значение ${name}.`);
    return value;
}

function assertDesktopClosed() {
    if (process.platform !== "win32") return;
    const processes = execFileSync("tasklist.exe", ["/FI", "IMAGENAME eq Telegram.exe", "/FO", "CSV", "/NH"], {
        encoding: "utf8",
        windowsHide: true,
    });
    if (/"Telegram\.exe"/i.test(processes)) {
        throw new Error("Полностью закройте Telegram Desktop: значок Telegram в трее → Выйти из Telegram. Из аккаунта выходить не нужно. Затем повторите команду.");
    }
}

// Conversion gets read access only; it cannot change the Desktop data.
const readOnlyFs = {
    readFile: (file) => fs.promises.readFile(file),
    stat: async (file) => {
        try {
            const stat = await fs.promises.stat(file);
            return { size: stat.size, lastModified: stat.mtimeMs };
        } catch (error) {
            if (error.code === "ENOENT") return undefined;
            throw error;
        }
    },
};

async function loadDesktopSession(tdataPath, account, askPassword) {
    const { Tdata, convertFromTdata, convertToGramjsSession } = await import("@mtcute/convert");
    const options = { path: tdataPath, ignoreVersion: true, fs: readOnlyFs };
    let tdata;
    try {
        tdata = await Tdata.open(options);
    } catch (error) {
        if (!/invalid password/i.test(error.message)) throw error;
        const passcode = await askPassword("Локальный код-пароль Telegram Desktop: ");
        tdata = await Tdata.open({ ...options, passcode });
    }
    const index = account === undefined ? tdata.keyData.active : Number(account);
    if (!Number.isInteger(index) || !tdata.keyData.order.includes(index)) {
        throw new Error(`Выберите аккаунт через --account. Доступные номера: ${tdata.keyData.order.join(", ")}.`);
    }
    return convertToGramjsSession(await convertFromTdata(tdata, index));
}

function saveSession(sessionFile, session) {
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    const temporary = `${sessionFile}.${randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporary, session, { encoding: "utf8", mode: 0o600, flag: "wx" });
        fs.renameSync(temporary, sessionFile);
    } finally {
        fs.rmSync(temporary, { force: true });
    }
}

async function authorizeFromDesktop({ desktop, client, apiId, apiHash, phone, askPassword }) {
    await desktop.connect();
    const owner = await desktop.getMe();
    if (!owner || owner.bot) throw new Error("В Telegram Desktop нет действующего входа пользователя.");
    if (String(owner.phone || "").replace(/\D/g, "") !== phone.replace(/\D/g, "")) {
        throw new Error("Выбран другой аккаунт Telegram Desktop. Переключитесь на нужный аккаунт перед закрытием приложения или укажите --account с его номером (0, 1, …).");
    }

    await client.connect();
    await client.signInUserWithQrCode({ apiId, apiHash }, {
        // Confirm the new login with the existing local session, without an SMS or camera.
        qrCode: async ({ token }) => {
            console.log("Подтверждение отдельной сессии парсера через Telegram Desktop…");
            await desktop.invoke(new Api.auth.AcceptLoginToken({ token }));
        },
        password: async () => askPassword("Облачный пароль Telegram: "),
        onError: (error) => {
            console.error("Ошибка авторизации:", error.errorMessage || error.message);
            return error.errorMessage !== "PASSWORD_HASH_INVALID";
        },
    });
    const authorized = await client.getMe();
    if (!authorized || String(authorized.id) !== String(owner.id)) {
        throw new Error("Не удалось подтвердить аккаунт новой сессии. Файл сессии не изменён.");
    }
    return client.session.save();
}

async function main(argv = process.argv.slice(2)) {
    if (argv.includes("--help")) {
        console.log("Вход через Telegram Desktop без кода из сообщения.\n" +
            "Сначала полностью закройте Telegram Desktop через значок в трее (не выходите из аккаунта).\n" +
            "node scripts/login_desktop.js [--tdata <путь>] [--account <номер>] [--config <файл>]\n" +
            "По умолчанию используется текущий аккаунт Desktop; его номер должен совпадать с PHONE в .env.");
        return;
    }
    require("dotenv").config();
    const apiId = Number(process.env.API_ID);
    const apiHash = process.env.API_HASH;
    const phone = (process.env.PHONE || "").trim();
    if (!Number.isSafeInteger(apiId) || apiId <= 0 || !/^[a-f0-9]{32}$/i.test(apiHash || "") || !/\d/.test(phone)) {
        throw new Error("Проверьте API_ID, API_HASH и PHONE в .env.");
    }
    const config = loadRuntimeConfig({ argv });
    const tdataPath = argumentValue(argv, "--tdata") ||
        (process.env.APPDATA && path.join(process.env.APPDATA, "Telegram Desktop", "tdata"));
    if (!tdataPath || !fs.existsSync(tdataPath)) {
        throw new Error("Папка Telegram Desktop не найдена. Укажите --tdata с путём к своей папке tdata.");
    }
    assertDesktopClosed();
    const desktopSession = await loadDesktopSession(tdataPath, argumentValue(argv, "--account"), input.password);
    const options = { connectionRetries: 2, floodSleepThreshold: 0, deviceModel: "TelegramParser", appVersion: "1.0" };
    const desktop = new TelegramClient(new StringSession(desktopSession), apiId, apiHash, options);
    const client = new TelegramClient(new StringSession(""), apiId, apiHash, options);
    try {
        const session = await authorizeFromDesktop({ desktop, client, apiId, apiHash, phone, askPassword: input.password });
        saveSession(config.sessionFile, session);
        console.log(`Сессия сохранена: ${config.sessionFile}`);
        console.log("Теперь можно открыть Telegram Desktop и запустить node engine.js.");
    } finally {
        // Disconnect, never logOut: logging out would revoke the original Desktop session.
        await Promise.allSettled([client.destroy(), desktop.destroy()]);
    }
}

if (require.main === module) {
    main().then(() => process.exit(0)).catch((error) => {
        console.error("Вход не завершён:", error.errorMessage || error.message);
        if (typeof error.seconds === "number") console.error(`Повторить можно через ${error.seconds} с.`);
        process.exit(1);
    });
}

module.exports = { authorizeFromDesktop, loadDesktopSession, saveSession };
