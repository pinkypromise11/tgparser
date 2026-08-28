const test = require("node:test");
const assert = require("node:assert/strict");

const { extractContactCandidates } = require("./contact_extractor");

test("extracts visible URLs, recruiter email, mention, and contextual phone", () => {
    const candidates = extractContactCandidates({
        message: [
            "Apply: https://company.example/jobs/42.",
            "Recruiter: jobs@example.com or @hire_manager",
            "WhatsApp: +7 (999) 123-45-67",
        ].join("\n"),
    });

    assert.deepEqual(
        candidates.map(({ kind, value }) => [kind, value]),
        [
            ["url", "https://company.example/jobs/42"],
            ["email", "jobs@example.com"],
            ["mention", "@hire_manager"],
            ["phone", "+7 (999) 123-45-67"],
        ]
    );
});

test("extracts a hidden Telegram text URL with its visible label", () => {
    const text = "Заполнить анкету";
    const candidates = extractContactCandidates({
        message: text,
        entities: [{
            className: "MessageEntityTextUrl",
            offset: 0,
            length: text.length,
            url: "https://company.example/apply",
        }],
    });

    assert.deepEqual(candidates, [{
        kind: "url",
        value: "https://company.example/apply",
        label: "Заполнить анкету",
        source: "hidden_text_url",
    }]);
});

test("extracts URL and callback Telegram buttons", () => {
    const candidates = extractContactCandidates({
        message: "Выберите способ отклика",
        replyMarkup: {
            rows: [{
                buttons: [
                    {
                        text: "Анкета",
                        url: "https://company.example/form",
                    },
                    {
                        text: "Откликнуться через Runello-бот",
                    },
                ],
            }],
        },
    });

    assert.deepEqual(candidates, [
        {
            kind: "url",
            value: "https://company.example/form",
            label: "Анкета",
            source: "telegram_reply_markup",
        },
        {
            kind: "button",
            value: "Откликнуться через Runello-бот",
            label: "Откликнуться через Runello-бот",
            source: "telegram_reply_markup",
        },
    ]);
});

test("does not mistake ordinary numbers for a phone contact", () => {
    const candidates = extractContactCandidates({
        message: "Зарплата 170 000–195 000 рублей, опыт 5 лет",
    });

    assert.deepEqual(candidates, []);
});
