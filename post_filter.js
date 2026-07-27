const {
    containsExcludedChannelReference,
    isExcludedChannelId,
} = require("./excluded_channels");

const PRIMARY_HIRING_SIGNALS = [
    "вакансия",
    "вакансии",
    "вакансию",
    "вакансий",
    "открыта вакансия",
    "открыты вакансии",
    "требуется",
    "требуются",
    "мы ищем",
    "ищем разработчика",
    "ищем инженера",
    "ищем специалиста",
    "в команду ищем",
    "приглашаем в команду",
    "набираем в команду",
    "открыта позиция",
    "открыты позиции",
    "откликнуться",
    "откликайтесь",
    "присылайте резюме",
    "отправляйте резюме",
    "#вакансия",
    "#вакансии",
    "💼",
    "vacancy",
    "vacancies",
    "hiring",
    "now hiring",
    "we are hiring",
    "we're hiring",
    "job opening",
    "open position",
    "open role",
    "looking for a developer",
    "looking for an engineer",
    "seeking a developer",
    "seeking an engineer",
    "join our team",
    "apply now",
    "apply here",
    "send your cv",
    "send your resume",
    "applications close",
    "job description",
    "#vacancy",
    "#hiring",
    "#job",
    "#jobs",
    "#itjob",
    "#fulltime",
];

const STRUCTURED_VACANCY_FIELDS = [
    "обязанности",
    "требования",
    "условия",
    "зарплата",
    "занятость",
    "формат работы",
    "задачи",
    "вилка",
    "оплата",
    "должность",
    "грейд",
    "стек",
    "контракт",
    "заказ",
    "компания",
    "команда",
    "предстоит",
    "ищет",
    "linkedin",
    "responsibilities",
    "requirements",
    "qualifications",
    "salary",
    "compensation",
    "employment type",
    "location",
    "key skills",
];

const NON_VACANCY_SIGNALS = [
    "индекс интересности",
    "резюме не будет опубликовано",
    "резюме в канале",
    "вакансия не пройдет",
    "правила оформления вакансий",
    "укажите ссылку на сайт компании",
    "for such warm words",
    "clients trust us",
    "сейчас рассматриваю новые предложения",
    "рассматриваю новые предложения",
    "рассматриваю удаленную работу",
    "открыт к новым предложениям",
    "открыта к новым предложениям",
    "сейчас в поиске работы",
    "ищу работу",
    "open to work",
    "open for opportunities",
    "seeking new opportunities",
    "looking for a new role",
    "i am currently looking",
    "#резюме",
    "#resume",
    "#cv",
    "бесплатный вебинар",
    "новый курс",
    "тестовое собеседование",
    "successfully hired",
];

const phrasePatternCache = new Map();

function normalizeText(value = "") {
    return String(value)
        .toLocaleLowerCase("ru-RU")
        .replaceAll("ё", "е");
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function phrasePattern(phrase) {
    if (phrasePatternCache.has(phrase)) {
        return phrasePatternCache.get(phrase);
    }

    const normalized = normalizeText(phrase);
    const first = normalized[0];
    const last = normalized[normalized.length - 1];
    const wordCharacter = /[\p{L}\p{N}]/u;
    const before = wordCharacter.test(first)
        ? "(?<![\\p{L}\\p{N}])"
        : "";
    const after = wordCharacter.test(last)
        ? "(?![\\p{L}\\p{N}])"
        : "";
    const pattern = new RegExp(
        `${before}${escapeRegExp(normalized)}${after}`,
        "u"
    );

    phrasePatternCache.set(phrase, pattern);
    return pattern;
}

function containsPhrase(normalizedText, phrase) {
    return phrasePattern(phrase).test(normalizedText);
}

function hasOnlyAllowedAlphabets(text = "") {
    const letters = String(text).match(/\p{L}/gu) ?? [];

    return letters.every((letter) =>
        /[\p{Script=Latin}\p{Script=Cyrillic}]/u.test(letter)
    );
}

function hasVacancyIntent(text = "") {
    const normalized = normalizeText(text);

    if (NON_VACANCY_SIGNALS.some((signal) =>
        containsPhrase(normalized, signal)
    )) {
        return false;
    }

    if (PRIMARY_HIRING_SIGNALS.some((signal) =>
        containsPhrase(normalized, signal)
    )) {
        return true;
    }

    const structuredFieldCount = STRUCTURED_VACANCY_FIELDS.reduce(
        (count, field) =>
            count + Number(containsPhrase(normalized, field)),
        0
    );

    if (structuredFieldCount >= 2) {
        return true;
    }

    const hasRole = /(?<![\p{L}\p{N}])(?:senior|middle|junior|developer|engineer|разработчик|инженер)(?![\p{L}\p{N}])/u
        .test(normalized);
    const hasWorkplace = /(?<![\p{L}\p{N}])(?:офис|удален(?:но|ка)?|remote|hybrid|гибрид)(?![\p{L}\p{N}])/u
        .test(normalized);
    const hasCompensation = /(?<![\p{L}\p{N}])(?:\d{3}|\d{2,3}\s*(?:к|k|₽|\$|€))(?![\p{L}\p{N}])/u
        .test(normalized);
    const isTerseVacancyCard =
        hasRole && hasWorkplace && hasCompensation;
    const isJobChannelLink =
        /(?:https?:\/\/)?t\.me\/[^/\s]*(?:job|jobs|vacancy|vacancies)[^/\s]*\/\d+/u
            .test(normalized);

    return isTerseVacancyCard || isJobChannelLink;
}

function isRelevant(text = "", channelId, keywords) {
    if (
        isExcludedChannelId(channelId) ||
        containsExcludedChannelReference(text)
    ) {
        return false;
    }

    if (!hasOnlyAllowedAlphabets(text)) {
        return false;
    }

    const normalized = normalizeText(text);
    const hasInclude = keywords.include.some((word) =>
        normalized.includes(normalizeText(word))
    );
    const hasExclude = keywords.exclude.some((word) =>
        normalized.includes(normalizeText(word))
    );

    if (!hasInclude || hasExclude) {
        return false;
    }

    return hasVacancyIntent(normalized);
}

module.exports = {
    PRIMARY_HIRING_SIGNALS,
    NON_VACANCY_SIGNALS,
    STRUCTURED_VACANCY_FIELDS,
    hasOnlyAllowedAlphabets,
    hasVacancyIntent,
    isRelevant,
    normalizeText,
};
