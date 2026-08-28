const test = require("node:test");
const assert = require("node:assert/strict");

const {
    assertMessageMatchesPlanState,
    dateKey,
    extractVacancyBody,
    extractSourceReference,
    getLastMessages,
    replaceApplicationHashtags,
    upsertDecisionHashtags,
} = require("./review_channel_posts");

test("uses the Moscow calendar date", () => {
    assert.equal(dateKey(new Date("2026-08-27T21:30:00.000Z")), "2026-08-28");
});

test("extracts only the original vacancy body", () => {
    const text = [
        "💼 ВАКАНСИЯ",
        "",
        "📢 Источник: Jobs",
        "🔗 https://t.me/jobs/42",
        "",
        "────────────────",
        "",
        "React vacancy",
        "Python будет плюсом",
    ].join("\n");

    assert.equal(
        extractVacancyBody(text),
        "React vacancy\nPython будет плюсом"
    );
});

test("fetches the requested latest-message limit and orders IDs", async () => {
    const calls = [];
    const client = {
        getMessages: async (entity, options) => {
            calls.push({ entity, options });
            return [{ id: 30 }, { id: 10 }, { id: 20 }];
        },
    };

    const messages = await getLastMessages(client, "channel", 100);

    assert.deepEqual(calls, [{
        entity: "channel",
        options: { limit: 100 },
    }]);
    assert.deepEqual(messages.map((message) => message.id), [10, 20, 30]);
});

test("inserts or replaces one generated hashtag line", () => {
    const original = "💼 ВАКАНСИЯ\n\n────────────────\n\nReact vacancy";
    const inserted = upsertDecisionHashtags(
        original,
        "#достоверно #frontend"
    );

    assert.match(inserted, /^💼 ВАКАНСИЯ\n#достоверно #frontend\n\n/);
    assert.equal(
        upsertDecisionHashtags(inserted, "#проверить #fullstack"),
        "💼 ВАКАНСИЯ\n#проверить #fullstack\n\n────────────────\n\nReact vacancy"
    );
});

test("replaces a legacy generated line with multiple stack hashtags", () => {
    const original = [
        "💼 ВАКАНСИЯ",
        "#проверить #javascript #python",
        "",
        "────────────────",
        "",
        "Full-stack vacancy",
    ].join("\n");

    assert.equal(
        upsertDecisionHashtags(original, "#достоверно #fullstack"),
        [
            "💼 ВАКАНСИЯ",
            "#достоверно #fullstack",
            "",
            "────────────────",
            "",
            "Full-stack vacancy",
        ].join("\n")
    );
});

test("preserves application-method hashtags while retagging the role", () => {
    const original = [
        "💼 ВАКАНСИЯ",
        "#достоверно #frontend #анкета #рекрутер #бот",
        "",
        "────────────────",
        "",
        "Full-stack vacancy",
    ].join("\n");

    assert.equal(
        upsertDecisionHashtags(original, "#проверить #fullstack"),
        [
            "💼 ВАКАНСИЯ",
            "#проверить #fullstack #анкета #рекрутер #бот",
            "",
            "────────────────",
            "",
            "Full-stack vacancy",
        ].join("\n")
    );
});

test("extracts only the source-post reference from the generated header", () => {
    const text = [
        "Source: https://t.me/company_jobs/123",
        "\u2500".repeat(16),
        "Recruiter: https://t.me/recruiter/456",
    ].join("\n");

    assert.deepEqual(extractSourceReference(text), {
        username: "company_jobs",
        messageId: 123,
        url: "https://t.me/company_jobs/123",
    });
});

test("replaces application hashtags without changing certainty or stack", () => {
    const original = [
        "\ud83d\udcbc \u0412\u0410\u041a\u0410\u041d\u0421\u0418\u042f",
        "#\u0434\u043e\u0441\u0442\u043e\u0432\u0435\u0440\u043d\u043e #frontend #\u0431\u043e\u0442",
        "",
        "\u2500".repeat(16),
        "",
        "Frontend vacancy",
    ].join("\n");

    const updated = replaceApplicationHashtags(
        original,
        ["recruiter", "company_form"]
    );

    assert.equal(
        updated.split("\n")[1],
        "#\u0434\u043e\u0441\u0442\u043e\u0432\u0435\u0440\u043d\u043e #frontend " +
        "#\u0430\u043d\u043a\u0435\u0442\u0430 #\u0440\u0435\u043a\u0440\u0443\u0442\u0435\u0440"
    );
    assert.equal(
        replaceApplicationHashtags(updated, []).split("\n")[1],
        "#\u0434\u043e\u0441\u0442\u043e\u0432\u0435\u0440\u043d\u043e #frontend"
    );
});

test("resume preflight accepts applied text and protects pending hashes", () => {
    assert.doesNotThrow(() => assertMessageMatchesPlanState({
        id: 1,
        appliedAt: "2026-08-28T20:00:00.000Z",
        originalText: "before",
        updatedText: "after",
        originalHash: "unused",
    }, "after"));
    assert.throws(
        () => assertMessageMatchesPlanState({
            id: 1,
            appliedAt: "2026-08-28T20:00:00.000Z",
            originalText: "before",
            updatedText: "after",
            originalHash: "unused",
        }, "changed"),
        /applied message 1 changed/
    );
    assert.throws(
        () => assertMessageMatchesPlanState({
            id: 2,
            originalText: "before",
            originalHash: "not-the-real-hash",
        }, "before"),
        /message 2 changed/
    );
});
