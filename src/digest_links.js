const SOURCE_ID = "-1004309301539";
const SOURCE_USERNAME = "GrowGlobalJobs";
const TARGET_ID = "-1004295313892";
const SECTION = /^(?:backend|frontend|full[ -]?stack|ai\s*\/\s*ml|data|devops(?:\s*\/\s*sre)?|sre|qa|mobile|design|other|разработка|аналитика|тестирование)$/iu;
const ROLE = /engineer|developer|architect|scientist|designer|analyst|разработчик|инженер|архитектор|ваканси|тестировщик/iu;
const AD = /готовый промпт|переписать профиль|подписывай|наш канал|реклам|промокод|купить курс/iu;

function canonicalUrl(value) {
    try {
        const url = new URL(value);
        if (!["http:", "https:"].includes(url.protocol)) return null;
        url.hash = "";
        for (const key of [...url.searchParams.keys()]) {
            if (/^(utm_.+|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
        }
        return url.href;
    } catch { return null; }
}

function extractDigestLinks(message) {
    const text = String(message.message || "");
    const matches = [];
    for (const entity of message.entities || []) {
        const type = entity.className || entity.constructor?.name;
        if (!["MessageEntityTextUrl", "MessageEntityUrl"].includes(type)) continue;
        const label = text.slice(entity.offset, entity.offset + entity.length);
        matches.push({ offset: entity.offset, label, url: entity.url || label });
    }
    for (const match of text.matchAll(/https?:\/\/[^\s<>]+/giu)) {
        matches.push({ offset: match.index, label: "", url: match[0].replace(/[),.;!?\]}]+$/u, "") });
    }
    matches.sort((a, b) => a.offset - b.offset);
    const seen = new Set();
    const items = [];
    for (const match of matches) {
        const url = canonicalUrl(match.url);
        if (!url || seen.has(url)) continue;
        if (/(^|\.)(t\.me|telegram\.me|telegram\.org)$/i.test(new URL(url).hostname)) continue;
        const before = text.slice(0, match.offset);
        const start = before.lastIndexOf("\n") + 1;
        const end = text.indexOf("\n", match.offset);
        const line = text.slice(start, end < 0 ? text.length : end).trim();
        if (AD.test(line)) continue;
        if (!ROLE.test(line) && !/\/(jobs?|careers?|positions?)\//i.test(url)) continue;
        let section = "";
        for (const previous of before.split(/\r?\n/u)) {
            const cleaned = previous.replace(/[\u200b\u00a0]/gu, " ").trim();
            if (SECTION.test(cleaned)) section = cleaned;
        }
        const header = text.split(/\r?\n/u).slice(0, 3)
            .filter((s) => !/https?:|[•●]/u.test(s)).join("\n").slice(0, 500);
        seen.add(url);
        items.push({ url, label: (match.label || line.replace(/https?:\/\/\S+/gu, "")).trim().slice(0, 220) || "Вакансия",
            offset: match.offset, section, context: `${header}\n${section}\n${line}`.trim().slice(0, 1200) });
    }
    return items;
}

module.exports = { SOURCE_ID, SOURCE_USERNAME, TARGET_ID, canonicalUrl, extractDigestLinks };
