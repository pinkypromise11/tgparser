const { canonicalUrl, extractDigestLinks } = require("./digest_links");

function linksInOrder(message) {
    const text = message.message || "";
    const links = (message.entities || []).filter(e => ["MessageEntityTextUrl", "MessageEntityUrl"].includes(e.className))
        .map(e => ({ offset: e.offset, length: e.length, label: text.slice(e.offset, e.offset + e.length), url: e.url || text.slice(e.offset, e.offset + e.length) }));
    for (const m of text.matchAll(/https?:\/\/[^\s<>]+/giu)) {
        if (!links.some(e => m.index >= e.offset && m.index < e.offset + e.length)) links.push({ offset: m.index, length: m[0].length, label: "", url: m[0].replace(/[),.;!?\]}]+$/u, "") });
    }
    return links.sort((a,b) => a.offset - b.offset).flatMap(link => {
        const url = canonicalUrl(link.url);
        return url && !/(^|\.)(t\.me|telegram\.me|telegram\.org)$/iu.test(new URL(url).hostname) ? [{ ...link, url }] : [];
    });
}

function extractCandidates(message, source) {
    if (source === "growglobaljobs") return extractDigestLinks(message).map((c,i) => ({ ...c, originalNumber: i+1 }));
    const text = message.message;
    const links = linksInOrder(message);
    let selected;
    if (source === "careerylej") {
        const starts = [...text.matchAll(/(?:^|\n)🔹/gu)].map(m => m.index + (m[0].startsWith("\n") ? 1 : 0));
        selected = starts.flatMap((start, index) => {
            const end = starts[index+1] ?? text.length;
            const titleEnd = text.indexOf("\n", start);
            const label = text.slice(start, titleEnd < 0 ? end : titleEnd).replace(/^🔹\s*/u, "").trim();
            const inside = links.filter(l => l.offset >= start && l.offset < end &&
                !/spacehub\.work|career-platform\.tilda\.ws/u.test(l.url));
            const primary = inside.find(l => l.offset < titleEnd) || inside[0];
            if (!primary) return [];
            const context = text.slice(start, end).split(/\n(?:🔎|💡|💼|Не нашли)/u)[0].trim();
            return [{ ...primary, label, originalNumber: index+1, context,
                alternateUrls: inside.filter(l => l !== primary).map(l => l.url) }];
        });
    } else {
        const filtered = links.filter(l => {
            if (source === "habr_career") return !/больше вакансий|ещ[её] вакансии/iu.test(l.label);
            if (source === "opento_dev") return new URL(l.url).hostname === "wantapply.com";
            if (source === "youritjob") return /\/vacancies\/[^/]+/u.test(new URL(l.url).pathname);
            if (source === "zarubezhom_jobs") return new URL(l.url).hostname === "jobs.ashbyhq.com";
            if (source === "remotegeekjob") return !/пост на LinkedIn|post on LinkedIn/iu.test(l.label);
            return false;
        });
        selected = filtered.map((l,index) => {
            const start = text.lastIndexOf("\n", l.offset-1)+1;
            const end = text.indexOf("\n", l.offset);
            let context = text.slice(start, end < 0 ? text.length : end);
            let label = l.label.trim() || context;
            if (source === "youritjob") {
                context = text.slice(0,l.offset).trim().split(/\n\s*\n/u).slice(-1)[0];
                label = context.split("\n")[0].replace(/^⚪️\s*/u, "").trim();
            } else if (source === "opento_dev") {
                context = text.slice(start).split(/\n\s*\n/u)[0];
            }
            return { ...l, label, context, originalNumber: index+1 };
        });
    }
    const seen = new Set();
    return selected.filter(c => { if (seen.has(c.url)) return false; seen.add(c.url); return true; });
}

const ROLE = /engineer|developer|architect|designer|analyst|scientist|manager|recruiter|devops|sre|frontend|backend|full.?stack|разработчик|инженер|архитектор|аналитик|дизайнер|менеджер|тестировщик|ваканси/iu;
const PROMO = /подпис|наш канал|реклам|промокод|больше вакансий|ещ[её] вакансии|post on linkedin|пост на linkedin|купить курс/iu;
const SOCIAL = /(^|\.)(t\.me|telegram\.me|telegram\.org|youtube\.com|youtu\.be|instagram\.com|facebook\.com|twitter\.com|x\.com)$/iu;

function jobUrl(value) {
    const u = new URL(value);
    return /\/(?:jobs?|careers?|positions?|vacancies|vacancy)\/[^/?]+/iu.test(u.pathname) ||
        (/^(?:jobs\.ashbyhq\.com|jobs\.lever\.co|boards\.greenhouse\.io|job-boards\.greenhouse\.io)$/iu.test(u.hostname) && u.pathname.split('/').filter(Boolean).length >= 2) ||
        (u.hostname === 'wantapply.com' && u.pathname.split('/').filter(Boolean).length >= 1);
}

function excludedLink(link) {
    const u = new URL(link.url);
    return SOCIAL.test(u.hostname) || PROMO.test(link.label) ||
        (/linkedin\.com$/iu.test(u.hostname) && !/\/jobs\/view\//iu.test(u.pathname)) ||
        /^\/(?:jobs?|careers?|vacancies|positions?)?\/?$/iu.test(u.pathname) ||
        /\.(?:png|jpg|jpeg|gif|zip|exe)$/iu.test(u.pathname);
}

// Pure extraction shared by the continuous worker and one-off tools. No network or writes.
function extractLinkedVacancies(message, source = '') {
    const text = String(message.message || '');
    if (!text) return [];
    source = source.toLowerCase();
    const known = ['growglobaljobs', 'habr_career', 'opento_dev', 'careerylej', 'remotegeekjob', 'youritjob', 'zarubezhom_jobs'];
    let selected = known.includes(source) ? extractCandidates(message, source) : [];
    // Source-specific roundup extraction is useful only when there are several positions.
    if (selected.length < 2) selected = [];
    if (!selected.length) {
        const links = linksInOrder(message).filter(l => !excludedLink(l));
        selected = links.flatMap(link => {
            const start = text.lastIndexOf('\n\n', link.offset);
            const end = text.indexOf('\n\n', link.offset);
            const block = text.slice(start < 0 ? 0 : start + 2, end < 0 ? text.length : end);
            const lineStart = text.lastIndexOf('\n', link.offset - 1) + 1;
            const lineEnd = text.indexOf('\n', link.offset);
            const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
            const titleLink = ROLE.test(link.label);
            // A generic application link can use the post title only in a single-link post.
            const title = text.split(/\r?\n/u).find(l => ROLE.test(l) && !/https?:/u.test(l)) || '';
            if (!jobUrl(link.url) && !titleLink && !(links.length === 1 && ROLE.test(title) && /отклик|подробн|описани|apply|details|description/iu.test(block))) return [];
            if (PROMO.test(line)) return [];
            const label = titleLink ? link.label : ROLE.test(line.replace(/https?:\/\/\S+/gu, ''))
                ? line.replace(/https?:\/\/\S+/gu, '').trim() : links.length === 1 ? title : '';
            return [{ ...link, label: label || 'Вакансия', context: titleLink || links.length > 1 ? line : text, section: '' }];
        });
    }
    const seen = new Map();
    let number = 0;
    return selected.filter(c => !excludedLink(c) && (jobUrl(c.url) || ROLE.test(c.label) || /отклик|apply/iu.test(c.context || ''))).flatMap(c => {
        const lineStart = text.lastIndexOf('\n', c.offset - 1) + 1;
        const prefix = text.slice(lineStart, c.offset);
        const explicit = /^\s*(\d{1,3})[.)]\s/u.exec(prefix);
        const originalNumber = explicit ? Number(explicit[1]) : c.originalNumber ?? ++number;
        number = Math.max(number, originalNumber);
        if (seen.has(c.url)) return [];
        seen.set(c.url, originalNumber);
        return [{ ...c, originalNumber, label: c.label.slice(0, 220), context: c.context.slice(0, 1800) }];
    });
}

module.exports = { linksInOrder, extractCandidates, extractLinkedVacancies };
