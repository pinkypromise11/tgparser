const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { loadRuntimeConfig } = require("../src/runtime_config");

test("loads user configuration and resolves paths beside it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-parser-config-"));
    const configPath = path.join(dir, "custom.json");

    fs.writeFileSync(configPath, JSON.stringify({
        targetChannel: "-10042",
        channelsFile: "channels.json",
        keywordsFile: "keywords.json",
        sessionFile: "private/session.txt",
        stateFile: "private/state.json",
    }));

    const config = loadRuntimeConfig({
        argv: ["--config", "custom.json"],
        env: {},
        cwd: dir,
    });

    assert.equal(config.targetChannel, "-10042");
    assert.equal(config.historyLimit, 30);
    assert.equal(config.sessionFile, path.join(dir, "private", "session.txt"));
    assert.equal(config.stateFile, path.join(dir, "private", "state.json"));
});

test("rejects a configuration without a target channel", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-parser-config-"));
    fs.writeFileSync(path.join(dir, "telegram-parser.config.json"), JSON.stringify({
        channelsFile: "channels.json",
        keywordsFile: "keywords.json",
        sessionFile: "session.txt",
        stateFile: "state.json",
    }));

    assert.throws(
        () => loadRuntimeConfig({ argv: [], env: {}, cwd: dir }),
        /targetChannel/u
    );
});
