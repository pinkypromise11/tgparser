const VISIBLE_URL_PATTERN = /https?:\/\/[^\s<>]+/giu;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const MENTION_PATTERN = /(?<![\p{L}\p{N}_])@[A-Z0-9_]{5,32}/giu;
const PHONE_PATTERN = /(?:\+?\d[\d\s().-]{7,}\d)/gu;
const PHONE_CONTEXT_PATTERN = /(?:тел(?:ефон)?|phone|whats?app|ватсап|viber|контакт)/iu;

function cleanUrl(value) {
    if (value === null || value === undefined) return "";
    return String(value).replace(/[),.;!?\]}]+$/u, "");
}

function textForEntity(text, entity) {
    const offset = Number(entity?.offset);
    const length = Number(entity?.length);

    if (!Number.isInteger(offset) || !Number.isInteger(length)) {
        return "";
    }

    return text.slice(offset, offset + length);
}

function lineForRange(text, offset, length) {
    const start = Math.max(0, Number(offset) || 0);
    const end = start + Math.max(0, Number(length) || 0);
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    const nextNewline = text.indexOf("\n", end);
    const lineEnd = nextNewline === -1 ? text.length : nextNewline;

    return text.slice(lineStart, lineEnd).trim().slice(0, 500);
}

function extractContactCandidates(message) {
    const text = String(message?.message || "");
    const candidates = [];
    const seen = new Set();

    function add(kind, value, label, source) {
        const cleanedValue = String(value || "").trim();
        const cleanedLabel = String(label || "").trim();

        if (!cleanedValue && !cleanedLabel) return;

        const key = [
            kind,
            cleanedValue.toLocaleLowerCase("en-US"),
            cleanedLabel.toLocaleLowerCase("en-US"),
        ].join("\u0000");

        if (seen.has(key)) return;
        seen.add(key);

        candidates.push({
            kind,
            value: cleanedValue,
            label: cleanedLabel,
            source,
        });
    }

    for (const match of text.matchAll(VISIBLE_URL_PATTERN)) {
        const url = cleanUrl(match[0]);
        add(
            "url",
            url,
            lineForRange(text, match.index, match[0].length) || url,
            "visible_text"
        );
    }

    for (const match of text.matchAll(EMAIL_PATTERN)) {
        add(
            "email",
            match[0],
            lineForRange(text, match.index, match[0].length) || match[0],
            "visible_text"
        );
    }

    for (const match of text.matchAll(MENTION_PATTERN)) {
        add(
            "mention",
            match[0],
            lineForRange(text, match.index, match[0].length) || match[0],
            "visible_text"
        );
    }

    for (const line of text.split(/\r?\n/u)) {
        if (!PHONE_CONTEXT_PATTERN.test(line)) continue;

        for (const match of line.matchAll(PHONE_PATTERN)) {
            add("phone", match[0], match[0], "visible_text");
        }
    }

    for (const entity of message?.entities || []) {
        const className = entity?.className || entity?.constructor?.name;
        const label = textForEntity(text, entity);

        if (className === "MessageEntityTextUrl") {
            add("url", cleanUrl(entity.url), label, "hidden_text_url");
        } else if (className === "MessageEntityUrl") {
            add(
                "url",
                cleanUrl(label),
                lineForRange(text, entity.offset, entity.length) || label,
                "text_entity"
            );
        } else if (className === "MessageEntityEmail") {
            add(
                "email",
                label,
                lineForRange(text, entity.offset, entity.length) || label,
                "text_entity"
            );
        } else if (className === "MessageEntityPhone") {
            add(
                "phone",
                label,
                lineForRange(text, entity.offset, entity.length) || label,
                "text_entity"
            );
        } else if (className === "MessageEntityMention") {
            add(
                "mention",
                label,
                lineForRange(text, entity.offset, entity.length) || label,
                "text_entity"
            );
        }
    }

    function addButton(button, source) {
        if (!button || typeof button !== "object") return;

        const label = String(button.text || "").trim();
        const url = typeof button.url === "string"
            ? cleanUrl(button.url)
            : "";

        if (url) {
            add("url", url, label || url, source);
        } else if (label) {
            add("button", label, label, source);
        }
    }

    try {
        for (const row of message?.buttons || []) {
            for (const button of row || []) {
                addButton(button, "telegram_button");
            }
        }
    } catch {
        // GramJS may require an attached client to materialize message.buttons.
    }

    for (const row of message?.replyMarkup?.rows || []) {
        for (const button of row?.buttons || []) {
            addButton(button, "telegram_reply_markup");
        }
    }

    return candidates;
}

module.exports = { extractContactCandidates };
