const test = require("node:test");
const assert = require("node:assert/strict");

const {
    APPLICATION_METHODS,
    APPLICATION_METHOD_SCHEMA,
    CERTAIN_CONFIDENCE_THRESHOLD,
    MODEL,
    PRIMARY_STACKS,
    RETAG_DECISION_SCHEMA,
    RETAG_PRIMARY_STACKS,
    analyzeApplicationMethods,
    analyzePublishedVacancyTag,
    analyzeVacancy,
    enforceApplicationEvidence,
    formatDecisionHashtags,
    normalizeDecision,
    normalizeApplicationDecision,
    normalizeRetagDecision,
} = require("./llm");

function fakeOpenAI(decision) {
    const calls = [];

    return {
        calls,
        client: {
            responses: {
                create: async (request) => {
                    calls.push(request);
                    return {
                        output_text: JSON.stringify(decision),
                    };
                },
            },
        },
    };
}

test("uses GPT-5.6 Luna with strict structured output", async () => {
    const fake = fakeOpenAI({
        verdict: "certain",
        confidence: 97,
        primary_stack: "nodejs",
        reason: "Node.js is the explicit mandatory backend stack",
    });

    const decision = await analyzeVacancy(
        "Node.js backend developer vacancy",
        fake.client
    );
    const request = fake.calls[0];

    assert.deepEqual(decision, {
        verdict: "certain",
        confidence: 97,
        primary_stack: "nodejs",
        reason: "Node.js is the explicit mandatory backend stack",
    });
    assert.equal(request.model, "gpt-5.6-luna");
    assert.equal(request.model, MODEL);
    assert.equal(request.store, false);
    assert.equal(request.reasoning.effort, "medium");
    assert.equal(request.text.format.type, "json_schema");
    assert.equal(request.text.format.strict, true);
    assert.match(request.instructions, /ignore optional, nice-to-have/);
    assert.match(request.instructions, /plain Middle/);
    assert.match(request.instructions, /Choose frontend for every accepted frontend role/);
    assert.match(request.instructions, /both frontend and backend are substantial/);
    assert.match(request.instructions, /fullstack with verdict review/);
});

test("allows only frontend/fullstack role tags for frontend-facing vacancies", () => {
    assert.ok(PRIMARY_STACKS.includes("frontend"));
    assert.ok(PRIMARY_STACKS.includes("fullstack"));
    assert.ok(!PRIMARY_STACKS.includes("react"));
    assert.ok(!PRIMARY_STACKS.includes("nextjs"));

    assert.equal(
        formatDecisionHashtags({
            verdict: "certain",
            confidence: 96,
            primary_stack: "frontend",
            reason: "React is the core required frontend framework",
        }),
        "#достоверно #frontend"
    );
    assert.equal(
        formatDecisionHashtags({
            verdict: "review",
            confidence: 82,
            primary_stack: "fullstack",
            reason: "Both sides appear core but the responsibilities are incomplete",
        }),
        "#проверить #fullstack"
    );
});

test("keeps technology hashtags for backend vacancies", () => {
    assert.equal(
        formatDecisionHashtags({
            verdict: "review",
            confidence: 72,
            primary_stack: "python",
            reason: "The role appears relevant but its status is unclear",
        }),
        "#проверить #python"
    );
});

test("classifies every explicit application method with GPT-5.6 Luna", async () => {
    const fake = fakeOpenAI({
        methods: ["company_form", "recruiter", "bot"],
        confidence: 98,
        reason: "The post offers a company form, a recruiter email, and an application bot",
    });
    const candidates = [
        {
            kind: "url",
            value: "https://company.example/apply",
            label: "Fill in the application form",
            source: "hidden_text_url",
        },
        {
            kind: "email",
            value: "recruiter@example.com",
            label: "recruiter@example.com",
            source: "visible_text",
        },
    ];

    const decision = await analyzeApplicationMethods(
        "Apply with the form, contact the recruiter, or use our bot.",
        candidates,
        fake.client
    );
    const request = fake.calls[0];
    const input = JSON.parse(request.input);

    assert.deepEqual(decision.methods, APPLICATION_METHODS);
    assert.equal(request.model, MODEL);
    assert.equal(request.store, false);
    assert.equal(request.reasoning.effort, "medium");
    assert.equal(request.text.format.schema, APPLICATION_METHOD_SCHEMA);
    assert.deepEqual(input.contact_candidates, candidates);
    assert.match(request.instructions, /any combination is allowed/);
    assert.match(request.instructions, /source-channel link/);
    assert.match(request.instructions, /both or all three methods/);
});

test("appends combined application hashtags in a stable order", () => {
    const hashtags = formatDecisionHashtags(
        {
            verdict: "certain",
            confidence: 99,
            primary_stack: "frontend",
            reason: "Explicit senior frontend vacancy",
        },
        ["bot", "recruiter", "company_form"]
    );

    assert.equal(
        hashtags,
        "#\u0434\u043e\u0441\u0442\u043e\u0432\u0435\u0440\u043d\u043e #frontend " +
        "#\u0430\u043d\u043a\u0435\u0442\u0430 #\u0440\u0435\u043a\u0440\u0443\u0442\u0435\u0440 #\u0431\u043e\u0442"
    );
});

test("rejects unknown and duplicate application methods", () => {
    assert.throws(
        () => normalizeApplicationDecision({
            methods: ["telegram"],
            confidence: 90,
            reason: "Unsupported output",
        }),
        /Unknown application method/
    );
    assert.throws(
        () => normalizeApplicationDecision({
            methods: ["bot", "bot"],
            confidence: 90,
            reason: "Duplicate output",
        }),
        /Duplicate application method/
    );
});

test("evidence guard rejects unrelated bots and normalizes explicit apply links", () => {
    const decision = enforceApplicationEvidence(
        {
            methods: ["bot"],
            confidence: 95,
            reason: "The URL contains a bot username",
        },
        "Apply: https://cjl.ist/example\nGet a special offer",
        [
            {
                kind: "url",
                value: "https://cjl.ist/example",
                label: "Apply: https://cjl.ist/example",
                source: "visible_text",
            },
            {
                kind: "url",
                value: "https://t.me/JTBL_bot?start=special_offer",
                label: "Get a special offer",
                source: "hidden_text_url",
            },
        ]
    );

    assert.deepEqual(decision.methods, ["company_form"]);
    assert.match(decision.reason, /Evidence guard normalized/);
});

test("evidence guard rejects a bare author byline as recruiter contact", () => {
    const decision = enforceApplicationEvidence(
        {
            methods: ["recruiter"],
            confidence: 91,
            reason: "The post ends with a username",
        },
        "Vacancy description\n\ud83d\udd8b @post_author",
        [{
            kind: "mention",
            value: "@post_author",
            label: "\ud83d\udd8b @post_author",
            source: "visible_text",
        }]
    );

    assert.deepEqual(decision.methods, []);
});

test("evidence guard does not find a bot inside the Russian word for work", () => {
    const decision = enforceApplicationEvidence(
        {
            methods: [],
            confidence: 95,
            reason: "No application bot",
        },
        "Условия работы\nОткликнуться по ссылке",
        [{
            kind: "url",
            value: "https://company.example/apply",
            label: "Откликнуться",
            source: "hidden_text_url",
        }]
    );

    assert.deepEqual(decision.methods, ["company_form"]);
});

test("retags published vacancies without applying the seniority filter", async () => {
    const fake = fakeOpenAI({
        verdict: "certain",
        confidence: 98,
        primary_stack: "frontend",
        reason: "The published role is frontend; backend is only a bonus",
    });

    const decision = await analyzePublishedVacancyTag(
        "Middle frontend role. React required. Node.js is a plus.",
        fake.client
    );
    const request = fake.calls[0];

    assert.deepEqual(decision, {
        verdict: "certain",
        confidence: 98,
        primary_stack: "frontend",
        reason: "The published role is frontend; backend is only a bonus",
    });
    assert.equal(request.model, MODEL);
    assert.equal(request.store, false);
    assert.equal(request.text.format.schema, RETAG_DECISION_SCHEMA);
    assert.deepEqual(RETAG_PRIMARY_STACKS, ["frontend", "fullstack"]);
    assert.match(request.instructions, /without re-evaluating seniority or deleting/);
    assert.match(request.instructions, /optional or bonus backend does not count/);
    assert.match(request.instructions, /fullstack with verdict review/);
    assert.match(request.instructions, /QA\/AQA\/testing/);
    assert.match(request.instructions, /Never approximate an unsupported/);
});

test("allows an unclassifiable published post to be skipped", () => {
    assert.deepEqual(
        normalizeRetagDecision({
            verdict: "skip",
            confidence: 95,
            primary_stack: null,
            reason: "The post body has no defensible role category",
        }),
        {
            verdict: "skip",
            confidence: 95,
            primary_stack: null,
            reason: "The post body has no defensible role category",
        }
    );
    assert.deepEqual(
        normalizeRetagDecision({
            verdict: "skip",
            confidence: 95,
            primary_stack: "frontend",
            reason: "Skip takes precedence over a supplied classification",
        }),
        {
            verdict: "skip",
            confidence: 95,
            primary_stack: null,
            reason: "Skip takes precedence over a supplied classification",
        }
    );
});

test("rejects removed React and Next.js output classifications", () => {
    for (const primary_stack of ["react", "nextjs"]) {
        assert.throws(
            () => normalizeDecision({
                verdict: "certain",
                confidence: 99,
                primary_stack,
                reason: "A removed frontend technology classification",
            }),
            /Unknown primary stack/
        );
    }
});

test("downgrades uncertain 'certain' decisions to review", () => {
    assert.equal(
        normalizeDecision({
            verdict: "certain",
            confidence: CERTAIN_CONFIDENCE_THRESHOLD - 1,
            primary_stack: "typescript",
            reason: "The model is not confident enough",
        }).verdict,
        "review"
    );
});

test("requires exactly one primary stack for every publishable post", () => {
    assert.throws(
        () => normalizeDecision({
            verdict: "review",
            confidence: 61,
            primary_stack: null,
            reason: "The primary stack is ambiguous",
        }),
        /must have one primary stack/
    );
});

test("does not format rejected vacancies for publishing", () => {
    assert.throws(
        () => formatDecisionHashtags({
            verdict: "reject",
            confidence: 98,
            primary_stack: null,
            reason: "This is an article, not a vacancy",
        }),
        /cannot be formatted/
    );
});

test("rejects empty and malformed model responses", async () => {
    await assert.rejects(
        analyzeVacancy("A vacancy", {
            responses: {
                create: async () => ({ output_text: "" }),
            },
        }),
        /returned no vacancy decision/
    );

    await assert.rejects(
        analyzeVacancy("A vacancy", {
            responses: {
                create: async () => ({ output_text: "not json" }),
            },
        }),
        /returned invalid JSON/
    );
});
