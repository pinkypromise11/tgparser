require("dotenv").config();

const fs = require("fs");
const path = require("node:path");
const { TelegramClient } = require("telegram");
const { NewMessage } = require("telegram/events");
const { FloodWaitError } = require("telegram/errors");
const { StringSession } = require("telegram/sessions");
const { isExcludedChannelId } = require("./src/excluded_channels");
const { isRelevant } = require("./src/post_filter");
const { extractContactCandidates } = require("./src/contact_extractor");
const {
    analyzeApplicationMethods,
    analyzeLinkedinApplication,
    analyzeVacancy,
    analyzeVacancyEmployment,
    analyzeVacancyLocation,
    analyzeVacancyWorkMode,
    assertLlmConfigured,
    formatDecisionHashtags,
} = require("./src/llm");
const { formatVacancyMessage } = require("./src/message_formatter");
const { SOURCE_ID: DIGEST_SOURCE_ID } = require("./src/digest_links");
const { createDigestWorker } = require("./src/digest_worker");
const { createLinkedVacancyWorker } = require("./src/linked_vacancy_worker");
const { loadRuntimeConfig } = require("./src/runtime_config");
const { resolveTargetChat } = require("./src/target_chat");
const { loadTelegramCredentials } = require("./src/telegram_credentials");

let sentCounter = 0;

function loadState(stateFile) {
    if (!fs.existsSync(stateFile)) {
        return { processed: [] };
    }

    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
}

function saveState(stateFile, state) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(
        stateFile,
        JSON.stringify(state, null, 2)
    );
}

function rememberProcessed(stateFile, state, processed, uid) {
    if (processed.has(uid)) return;

    processed.add(uid);
    state.processed.push(uid);
    saveState(stateFile, state);
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
    applicationDecision,
    locationDecision,
    employmentDecision,
    workModeDecision,
    linkedinDecision
) {
    const hashtags = formatDecisionHashtags(
        decision,
        applicationDecision,
        locationDecision,
        employmentDecision,
        workModeDecision,
        linkedinDecision
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
    label,
    { keywords, targetChannel, stateFile }
) {
    if (!message.message) return;
    // The dedicated durable poller owns this channel, including history and retries.
    if (String(channelId) === DIGEST_SOURCE_ID) return;

    const uid = `${channelId}_${message.id}`;

    if (processed.has(uid)) {
        return;
    }

    if (!isRelevant(message.message, channelId, keywords)) {
        return;
    }

    let decision;
    let applicationDecision;
    let locationDecision;
    let employmentDecision;
    let workModeDecision;
    let linkedinDecision;

    try {
        decision = await analyzeVacancy(message.message);

        if (decision.verdict === "reject") {
            rememberProcessed(stateFile, state, processed, uid);
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

        locationDecision = await analyzeVacancyLocation(
            message.message
        );

        console.log(
            `AI location [${locationDecision.location}]: ${uid} (${locationDecision.confidence}%: ${locationDecision.reason})`
        );

        employmentDecision = await analyzeVacancyEmployment(
            message.message
        );
        const employmentLabel = employmentDecision.types.length
            ? employmentDecision.types.join(",")
            : "none";

        console.log(
            `AI employment [${employmentLabel}]: ${uid} (${employmentDecision.confidence}%: ${employmentDecision.reason})`
        );

        workModeDecision = await analyzeVacancyWorkMode(message.message);
        console.log(
            `AI work mode [${workModeDecision.mode}]: ${uid} (${workModeDecision.confidence}%: ${workModeDecision.reason})`
        );

        linkedinDecision = await analyzeLinkedinApplication(
            message.message,
            contactCandidates
        );
        console.log(
            `AI LinkedIn relevance [${linkedinDecision.linkedin}]: ${uid} (${linkedinDecision.confidence}%: ${linkedinDecision.reason})`
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
        applicationDecision,
        locationDecision,
        employmentDecision,
        workModeDecision,
        linkedinDecision
    );

    try {
        await safeSendMessage(client, targetChannel, formatted);

        rememberProcessed(stateFile, state, processed, uid);
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

function waitForShutdown(client, digestWorker, linkedWorker) {
    return new Promise((resolve) => {
        const keepAlive = setInterval(() => {}, 60000);
        let stopping = false;

        async function shutdown(signal) {
            if (stopping) return;
            stopping = true;

            console.log(`Stopping engine (${signal})...`);
            clearInterval(keepAlive);

            try {
                await Promise.all([digestWorker.stop(), linkedWorker.stop()]);
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
    const config = loadRuntimeConfig();
    const channelsInfo = JSON.parse(
        fs.readFileSync(config.channelsFile, "utf8")
    );
    const channels = [
        ...new Set(
            channelsInfo
                .map((item) => String(item.id))
                .filter((id) => id !== config.targetChannel && !isExcludedChannelId(id))
        ),
    ];
    const keywords = JSON.parse(
        fs.readFileSync(config.keywordsFile, "utf8")
    );

    assertLlmConfigured();

    const session = fs
        .readFileSync(config.sessionFile, "utf8")
        .trim();
    const { apiId, apiHash } = loadTelegramCredentials();
    const client = new TelegramClient(
        new StringSession(session),
        apiId,
        apiHash,
        { connectionRetries: 5 }
    );

    await client.connect();
    try {
        const target = await resolveTargetChat(client, config.targetChannel);
        console.log(`Publishing to: ${target.title || config.targetChannel}`);
    } catch (error) {
        await client.destroy();
        throw error;
    }
    console.log("Engine connected");

    const digestWorker = createDigestWorker(client, {
        dir: config.digestStateDir,
        target: config.targetChannel,
    });
    const linkedWorker = createLinkedVacancyWorker(client, {
        channels: channelsInfo,
        dir: config.linkedVacancyStateDir,
        target: config.targetChannel,
    });
    try {
        await digestWorker.start();
        await linkedWorker.start();
    } catch (error) {
        await Promise.all([digestWorker.stop(), linkedWorker.stop()]);
        await client.disconnect();
        throw error;
    }

    const state = loadState(config.stateFile);
    const processed = new Set(state.processed);
    let processingQueue = Promise.resolve();

    function enqueueMessage(channelId, message, label) {
        // Linked posts are owned by the durable poller, before the whole-post keyword filter.
        // This also prevents a second publication via live events or recent-history replay.
        if (linkedWorker.owns(channelId, message)) return Promise.resolve();
        processingQueue = processingQueue
            .then(() =>
                processMessage(
                    client,
                    String(channelId),
                    message,
                    state,
                    processed,
                    label,
                    {
                        keywords,
                        targetChannel: config.targetChannel,
                        stateFile: config.stateFile,
                    }
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
            chats: channels,
            incoming: true,
        })
    );

    console.log("Checking recent history...");

    for (const channelId of channels) {
        if (String(channelId) === DIGEST_SOURCE_ID) continue;
        try {
            const entity = await client.getEntity(channelId);
            const messages = await client.getMessages(
                entity,
                { limit: config.historyLimit }
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
    saveState(config.stateFile, state);

    console.log("Listening for new messages...");
    await waitForShutdown(client, digestWorker, linkedWorker);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
