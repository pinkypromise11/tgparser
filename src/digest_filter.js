const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { isRelevant, normalizeText, containsKeyword } = require("./post_filter");
const { analyzeVacancy, normalizeDecision } = require("./llm");
const { SOURCE_ID } = require("./digest_links");

const loadKeywords = () => JSON.parse(fs.readFileSync(path.join(__dirname, "../config/keywords.json"), "utf8"));
const hash = (value) => createHash("sha256").update(value).digest("hex");
function filterPolicy(keywords = loadKeywords()) {
    return hash(JSON.stringify({ version: 1, keywords,
        prefilter: fs.readFileSync(path.join(__dirname, "post_filter.js"), "utf8"),
        ai: fs.readFileSync(path.join(__dirname, "llm.js"), "utf8"),
        exclusions: fs.readFileSync(path.join(__dirname, "../config/excluded_channels.json"), "utf8") }));
}

function buildVacancyText(candidate, page) {
    // Only this vacancy's page: never feed the whole Telegram digest or an AI summary to the filter.
    return [page.title || candidate.label, page.company, page.text].filter(Boolean).join("\n\n");
}

function filterInputHash(candidate, page) {
    return hash(JSON.stringify({ url: candidate.url, status: page.status, text: buildVacancyText(candidate, page) }));
}

async function filterDigestVacancy(candidate, page, { keywords = loadKeywords(), analyze = analyzeVacancy, channelId = SOURCE_ID } = {}) {
    if (page.status !== "readable") return { accepted: false, stage: "unavailable", reason: page.reason || "Описание недоступно" };
    const text = buildVacancyText(candidate, page);
    if (!isRelevant(text, channelId, keywords)) {
        const exclusions = keywords.exclude.filter((word) => containsKeyword(normalizeText(text), word));
        return { accepted: false, stage: "keywords", reason: exclusions.length
            ? `Сработали исключения: ${exclusions.join(", ")}`
            : "Не пройден текущий фильтр ключевых слов, уровня или признаков вакансии" };
    }
    const decision = normalizeDecision(await analyze(text));
    return { accepted: decision.verdict !== "reject", stage: "ai", reason: decision.reason, decision };
}

module.exports = { buildVacancyText, filterInputHash, filterPolicy, filterDigestVacancy };
