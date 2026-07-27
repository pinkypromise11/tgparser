const INVALID_CHANNELS = require("./invalidchannel.json");

const EXCLUDED_CHANNELS = Object.freeze([
    {
        username: "gamedevjobtinder",
        id: "-1001621850024",
    },
    {
        username: "GameDev_and_Tech_vacancy",
        id: "-1001880470709",
    },
    {
        username: "young_gamedev",
        id: "-1001554207312",
    },
    {
        username: "gamedevjob",
        id: "-1001109222536",
    },
    {
        username: "Gamedevjobs",
        id: "-1001131473833",
    },
    {
        username: "gdjobs",
        id: "-1001535202319",
    },
    {
        username: "forgamedev",
        id: "-1001311122978",
    },
    {
        username: "devjobs",
        id: "-1001120288601",
    },
    {
        username: "job_gamedev",
        id: "-1001682988147",
    },
    {
        username: "gamedev_unity_unreal_engine_jobs",
        id: "-1001660822720",
    },
    {
        username: "ingamejob_qa",
        id: "-1001200409456",
    },
    ...INVALID_CHANNELS.map((channel) => ({
        username: channel.link.split("/").pop(),
        id: channel.chat_id,
    })),
]);

const EXCLUDED_CHANNEL_IDS = new Set(
    EXCLUDED_CHANNELS.map((channel) => channel.id)
);
const EXCLUDED_CHANNEL_USERNAMES = new Set(
    EXCLUDED_CHANNELS.map((channel) =>
        channel.username.toLowerCase()
    )
);

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const usernameAlternation = [...EXCLUDED_CHANNEL_USERNAMES]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");
const EXCLUDED_REFERENCE_PATTERN = new RegExp(
    [
        `(?:https?:\\/\\/)?(?:t\\.me|telegram\\.me)\\/(?:s\\/)?(?:${usernameAlternation})(?![a-z0-9_])`,
        `@(?:${usernameAlternation})(?![a-z0-9_])`,
    ].join("|"),
    "i"
);

function normalizeUsername(value = "") {
    return String(value)
        .trim()
        .replace(/^@/, "")
        .replace(
            /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(?:s\/)?/i,
            ""
        )
        .split(/[/?#\s]/, 1)[0]
        .toLowerCase();
}

function isExcludedChannelId(channelId) {
    return EXCLUDED_CHANNEL_IDS.has(String(channelId));
}

function isExcludedChannelUsername(value) {
    return EXCLUDED_CHANNEL_USERNAMES.has(
        normalizeUsername(value)
    );
}

function containsExcludedChannelReference(text = "") {
    return EXCLUDED_REFERENCE_PATTERN.test(String(text));
}

module.exports = {
    EXCLUDED_CHANNELS,
    EXCLUDED_CHANNEL_IDS,
    EXCLUDED_CHANNEL_USERNAMES,
    containsExcludedChannelReference,
    isExcludedChannelId,
    isExcludedChannelUsername,
    normalizeUsername,
};
