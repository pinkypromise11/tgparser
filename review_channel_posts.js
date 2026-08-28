require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { TelegramClient } = require("telegram");
const { FloodWaitError } = require("telegram/errors");
const { StringSession } = require("telegram/sessions");
const {
    APPLICATION_METHODS,
    analyzeApplicationMethods,
    analyzePublishedVacancyTag,
    analyzeVacancy,
    enforceApplicationEvidence,
    formatDecisionHashtags,
} = require("./llm");
const { extractContactCandidates } = require("./contact_extractor");

const TARGET_CHANNEL = "-1004295313892";
const KEYWORDS = JSON.parse(
    fs.readFileSync("config/keywords.json", "utf8")
);
const MOSCOW_TIME_ZONE = "Europe/Moscow";
const GENERATED_TAG_LINE = /^#(?:достоверно|проверить)(?:\s+#[\p{L}\p{N}_]+)+\s*$/u;
const APPLICATION_HASHTAGS = Object.freeze([
    "#\u0430\u043d\u043a\u0435\u0442\u0430",
    "#\u0440\u0435\u043a\u0440\u0443\u0442\u0435\u0440",
    "#\u0431\u043e\u0442",
]);
const APPLICATION_HASHTAG_BY_METHOD = Object.freeze({
    company_form: APPLICATION_HASHTAGS[0],
    recruiter: APPLICATION_HASHTAGS[1],
    bot: APPLICATION_HASHTAGS[2],
});
const SEPARATOR = "────────────────";

function dateKey(value = new Date()) {
    const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: MOSCOW_TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    });
    const parts = Object.fromEntries(
        formatter.formatToParts(value).map((part) => [part.type, part.value])
    );

    return `${parts.year}-${parts.month}-${parts.day}`;
}

function messageDate(message) {
    return new Date(Number(message.date) * 1000);
}

function sha256(value) {
    return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function extractVacancyBody(text) {
    const separatorIndex = text.indexOf(SEPARATOR);

    if (separatorIndex === -1) {
        return text.trim();
    }

    return text.slice(separatorIndex + SEPARATOR.length).trim();
}

function upsertDecisionHashtags(text, hashtags) {
    const lines = text.replaceAll("\r\n", "\n").split("\n");
    const headingIndex = lines.findIndex((line) =>
        line.trim() === "💼 ВАКАНСИЯ"
    );

    if (headingIndex === -1) {
        return ["💼 ВАКАНСИЯ", hashtags, "", text.trim()].join("\n");
    }

    const nextLineIndex = headingIndex + 1;

    if (GENERATED_TAG_LINE.test(lines[nextLineIndex] || "")) {
        const existingLine = lines[nextLineIndex];
        const preservedApplicationTags = APPLICATION_HASHTAGS.filter(
            (tag) => existingLine.split(/\s+/u).includes(tag) &&
                !hashtags.split(/\s+/u).includes(tag)
        );

        lines[nextLineIndex] = [
            hashtags,
            ...preservedApplicationTags,
        ].join(" ");
    } else {
        lines.splice(nextLineIndex, 0, hashtags);
    }

    return lines.join("\n");
}

function replaceApplicationHashtags(text, methods) {
    if (!Array.isArray(methods)) {
        throw new Error("Application methods must be an array");
    }

    for (const method of methods) {
        if (!APPLICATION_METHODS.includes(method)) {
            throw new Error(`Unknown application method: ${method}`);
        }
    }

    const lines = text.replaceAll("\r\n", "\n").split("\n");
    const tagLineIndex = lines.findIndex((line) => GENERATED_TAG_LINE.test(line));

    if (tagLineIndex === -1) {
        throw new Error("The published message has no generated hashtag line");
    }

    const baseTags = lines[tagLineIndex]
        .trim()
        .split(/\s+/u)
        .filter((tag) => !APPLICATION_HASHTAGS.includes(tag));
    const applicationTags = APPLICATION_METHODS
        .filter((method) => methods.includes(method))
        .map((method) => APPLICATION_HASHTAG_BY_METHOD[method]);

    lines[tagLineIndex] = [...baseTags, ...applicationTags].join(" ");
    return lines.join("\n");
}

function extractSourceReference(text) {
    const separatorIndex = text.indexOf(SEPARATOR);
    const header = separatorIndex === -1
        ? ""
        : text.slice(0, separatorIndex);
    const match = header.match(
        /https:\/\/t\.me\/(?:s\/)?([A-Z0-9_]+)\/(\d+)/iu
    );

    if (!match) return null;

    return {
        username: match[1],
        messageId: Number(match[2]),
        url: match[0],
    };
}

async function connectTelegram() {
    const session = fs.readFileSync("session.txt", "utf8").trim();
    const client = new TelegramClient(
        new StringSession(session),
        Number(process.env.API_ID),
        process.env.API_HASH,
        { connectionRetries: 5 }
    );

    await client.connect();
    return client;
}

async function getMessagesForDate(client, entity, targetDate) {
    const messages = [];

    for await (const message of client.iterMessages(entity, { limit: 1000 })) {
        const currentDate = dateKey(messageDate(message));

        if (currentDate < targetDate) break;
        if (currentDate !== targetDate) continue;
        messages.push(message);
    }

    return messages.sort((left, right) => left.id - right.id);
}

async function getLastMessages(client, entity, limit) {
    const messages = await client.getMessages(entity, { limit });

    return messages
        .filter((message) => message && message.id)
        .sort((left, right) => left.id - right.id);
}

function planPath(targetDate) {
    const timestamp = new Date().toISOString().replaceAll(":", "-");
    return path.join(
        "config",
        `channel-review-${targetDate}-${timestamp}.json`
    );
}

function retagPlanPath(limit) {
    const timestamp = new Date().toISOString().replaceAll(":", "-");
    return path.join(
        "config",
        `channel-retag-last-${limit}-${timestamp}.json`
    );
}

function applicationPlanPath(limit) {
    const timestamp = new Date().toISOString().replaceAll(":", "-");
    return path.join(
        "config",
        `channel-application-methods-last-${limit}-${timestamp}.json`
    );
}

function writePlan(filePath, plan) {
    fs.writeFileSync(filePath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
}

function summarize(plan) {
    return plan.items.reduce(
        (summary, item) => {
            summary.total++;
            summary[item.action] = (summary[item.action] || 0) + 1;
            return summary;
        },
        { total: 0 }
    );
}

async function buildPlan() {
    const { isRelevant } = require("./post_filter");
    const targetDate = dateKey();
    const filePath = planPath(targetDate);
    const client = await connectTelegram();

    try {
        const entity = await client.getEntity(TARGET_CHANNEL);
        const messages = await getMessagesForDate(client, entity, targetDate);
        const plan = {
            version: 1,
            targetChannel: TARGET_CHANNEL,
            targetDate,
            timeZone: MOSCOW_TIME_ZONE,
            createdAt: new Date().toISOString(),
            items: [],
        };

        console.log(`Found ${messages.length} messages for ${targetDate} (Moscow).`);

        for (const [index, message] of messages.entries()) {
            const originalText = String(message.message || "");
            const body = extractVacancyBody(originalText);
            const base = {
                id: message.id,
                date: messageDate(message).toISOString(),
                originalHash: sha256(originalText),
                originalText,
                preview: body.split(/\r?\n/, 1)[0].slice(0, 180),
            };

            console.log(`[${index + 1}/${messages.length}] Reviewing ${message.id}: ${base.preview}`);

            if (!body) {
                plan.items.push({
                    ...base,
                    action: "error",
                    stage: "content",
                    reason: "Message has no text to classify",
                });
                continue;
            }

            if (!isRelevant(body, TARGET_CHANNEL, KEYWORDS)) {
                plan.items.push({
                    ...base,
                    action: "delete",
                    stage: "prefilter",
                    reason: "Rejected by the strict keyword/vacancy prefilter",
                });
                continue;
            }

            try {
                const decision = await analyzeVacancy(body);

                if (decision.verdict === "reject") {
                    plan.items.push({
                        ...base,
                        action: "delete",
                        stage: "gpt",
                        decision,
                        reason: decision.reason,
                    });
                    continue;
                }

                const hashtags = formatDecisionHashtags(decision);
                const updatedText = upsertDecisionHashtags(
                    originalText,
                    hashtags
                );

                plan.items.push({
                    ...base,
                    action: updatedText === originalText ? "keep" : "edit",
                    stage: "gpt",
                    decision,
                    hashtags,
                    updatedText,
                    reason: decision.reason,
                });
            } catch (error) {
                plan.items.push({
                    ...base,
                    action: "error",
                    stage: "gpt",
                    reason: error.message,
                });
            }
        }

        writePlan(filePath, plan);
        console.log(`PLAN_FILE=${path.resolve(filePath)}`);
        console.log(`SUMMARY=${JSON.stringify(summarize(plan))}`);
    } finally {
        await client.disconnect();
    }
}

async function buildRetagPlan(limit) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        throw new Error("--plan-last requires an integer limit from 1 to 1000");
    }

    const filePath = retagPlanPath(limit);
    const client = await connectTelegram();

    try {
        const entity = await client.getEntity(TARGET_CHANNEL);
        const messages = await getLastMessages(client, entity, limit);
        const plan = {
            version: 1,
            operation: "retag",
            targetChannel: TARGET_CHANNEL,
            scope: {
                type: "last",
                limit,
            },
            createdAt: new Date().toISOString(),
            items: [],
        };

        console.log(`Found ${messages.length} latest messages to retag.`);

        for (const [index, message] of messages.entries()) {
            const originalText = String(message.message || "");
            const body = extractVacancyBody(originalText);
            const base = {
                id: message.id,
                date: messageDate(message).toISOString(),
                originalHash: sha256(originalText),
                originalText,
                preview: body.split(/\r?\n/, 1)[0].slice(0, 180),
            };

            console.log(
                `[${index + 1}/${messages.length}] Retagging ${message.id}: ${base.preview}`
            );

            if (!body) {
                plan.items.push({
                    ...base,
                    action: "keep",
                    stage: "content",
                    reason: "Message has no text to retag",
                });
                continue;
            }

            try {
                const decision = await analyzePublishedVacancyTag(body);

                if (decision.verdict === "skip") {
                    plan.items.push({
                        ...base,
                        action: "keep",
                        stage: "gpt-retag",
                        decision,
                        reason: decision.reason,
                    });
                    continue;
                }

                const hashtags = formatDecisionHashtags(decision);
                const updatedText = upsertDecisionHashtags(
                    originalText,
                    hashtags
                );

                plan.items.push({
                    ...base,
                    action: updatedText === originalText ? "keep" : "edit",
                    stage: "gpt-retag",
                    decision,
                    hashtags,
                    updatedText,
                    reason: decision.reason,
                });
            } catch (error) {
                plan.items.push({
                    ...base,
                    action: "error",
                    stage: "gpt-retag",
                    reason: error.message,
                });
            }
        }

        writePlan(filePath, plan);
        console.log(`PLAN_FILE=${path.resolve(filePath)}`);
        console.log(`SUMMARY=${JSON.stringify(summarize(plan))}`);
    } finally {
        await client.disconnect();
    }
}

async function getSourceMessage(client, reference, entityCache) {
    let entity = entityCache.get(reference.username.toLowerCase());

    if (!entity) {
        entity = await client.getEntity(reference.username);
        entityCache.set(reference.username.toLowerCase(), entity);
    }

    const messages = await client.getMessages(entity, {
        ids: [reference.messageId],
    });

    return messages.find((message) =>
        message && message.id === reference.messageId
    ) || null;
}

async function buildApplicationPlan(limit) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        throw new Error(
            "--plan-applications-last requires an integer limit from 1 to 1000"
        );
    }

    const filePath = applicationPlanPath(limit);
    const client = await connectTelegram();
    const entityCache = new Map();

    try {
        const entity = await client.getEntity(TARGET_CHANNEL);
        const messages = await getLastMessages(client, entity, limit);
        const plan = {
            version: 1,
            operation: "application-methods",
            targetChannel: TARGET_CHANNEL,
            scope: {
                type: "last",
                limit,
            },
            createdAt: new Date().toISOString(),
            items: [],
        };

        console.log(
            `Found ${messages.length} latest messages to classify application methods.`
        );

        for (const [index, message] of messages.entries()) {
            const originalText = String(message.message || "");
            const body = extractVacancyBody(originalText);
            const sourceReference = extractSourceReference(originalText);
            const base = {
                id: message.id,
                date: messageDate(message).toISOString(),
                originalHash: sha256(originalText),
                originalText,
                preview: body.split(/\r?\n/, 1)[0].slice(0, 180),
                sourceReference,
            };

            console.log(
                `[${index + 1}/${messages.length}] Application methods ${message.id}: ${base.preview}`
            );

            if (!body) {
                plan.items.push({
                    ...base,
                    action: "error",
                    stage: "content",
                    reason: "Message has no vacancy body to classify",
                });
                continue;
            }

            if (!originalText.split(/\r?\n/u).some((line) =>
                GENERATED_TAG_LINE.test(line)
            )) {
                plan.items.push({
                    ...base,
                    action: "keep",
                    stage: "content",
                    reason: "Service message has no generated vacancy hashtag line",
                });
                continue;
            }

            let sourceMessage = null;
            let sourceResolution = sourceReference
                ? { status: "not_found" }
                : { status: "unavailable" };

            if (sourceReference) {
                try {
                    sourceMessage = await getSourceMessage(
                        client,
                        sourceReference,
                        entityCache
                    );
                    sourceResolution = sourceMessage
                        ? { status: "resolved" }
                        : { status: "not_found" };
                } catch (error) {
                    sourceResolution = {
                        status: "failed",
                        reason: error.message,
                    };
                }
            }

            const classificationMessage = sourceMessage || { message: body };
            const classificationText = String(
                classificationMessage.message || body
            );
            const contactCandidates = extractContactCandidates(
                classificationMessage
            );

            try {
                const decision = await analyzeApplicationMethods(
                    classificationText,
                    contactCandidates
                );
                const updatedText = replaceApplicationHashtags(
                    originalText,
                    decision.methods
                );
                const hashtags = updatedText
                    .split(/\r?\n/u)
                    .find((line) => GENERATED_TAG_LINE.test(line));

                plan.items.push({
                    ...base,
                    action: updatedText === originalText ? "keep" : "edit",
                    stage: "gpt-application-methods",
                    sourceResolution,
                    contactCandidates,
                    decision,
                    hashtags,
                    updatedText,
                    reason: decision.reason,
                });
            } catch (error) {
                plan.items.push({
                    ...base,
                    action: "error",
                    stage: "gpt-application-methods",
                    sourceResolution,
                    contactCandidates,
                    reason: error.message,
                });
            }
        }

        writePlan(filePath, plan);
        console.log(`PLAN_FILE=${path.resolve(filePath)}`);
        console.log(`SUMMARY=${JSON.stringify(summarize(plan))}`);
    } finally {
        await client.disconnect();
    }
}

function readPlan(filePath) {
    const resolved = path.resolve(filePath);
    const plan = JSON.parse(fs.readFileSync(resolved, "utf8"));

    if (plan.targetChannel !== TARGET_CHANNEL) {
        throw new Error(`Unexpected target channel in plan: ${plan.targetChannel}`);
    }

    if (!Array.isArray(plan.items) || !plan.items.length) {
        throw new Error("The review plan contains no messages");
    }

    if (plan.items.some((item) => item.action === "error")) {
        throw new Error("The review plan has unresolved errors and cannot be applied");
    }

    if (
        ["retag", "application-methods"].includes(plan.operation) &&
        plan.items.some((item) => item.action === "delete")
    ) {
        throw new Error("A tagging-only plan cannot contain delete actions");
    }

    return { plan, resolved };
}

function refreshRetagPlan(filePath) {
    const { plan, resolved } = readPlan(filePath);

    if (plan.operation !== "retag") {
        throw new Error("Only retag plans can be refreshed");
    }

    for (const item of plan.items) {
        if (
            !item.decision ||
            !["certain", "review"].includes(item.decision.verdict)
        ) {
            item.action = "keep";
            delete item.hashtags;
            delete item.updatedText;
            continue;
        }

        const hashtags = formatDecisionHashtags(item.decision);
        const updatedText = upsertDecisionHashtags(
            item.originalText,
            hashtags
        );

        item.action = updatedText === item.originalText ? "keep" : "edit";
        item.hashtags = hashtags;
        item.updatedText = updatedText;
    }

    plan.refreshedAt = new Date().toISOString();
    writePlan(resolved, plan);
    console.log(`REFRESHED=${JSON.stringify(summarize(plan))}`);
}

function refreshApplicationPlan(filePath) {
    const { plan, resolved } = readPlan(filePath);

    if (plan.operation !== "application-methods") {
        throw new Error("Only application-method plans can be refreshed");
    }

    for (const item of plan.items) {
        if (!item.decision) {
            item.action = "keep";
            delete item.hashtags;
            delete item.updatedText;
            continue;
        }

        const decision = enforceApplicationEvidence(
            item.decision,
            extractVacancyBody(item.originalText),
            item.contactCandidates
        );
        const updatedText = replaceApplicationHashtags(
            item.originalText,
            decision.methods
        );

        item.action = updatedText === item.originalText ? "keep" : "edit";
        item.decision = decision;
        item.hashtags = updatedText
            .split(/\r?\n/u)
            .find((line) => GENERATED_TAG_LINE.test(line));
        item.updatedText = updatedText;
        item.reason = decision.reason;
    }

    plan.refreshedAt = new Date().toISOString();
    writePlan(resolved, plan);
    console.log(`REFRESHED=${JSON.stringify(summarize(plan))}`);
}

async function getCurrentMessagesById(client, entity, ids) {
    const messages = await client.getMessages(entity, { ids });

    return new Map(
        messages
            .filter((message) =>
                message &&
                message.id &&
                typeof message.message === "string"
            )
            .map((message) => [message.id, message])
    );
}

function assertMessageMatchesPlanState(item, currentText) {
    if (item.appliedAt) {
        const expectedText = item.updatedText || item.originalText;

        if (currentText !== expectedText) {
            throw new Error(
                `Preflight failed: applied message ${item.id} changed`
            );
        }

        return;
    }

    if (sha256(currentText) !== item.originalHash) {
        throw new Error(`Preflight failed: message ${item.id} changed`);
    }
}

async function waitForFlood(seconds) {
    let remaining = seconds + 5;

    while (remaining > 0) {
        const chunk = Math.min(55, remaining);
        console.log(`Flood wait resume in ${remaining}s...`);
        await new Promise((resolve) => setTimeout(resolve, chunk * 1000));
        remaining -= chunk;
    }
}

async function editMessageWithFloodWait(client, entity, item) {
    while (true) {
        try {
            await client.editMessage(entity, {
                message: item.id,
                text: item.updatedText,
                parseMode: false,
            });
            return;
        } catch (error) {
            if (!(error instanceof FloodWaitError)) throw error;
            await waitForFlood(error.seconds);
        }
    }
}

async function applyPlan(filePath) {
    const { plan, resolved } = readPlan(filePath);
    const client = await connectTelegram();

    try {
        const entity = await client.getEntity(TARGET_CHANNEL);
        const ids = plan.items.map((item) => item.id);
        const current = await getCurrentMessagesById(client, entity, ids);

        for (const item of plan.items) {
            const message = current.get(item.id);

            if (!message) {
                if (
                    plan.operation === "application-methods" &&
                    !item.appliedAt
                ) {
                    item.action = "missing";
                    item.reason = "Message disappeared before application-method tagging";
                    item.missingAt = new Date().toISOString();
                    writePlan(resolved, plan);
                    continue;
                }

                throw new Error(`Preflight failed: message ${item.id} is missing`);
            }

            const currentText = String(message.message || "");
            assertMessageMatchesPlanState(item, currentText);
        }

        for (const [index, item] of plan.items.entries()) {
            if (item.appliedAt) {
                console.log(
                    `[${index + 1}/${plan.items.length}] Already applied ${item.id}`
                );
                continue;
            }

            if (item.action === "delete") {
                await client.deleteMessages(entity, [item.id], { revoke: true });
                console.log(`[${index + 1}/${plan.items.length}] Deleted ${item.id}`);
            } else if (item.action === "missing") {
                console.log(`[${index + 1}/${plan.items.length}] Missing ${item.id}`);
            } else if (item.action === "edit") {
                await editMessageWithFloodWait(client, entity, item);
                console.log(
                    `[${index + 1}/${plan.items.length}] Tagged ${item.id}: ${item.hashtags}`
                );
            } else {
                console.log(`[${index + 1}/${plan.items.length}] Kept ${item.id}`);
            }

            item.appliedAt = new Date().toISOString();
            writePlan(resolved, plan);
        }

        plan.completedAt = new Date().toISOString();
        writePlan(resolved, plan);
        console.log(`APPLIED=${JSON.stringify(summarize(plan))}`);
    } finally {
        await client.disconnect();
    }
}

async function verifyPlan(filePath) {
    const { plan } = readPlan(filePath);
    const client = await connectTelegram();

    try {
        const entity = await client.getEntity(TARGET_CHANNEL);
        const ids = plan.items.map((item) => item.id);
        const current = await getCurrentMessagesById(client, entity, ids);
        const failures = [];

        for (const item of plan.items) {
            const message = current.get(item.id);

            if (["delete", "missing"].includes(item.action)) {
                if (message) failures.push(`${item.id}: still exists`);
                continue;
            }

            if (!message) {
                failures.push(`${item.id}: missing after edit`);
                continue;
            }

            const expectedText = item.updatedText || item.originalText;

            if (String(message.message || "") !== expectedText) {
                failures.push(`${item.id}: text does not match the plan`);
            }
        }

        if (!["retag", "application-methods"].includes(plan.operation)) {
            const remainingToday = await getMessagesForDate(
                client,
                entity,
                plan.targetDate
            );
            const expectedRemainingIds = new Set(
                plan.items
                    .filter((item) => item.action !== "delete")
                    .map((item) => item.id)
            );

            for (const message of remainingToday) {
                if (!expectedRemainingIds.has(message.id)) {
                    failures.push(`${message.id}: unreviewed message exists`);
                    continue;
                }

                const hasGeneratedTags = String(message.message || "")
                    .split(/\r?\n/)
                    .some((line) => GENERATED_TAG_LINE.test(line));

                if (!hasGeneratedTags) {
                    failures.push(`${message.id}: generated hashtags are missing`);
                }
            }

            if (remainingToday.length !== expectedRemainingIds.size) {
                failures.push(
                    `expected ${expectedRemainingIds.size} remaining messages, found ${remainingToday.length}`
                );
            }
        }

        if (failures.length) {
            throw new Error(`Verification failed: ${failures.join("; ")}`);
        }

        console.log(`VERIFIED=${JSON.stringify(summarize(plan))}`);
    } finally {
        await client.disconnect();
    }
}

async function main() {
    const [mode = "--plan", argument] = process.argv.slice(2);

    if (mode === "--plan") {
        await buildPlan();
        return;
    }

    if (mode === "--plan-last") {
        await buildRetagPlan(Number(argument));
        return;
    }

    if (mode === "--plan-applications-last") {
        await buildApplicationPlan(Number(argument));
        return;
    }

    if (!argument) {
        throw new Error(`${mode} requires a review-plan file path`);
    }

    if (mode === "--apply") {
        await applyPlan(argument);
        return;
    }

    if (mode === "--refresh-retag") {
        refreshRetagPlan(argument);
        return;
    }

    if (mode === "--refresh-applications") {
        refreshApplicationPlan(argument);
        return;
    }

    if (mode === "--verify") {
        await verifyPlan(argument);
        return;
    }

    throw new Error(`Unknown mode: ${mode}`);
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}

module.exports = {
    assertMessageMatchesPlanState,
    dateKey,
    extractVacancyBody,
    extractSourceReference,
    getLastMessages,
    replaceApplicationHashtags,
    upsertDecisionHashtags,
};
