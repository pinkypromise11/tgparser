const test = require("node:test");
const assert = require("node:assert/strict");

const {
    EXCLUDED_CHANNELS,
    containsExcludedChannelReference,
    isExcludedChannelId,
    isExcludedChannelUsername,
} = require("./excluded_channels");

test("contains all permanently excluded channels", () => {
    assert.equal(EXCLUDED_CHANNELS.length, 23);

    for (const channel of EXCLUDED_CHANNELS) {
        assert.equal(isExcludedChannelId(channel.id), true);
        assert.equal(
            isExcludedChannelUsername(channel.username),
            true
        );
    }
});

test("matches excluded links, post links, queries, and mentions", () => {
    for (const reference of [
        "https://t.me/gamedevjobtinder",
        "http://telegram.me/GameDev_and_Tech_vacancy/123",
        "t.me/s/young_gamedev/45?single",
        "HTTPS://T.ME/GAMEDEVJOB/4964",
        "@Gamedevjobs",
        "See @gdjobs.",
        "https://t.me/forgamedev/5619#post",
        "telegram.me/devjobs/12415",
        "https://t.me/job_gamedev?start=1",
        "@gamedev_unity_unreal_engine_jobs",
        "https://t.me/ingamejob_qa/100",
    ]) {
        assert.equal(
            containsExcludedChannelReference(reference),
            true,
            reference
        );
    }
});

test("does not match similar allowed usernames", () => {
    for (const reference of [
        "https://t.me/gamedevjobtinder_news",
        "@gdjobs_extra",
        "https://t.me/devjob",
        "https://example.com/gamedevjob",
        "ordinary gamedev discussion",
    ]) {
        assert.equal(
            containsExcludedChannelReference(reference),
            false,
            reference
        );
    }
});
