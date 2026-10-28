const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_CONFIG_FILE = "telegram-parser.config.json";

function argumentValue(argv, name) {
    const index = argv.indexOf(name);

    if (index === -1) return null;
    if (!argv[index + 1] || argv[index + 1].startsWith("-")) {
        throw new Error(`${name} requires a file path`);
    }

    return argv[index + 1];
}

function requiredString(value, field) {
    if (value === null || value === undefined || String(value).trim() === "") {
        throw new Error(`Missing required configuration field: ${field}`);
    }

    return String(value).trim();
}

function resolveConfiguredPath(baseDir, value, field) {
    return path.resolve(baseDir, requiredString(value, field));
}

function requirePublicationTarget(value) {
    return requiredString(value, "targetChannel");
}

function loadRuntimeConfig({
    argv = process.argv.slice(2),
    env = process.env,
    cwd = process.cwd(),
} = {}) {
    const requestedPath = argumentValue(argv, "--config") ||
        argumentValue(argv, "-c") ||
        env.TELEGRAM_PARSER_CONFIG ||
        DEFAULT_CONFIG_FILE;
    const configPath = path.resolve(cwd, requestedPath);

    if (!fs.existsSync(configPath)) {
        throw new Error(
            `Configuration file not found: ${configPath}. ` +
            `Copy telegram-parser.config.example.json to ${DEFAULT_CONFIG_FILE} and fill it in.`
        );
    }

    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (error) {
        throw new Error(`Cannot read configuration ${configPath}: ${error.message}`);
    }

    const baseDir = path.dirname(configPath);
    const historyLimit = raw.historyLimit === undefined ? 30 : Number(raw.historyLimit);

    if (!Number.isInteger(historyLimit) || historyLimit < 1) {
        throw new Error("historyLimit must be a positive integer");
    }

    return Object.freeze({
        configPath,
        targetChannel: requirePublicationTarget(raw.targetChannel),
        historyLimit,
        channelsFile: resolveConfiguredPath(baseDir, raw.channelsFile, "channelsFile"),
        keywordsFile: resolveConfiguredPath(baseDir, raw.keywordsFile, "keywordsFile"),
        sessionFile: resolveConfiguredPath(baseDir, raw.sessionFile, "sessionFile"),
        stateFile: resolveConfiguredPath(baseDir, raw.stateFile, "stateFile"),
        digestStateDir: resolveConfiguredPath(
            baseDir,
            raw.digestStateDir || ".telegram-parser/digests",
            "digestStateDir"
        ),
        linkedVacancyStateDir: resolveConfiguredPath(
            baseDir,
            raw.linkedVacancyStateDir || ".telegram-parser/linked-vacancies",
            "linkedVacancyStateDir"
        ),
    });
}

module.exports = {
    DEFAULT_CONFIG_FILE,
    loadRuntimeConfig,
    requirePublicationTarget,
};
