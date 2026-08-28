const test = require("node:test");
const assert = require("node:assert/strict");

const { formatVacancyMessage } = require("./message_formatter");

test("places confidence and one stack hashtag on every formatted post", () => {
    const formatted = formatVacancyMessage({
        hashtags: "#достоверно #nodejs",
        postText: "Node.js backend vacancy",
        sourceTitle: "Backend jobs",
        postLink: "https://t.me/backend_jobs/42",
    });

    assert.match(formatted, /^💼 ВАКАНСИЯ\n#достоверно #nodejs\n/);
    assert.match(formatted, /📢 Источник: Backend jobs/);
    assert.match(formatted, /🔗 https:\/\/t\.me\/backend_jobs\/42/);
    assert.match(formatted, /Node\.js backend vacancy$/);
});

test("keeps hashtags when Telegram source metadata is unavailable", () => {
    const formatted = formatVacancyMessage({
        hashtags: "#проверить #typescript",
        postText: "Ambiguous vacancy",
    });

    assert.match(formatted, /^💼 ВАКАНСИЯ\n#проверить #typescript\n/);
    assert.doesNotMatch(formatted, /Источник/);
});

test("keeps all application-method hashtags on the same tag line", () => {
    const formatted = formatVacancyMessage({
        hashtags: "#достоверно #frontend #анкета #рекрутер #бот",
        postText: "Frontend vacancy with several application routes",
    });

    assert.match(
        formatted,
        /#достоверно #frontend #анкета #рекрутер #бот\n\n/
    );
});
