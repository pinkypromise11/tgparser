const { SOURCE_USERNAME, SOURCE_ID } = require("./digest_links");
const { formatEmploymentHashtags, formatLocationHashtag, formatWorkModeHashtag } = require("./llm");

function hashtags(item) {
    const telegramOnly = (item.evidence || []).some((e) => e.source === "telegram" &&
        !(item.evidence || []).some((p) => p.source === "page" && p.field === e.field));
    const certain = item.status === "open" && !item.conflicts.length && !telegramOnly && !item.review_required &&
        (!item.relevanceDecision || item.relevanceDecision.verdict === "certain");
    const tags = [certain ? "#достоверно" : "#проверить"];
    if (item.status === "closed") tags.push("#закрыта");
    if (item.status === "unavailable") return tags.join(" ");
    for (const field of ["direction", "stack", "level"]) if (item[field]) tags.push(`#${item[field]}`);
    if (item.location) tags.push(formatLocationHashtag({ location: item.location, confidence: 100, reason: "Evidence verified" }));
    if (item.work_mode) tags.push(formatWorkModeHashtag({ mode: item.work_mode, confidence: 100, reason: "Evidence verified" }));
    tags.push(...formatEmploymentHashtags(item.employment).map((s) => s === "#part-time" ? "#part_time" : s));
    for (const method of item.application) tags.push({ company_form: "#анкета", recruiter: "#рекрутер", bot: "#бот", linkedin: "#Linkedin" }[method]);
    return [...new Set(tags.filter(Boolean))].join(" ");
}

function formatDigest(job, maxLength = 3900) {
    const date = new Date(job.date * 1000).toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow" });
    const sourceUsername = job.sourceUsername || (!job.source || job.source === SOURCE_ID ? SOURCE_USERNAME : '');
    if (sourceUsername && !/^[a-z0-9_]+$/iu.test(sourceUsername)) throw new Error("Invalid source username");
    if (!sourceUsername && !/^-100\d+$/u.test(job.source)) throw new Error("Invalid private source ID");
    const sourcePath = sourceUsername || `c/${job.source.slice(4)}`;
    const header = `Вакансии ${sourceUsername || job.source} · ${date}\nИсточник: https://t.me/${sourcePath}/${job.id}`;
    const blocks = job.results.map((item, i) => {
        const sourceIndex = job.candidates?.findIndex((candidate) => candidate.url === item.url) ?? -1;
        const originalNumber = item.originalNumber ?? (sourceIndex >= 0 ? sourceIndex + 1 : i + 1);
        const title = `${originalNumber}. ${item.title}${item.company ? ` — ${item.company}` : ""}`;
        const provenance = [...new Set((item.evidence || []).filter((e) => e.source === "telegram" &&
            !item.evidence.some((p) => p.field === e.field && p.source === "page")).map((e) => e.quote))];
        const text = [title, hashtags(item), item.status === "unavailable" ? `Описание недоступно: ${item.reason}.` : item.summary,
            ...(provenance.length ? [`По Telegram: ${provenance.join("; ")}`] : []),
            ...(item.conflicts.length ? [`Расхождения: ${item.conflicts.join("; ")}`] : []),
            `${item.attribution ? `Источник описания: ${item.attribution}\n` : ""}${item.url}`].join("\n");
        return { text, titleLength: title.length };
    });
    if (!blocks.length) return [];
    const groups = [];
    let current = [];
    let length = header.length + 45;
    for (const block of blocks) {
        if (header.length + 45 + block.text.length > maxLength) throw new Error("Single vacancy exceeds Telegram message budget");
        if (length + block.text.length + 2 > maxLength) { groups.push(current); current = []; length = header.length + 45; }
        current.push(block); length += block.text.length + 2;
    }
    if (current.length) groups.push(current);
    return groups.map((group, i) => {
        let text = `${header}${groups.length > 1 ? `\nчасть ${i + 1}/${groups.length}` : ""}`;
        const entities = [];
        for (const block of group) {
            const offset = text.length + 2;
            text += `\n\n${block.text}`;
            entities.push({ offset, length: block.titleLength });
        }
        return { text, entities };
    });
}
module.exports = { hashtags, formatDigest };
