const test = require("node:test");
const assert = require("node:assert/strict");

const {
    hasOnlyAllowedAlphabets,
    hasVacancyIntent,
    isRelevant,
    normalizeText,
} = require("./post_filter");

const STRICT_CHANNEL = "-1001007166727";
const OTHER_CHANNEL = "-1001136736785";
const keywords = {
    include: ["python", "fastapi", "developer"],
    exclude: ["open to work", "#resume", "#cv"],
};

test("rejects the cited technical chat messages in the strict channel", () => {
    const messages = [
        "этот fastapi-jsonrpc хочет собой заменить весь fastapi.FastApi",
        "мне недавно жсонрпц-ручка понадобилась в фастапи-аппе",
        "https://www.youtube.com/watch?v=bzkRVzciAZg 14 years ago :D",
    ];

    for (const message of messages) {
        assert.equal(isRelevant(message, STRICT_CHANNEL, keywords), false);
    }
});

test("accepts primary Russian and English hiring signals", () => {
    assert.equal(
        isRelevant(
            "Мы ищем Python разработчика в команду",
            STRICT_CHANNEL,
            keywords
        ),
        true
    );
    assert.equal(
        isRelevant(
            "We are hiring a Python developer",
            STRICT_CHANNEL,
            keywords
        ),
        true
    );
});

test("accepts at least two structured vacancy fields", () => {
    assert.equal(
        isRelevant(
            "Python developer\nТребования: опыт\nУсловия: удаленно",
            STRICT_CHANNEL,
            keywords
        ),
        true
    );
    assert.equal(
        isRelevant(
            "Python developer\nТребования: опыт",
            STRICT_CHANNEL,
            keywords
        ),
        false
    );
});

test("does not accept isolated generic terms as hiring intent", () => {
    for (const text of [
        "Python developer",
        "Работа с Python",
        "Python job",
        "Python position sizing discussion",
    ]) {
        assert.equal(hasVacancyIntent(text), false);
    }
});

test("matches complete signals instead of substrings", () => {
    assert.equal(hasVacancyIntent("vacancy"), true);
    assert.equal(hasVacancyIntent("vacancytracker"), false);
    assert.equal(hasVacancyIntent("требуется"), true);
    assert.equal(hasVacancyIntent("потребуется"), false);
});

test("normalizes case and Cyrillic е/ё", () => {
    assert.equal(normalizeText("ВСЁ ЁЩЁ"), "все еще");
    assert.equal(
        isRelevant(
            "ОТКЛИКАЙТЕСЬ: нужен PYTHON developer",
            STRICT_CHANNEL,
            keywords
        ),
        true
    );
});

test("keeps exclusions ahead of vacancy intent", () => {
    assert.equal(
        isRelevant(
            "#CV Python developer, we are hiring",
            STRICT_CHANNEL,
            keywords
        ),
        false
    );
});

test("requires vacancy intent in every channel", () => {
    assert.equal(
        isRelevant("Technical FastAPI discussion", OTHER_CHANNEL, keywords),
        false
    );
    assert.equal(
        isRelevant(
            "We are hiring a Python developer",
            OTHER_CHANNEL,
            keywords
        ),
        true
    );
});

test("rejects excluded sources and cross-posted links first", () => {
    assert.equal(
        isRelevant(
            "We are hiring a Python developer",
            "-1001621850024",
            keywords
        ),
        false
    );
    assert.equal(
        isRelevant(
            "We are hiring a Python developer: https://t.me/gdjobs/123",
            OTHER_CHANNEL,
            keywords
        ),
        false
    );
});

test("recognizes dataset-specific vacancy formats", () => {
    for (const text of [
        "💼 Quantitative Python Developer at Paradex",
        "SENIOR PYTHON DEVELOPER #itjob #fulltime",
        "Python Engineer — Job description",
        "Python developer\nВилка: 250–300\nЗадачи: backend",
        "Команда Ozon ищет Application Security Python инженера",
        "Senior Python developer 250к офис Москва",
        "Senior Python developer 210 офис Зеленоград",
        "Заказ: переписать сервис на Python. Контракт.",
        "https://t.me/python_jobs/123456",
    ]) {
        assert.equal(hasVacancyIntent(text), true, text);
    }
});

test("allows only Latin and Cyrillic alphabets in channel entries", () => {
    for (const text of [
        "We're hiring a Python développeur 🚀",
        "Ищем Python-разработчика — Київ",
        "Python/C# developer, salary: €3,000",
        "https://example.com/jobs/123 🔥",
    ]) {
        assert.equal(hasOnlyAllowedAlphabets(text), true, text);
    }

    for (const text of [
        "We are hiring a Python 开发工程师",
        "Python developer مطلوب",
        "Python developer απαιτείται",
    ]) {
        assert.equal(hasOnlyAllowedAlphabets(text), false, text);
        assert.equal(isRelevant(text, OTHER_CHANNEL, keywords), false, text);
    }
});

test("rejects moderation, résumé feedback, and promotional hiring posts", () => {
    for (const text of [
        "Отлично! вакансия в канале. Индекс интересности: 8/10",
        "Ваше резюме не будет опубликовано",
        "Python вакансия не пройдёт: зарплата не указана",
        "Новый курс для Python developer",
        "Тестовое собеседование на Middle Python",
        "The Python role was successfully hired",
    ]) {
        assert.equal(hasVacancyIntent(text), false, text);
    }
});

test("rejects vacancy instructions, testimonials, and candidate CVs", () => {
    for (const text of [
        "Прочитайте правила оформления вакансий. Укажите ссылку на сайт компании и зарплатную вилку.",
        "Thank you, Joris, for such warm words. We have been hiring across engineering and our clients trust us.",
        "Golang-разработчик с коммерческим опытом более четырёх лет. Сейчас рассматриваю новые предложения. Рассматриваю удалённую работу.",
        "Python developer seeking new opportunities. Open to work.",
    ]) {
        assert.equal(hasVacancyIntent(text), false, text);
    }
});
