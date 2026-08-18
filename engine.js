require("dotenv").config();

const fs = require("fs");
const { TelegramClient } = require("telegram");
const { FloodWaitError } = require("telegram/errors");
const { StringSession } = require("telegram/sessions");
const { isExcludedChannelId } = require("./excluded_channels");
const { isRelevant } = require("./post_filter");
const { analyzeVacancy, assertLlmConfigured } = require("./llm");

const CHANNELS_INFO = JSON.parse(
    fs.readFileSync("config/channels_with_ids.json", "utf8")
);
const CHANNELS = [
    ...new Set(
        CHANNELS_INFO
            .map((item) => String(item.id))
            .filter((id) => !isExcludedChannelId(id))
    ),
];
const KEYWORDS = JSON.parse(
    fs.readFileSync("config/keywords.json", "utf8")
);
const TARGET_CHANNEL = -1004295313892;
const STATE_FILE = "config/state.json";
const PID_FILE = "config/engine.pid";

let sentCounter = 0;
let ownsPidFile = false;

const sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));

function isProcessRunning(pid) {
    if (!Number.isInteger(pid) || pid <= 0) {
        return false;
    }

    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === "EPERM";
    }
}

function acquireSingleInstanceLock() {
    while (true) {
        try {
            fs.writeFileSync(PID_FILE, String(process.pid), {
                flag: "wx",
            });
            ownsPidFile = true;
            return;
        } catch (error) {
            if (error.code !== "EEXIST") {
                throw error;
            }

            const existingPid = Number.parseInt(
                fs.readFileSync(PID_FILE, "utf8").trim(),
                10
            );

            if (isProcessRunning(existingPid)) {
                throw new Error(
                    `Engine is already running (PID ${existingPid})`
                );
            }

            fs.unlinkSync(PID_FILE);
        }
    }
}

function releaseSingleInstanceLock() {
    if (!ownsPidFile) return;

    try {
        const lockPid = Number.parseInt(
            fs.readFileSync(PID_FILE, "utf8").trim(),
            10
        );

        if (lockPid === process.pid) {
            fs.unlinkSync(PID_FILE);
        }
    } catch (error) {
        if (error.code !== "ENOENT") {
            console.log("PID lock cleanup error:", error.message);
        }
    } finally {
        ownsPidFile = false;
    }
}

function isTemporaryConnectionError(error) {
    const code = String(error?.code || "").toUpperCase();
    const message = String(error?.message || error).toLowerCase();

    return [
        "ECONNRESET",
        "ECONNREFUSED",
        "ETIMEDOUT",
        "EHOSTUNREACH",
        "ENETUNREACH",
        "EPIPE",
    ].includes(code) || [
        "timeout",
        "not connected",
        "disconnected",
        "connection closed",
        "socket closed",
    ].some((text) => message.includes(text));
}

async function waitForConnection(client) {
    let attempt = 0;

    while (!client.connected) {
        attempt++;
        const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt - 1, 5));

        console.log(
            `Telegram disconnected. Waiting ${Math.ceil(delay / 1000)}s before reconnecting...`
        );
        await sleep(delay);

        try {
            await client.connect();
        } catch (error) {
            if (!isTemporaryConnectionError(error)) {
                throw error;
            }
            console.log("Reconnect error:", error.message);
        }
    }
}

async function retryTelegramOperation(client, operationName, operation) {
    let attempt = 0;

    while (true) {
        await waitForConnection(client);

        try {
            return await operation();
        } catch (error) {
            if (!isTemporaryConnectionError(error)) {
                throw error;
            }

            attempt++;
            const delay = Math.min(
                30000,
                1000 * 2 ** Math.min(attempt - 1, 5)
            );
            console.log(
                `${operationName} connection error: ${error.message}. Retry in ${Math.ceil(delay / 1000)}s`
            );
            await sleep(delay);
        }
    }
}

function loadState() {
    if (!fs.existsSync(STATE_FILE)) {
        return { processed: [] };
    }

    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
}

function saveState(state) {
    fs.writeFileSync(
        STATE_FILE,
        JSON.stringify(state, null, 2)
    );
}

async function safeSendMessage(client, target, formatted) {
    while (true) {
        try {
            await retryTelegramOperation(
                client,
                "sendMessage",
                () => client.sendMessage(target, {
                    message: formatted,
                })
            );
            return;
        } catch (error) {
            if (error instanceof FloodWaitError) {
                console.log(`Flood wait: ${error.seconds}s`);
                await sleep((error.seconds + 5) * 1000);
                continue;
            }

            throw error;
        }
    }
}

async function buildMessage(client, channelId, message) {
    try {
        const entity = await retryTelegramOperation(
            client,
            "getEntity",
            () => client.getEntity(channelId)
        );
        const sourceTitle = entity?.title || "Unknown channel";
        const postLink = entity?.username
            ? `https://t.me/${entity.username}/${message.id}`
            : "Private channel";

        return [
            "💼 ВАКАНСИЯ",
            "",
            `📢 Источник: ${sourceTitle}`,
            `🔗 ${postLink}`,
            "",
            "────────────────",
            "",
            message.message,
        ].join("\n");
    } catch {
        return [
            "💼 ВАКАНСИЯ",
            "",
            message.message,
        ].join("\n");
    }
}

async function processMessage(
    client,
    channelId,
    message,
    state,
    processed,
    label
) {
    if (!message.message) return;

    const uid = `${channelId}_${message.id}`;

    if (processed.has(uid)) {
        return;
    }

    if (!isRelevant(message.message, channelId, KEYWORDS)) {
        return;
    }

    try {
        const decision = await analyzeVacancy(message.message);

        if (!decision.relevant) {
            console.log(
                `AI rejected: ${uid} (${decision.confidence}%: ${decision.reason})`
            );
            return;
        }

        console.log(
            `AI approved: ${uid} (${decision.confidence}%: ${decision.reason})`
        );
    } catch (error) {
        console.log(`AI filter error (${uid}):`, error.message);
        return;
    }

    const formatted = await buildMessage(
        client,
        channelId,
        message
    );

    try {
        await safeSendMessage(client, TARGET_CHANNEL, formatted);

        processed.add(uid);
        state.processed.push(uid);
        saveState(state);
        sentCounter++;

        console.log(`${label} match: ${uid}`);

        if (sentCounter % 20 === 0) {
            console.log("Rate-limit pause: 226s");
            await new Promise((resolve) =>
                setTimeout(resolve, 226000)
            );
        }
    } catch (error) {
        console.log("Send error:", error.message);
    }
}

async function main() {
    assertLlmConfigured();
    acquireSingleInstanceLock();
    process.once("exit", releaseSingleInstanceLock);

    const session = fs
        .readFileSync("session.txt", "utf8")
        .trim();
    const client = new TelegramClient(
        new StringSession(session),
        Number(process.env.API_ID),
        process.env.API_HASH,
        {
            useWSS: true,
            connectionRetries: 5,
            retryDelay: 3000,
        }
    );

    try {
        await client.connect();
        console.log("Engine connected");

        const state = loadState();
        const processed = new Set(state.processed);

        console.log("Checking recent history...");

        for (const channelId of CHANNELS) {
            try {
                const entity = await retryTelegramOperation(
                    client,
                    "getEntity",
                    () => client.getEntity(channelId)
                );
                const messages = await retryTelegramOperation(
                    client,
                    "getMessages",
                    () => client.getMessages(
                        entity,
                        { limit: 30 }
                    )
                );

                for (const message of messages) {
                    await processMessage(
                        client,
                        String(channelId),
                        message,
                        state,
                        processed,
                        "Historical"
                    );
                }
            } catch (error) {
                console.log(
                    `Channel error (${channelId}):`,
                    error.message
                );
            }
        }

        saveState(state);
        console.log("Run completed");
    } finally {
        try {
            if (client.connected) {
                client.setLogLevel("none");
                await client.disconnect();
            }
        } finally {
            releaseSingleInstanceLock();
        }
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
