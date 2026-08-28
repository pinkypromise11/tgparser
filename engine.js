require("dotenv").config();

const fs = require("fs");
const { TelegramClient } = require("telegram");
const { NewMessage } = require("telegram/events");
const { FloodWaitError } = require("telegram/errors");
const { StringSession } = require("telegram/sessions");
const { isExcludedChannelId } = require("./excluded_channels");
const { isRelevant } = require("./post_filter");
const { extractContactCandidates } = require("./contact_extractor");
const {
    analyzeApplicationMethods,
    analyzeVacancy,
    assertLlmConfigured,
    formatDecisionHashtags,
} = require("./llm");
const { formatVacancyMessage } = require("./message_formatter");

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

let sentCounter = 0;

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

function rememberProcessed(state, processed, uid) {
    if (processed.has(uid)) return;

    processed.add(uid);
    state.processed.push(uid);
    saveState(state);
}

async function safeSendMessage(client, target, formatted) {
    while (true) {
        try {
            await client.sendMessage(target, {
                message: formatted,
            });
            return;
        } catch (error) {
            if (error instanceof FloodWaitError) {
                console.log(`Flood wait: ${error.seconds}s`);
                await new Promise((resolve) =>
                    setTimeout(
                        resolve,
                        (error.seconds + 5) * 1000
                    )
                );
                continue;
            }

            throw error;
        }
    }
}

async function buildMessage(
    client,
    channelId,
    message,
    decision,
    applicationDecision
) {
    const hashtags = formatDecisionHashtags(
        decision,
        applicationDecision
    );

    try {
        const entity = await client.getEntity(channelId);
        const sourceTitle = entity?.title || "Unknown channel";
        const postLink = entity?.username
            ? `https://t.me/${entity.username}/${message.id}`
            : "Private channel";

        return formatVacancyMessage({
            hashtags,
            postText: message.message,
            sourceTitle,
            postLink,
        });
    } catch {
        return formatVacancyMessage({
            hashtags,
            postText: message.message,
        });
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

    let decision;
    let applicationDecision;

    try {
        decision = await analyzeVacancy(message.message);

        if (decision.verdict === "reject") {
            rememberProcessed(state, processed, uid);
            console.log(
                `AI rejected: ${uid} (${decision.confidence}%: ${decision.reason})`
            );
            return;
        }

        console.log(
            `AI approved [${decision.verdict}/${decision.primary_stack}]: ${uid} (${decision.confidence}%: ${decision.reason})`
        );

        const contactCandidates = extractContactCandidates(message);
        applicationDecision = await analyzeApplicationMethods(
            message.message,
            contactCandidates
        );
        const applicationLabel = applicationDecision.methods.length
            ? applicationDecision.methods.join(",")
            : "none";

        console.log(
            `AI application methods [${applicationLabel}]: ${uid} (${applicationDecision.confidence}%: ${applicationDecision.reason})`
        );
    } catch (error) {
        console.log(`AI filter error (${uid}):`, error.message);
        return;
    }

    const formatted = await buildMessage(
        client,
        channelId,
        message,
        decision,
        applicationDecision
    );

    try {
        await safeSendMessage(client, TARGET_CHANNEL, formatted);

        rememberProcessed(state, processed, uid);
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

function waitForShutdown(client) {
    return new Promise((resolve) => {
        const keepAlive = setInterval(() => {}, 60000);
        let stopping = false;

        async function shutdown(signal) {
            if (stopping) return;
            stopping = true;

            console.log(`Stopping engine (${signal})...`);
            clearInterval(keepAlive);

            try {
                await client.disconnect();
            } finally {
                resolve();
            }
        }

        process.once("SIGINT", () => shutdown("SIGINT"));
        process.once("SIGTERM", () => shutdown("SIGTERM"));
    });
}

async function main() {
    assertLlmConfigured();

    const session = fs
        .readFileSync("session.txt", "utf8")
        .trim();
    const client = new TelegramClient(
        new StringSession(session),
        Number(process.env.API_ID),
        process.env.API_HASH,
        { connectionRetries: 5 }
    );

    await client.connect();
    console.log("Engine connected");

    const state = loadState();
    const processed = new Set(state.processed);
    let processingQueue = Promise.resolve();

    function enqueueMessage(channelId, message, label) {
        processingQueue = processingQueue
            .then(() =>
                processMessage(
                    client,
                    String(channelId),
                    message,
                    state,
                    processed,
                    label
                )
            )
            .catch((error) => {
                console.log(
                    "Processing error:",
                    error.message
                );
            });

        return processingQueue;
    }

    client.addEventHandler(
        (event) => {
            const channelId = event.chatId?.toString();

            if (!channelId) return;

            return enqueueMessage(
                channelId,
                event.message,
                "Live"
            );
        },
        new NewMessage({
            chats: CHANNELS,
            incoming: true,
        })
    );

    console.log("Checking recent history...");

    for (const channelId of CHANNELS) {
        try {
            const entity = await client.getEntity(channelId);
            const messages = await client.getMessages(
                entity,
                { limit: 30 }
            );

            for (const message of messages) {
                await enqueueMessage(
                    channelId,
                    message,
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

    await processingQueue;
    saveState(state);

    console.log("Listening for new messages...");
    await waitForShutdown(client);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
