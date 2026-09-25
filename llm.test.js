const test = require("node:test");
const assert = require("node:assert/strict");

const {
    APPLICATION_METHODS,
    APPLICATION_METHOD_SCHEMA,
    CERTAIN_CONFIDENCE_THRESHOLD,
    EMPLOYMENT_DECISION_SCHEMA,
    EMPLOYMENT_TYPES,
    LOCATION_CONFIDENCE_THRESHOLD,
    LOCATION_DECISION_SCHEMA,
    LINKEDIN_APPLICATION_DECISION_SCHEMA,
    MODEL,
    PRIMARY_STACKS,
    RETAG_DECISION_SCHEMA,
    RETAG_PRIMARY_STACKS,
    WORK_MODE_DECISION_SCHEMA,
    WORK_MODES,
    analyzeApplicationMethods,
    analyzeLinkedinApplication,
    analyzePublishedVacancyTag,
    analyzeVacancy,
    analyzeVacancyEmployment,
    analyzeVacancyLocation,
    analyzeVacancyWorkMode,
    enforceApplicationEvidence,
    formatDecisionHashtags,
    formatEmploymentHashtags,
    formatWorkModeHashtag,
    normalizeDecision,
    normalizeApplicationDecision,
    normalizeEmploymentDecision,
    normalizeLocationDecision,
    normalizeLinkedinApplicationDecision,
    normalizeRetagDecision,
    normalizeWorkModeDecision,
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
    assert.match(request.instructions, /real open DevOps vacancy/);
    assert.match(request.instructions, /combined DevOps\/SRE roles/);
    assert.match(request.instructions, /DevOps is the explicit primary role/);
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

test("accepts Senior DevOps decisions and publishes the DevOps hashtag", async () => {
    const fake = fakeOpenAI({
        verdict: "certain",
        confidence: 96,
        primary_stack: "devops",
        reason: "DevOps is the explicit primary role",
    });
    const decision = await analyzeVacancy(
        "We are hiring a Senior DevOps Engineer",
        fake.client
    );

    assert.ok(PRIMARY_STACKS.includes("devops"));
    assert.ok(
        fake.calls[0].text.format.schema.properties.primary_stack.anyOf[0]
            .enum.includes("devops")
    );
    assert.deepEqual(decision, {
        verdict: "certain",
        confidence: 96,
        primary_stack: "devops",
        reason: "DevOps is the explicit primary role",
    });
    assert.equal(
        formatDecisionHashtags(decision),
        "#\u0434\u043e\u0441\u0442\u043e\u0432\u0435\u0440\u043d\u043e #devops"
    );
});

test("publishes Django and FastAPI backend vacancies under Python", () => {
    for (const primaryStack of ["django", "fastapi"]) {
        const hashtags = formatDecisionHashtags({
            verdict: "certain",
            confidence: 95,
            primary_stack: primaryStack,
            reason: `${primaryStack} is the primary backend framework`,
        });

        assert.ok(hashtags.endsWith(" #python"));
        assert.doesNotMatch(hashtags, /#(?:django|fastapi)\b/u);
    }
});

test("classifies explicit vacancy geography with a strict schema", async () => {
    const fake = fakeOpenAI({
        location: "rf",
        confidence: 99,
        reason: "The vacancy explicitly requires working from Minsk, Belarus",
    });

    const decision = await analyzeVacancyLocation(
        "Work from our Minsk office, Belarus",
        fake.client
    );
    const request = fake.calls[0];

    assert.deepEqual(decision, {
        location: "rf",
        confidence: 99,
        reason: "The vacancy explicitly requires working from Minsk, Belarus",
    });
    assert.equal(request.model, MODEL);
    assert.equal(request.store, false);
    assert.equal(request.text.format.schema, LOCATION_DECISION_SCHEMA);
    assert.match(request.instructions, /merely says remote or worldwide/);
    assert.match(request.instructions, /salary currency/);
    assert.match(request.instructions, /mixture of Russia\/Belarus and other countries/);
    assert.match(request.instructions, /Europe or European time zones alone MUST be unknown/);
});

test("formats only definite high-confidence location hashtags", () => {
    const vacancy = {
        verdict: "certain",
        confidence: 99,
        primary_stack: "frontend",
        reason: "Explicit senior frontend vacancy",
    };

    assert.ok(formatDecisionHashtags(vacancy, [], {
        location: "rf",
        confidence: 97,
        reason: "Moscow office",
    }).includes("#\u0440\u0444"));
    assert.ok(formatDecisionHashtags(vacancy, [], {
        location: "outside",
        confidence: 98,
        reason: "Poland only",
    }).includes("#\u0432\u0443"));
    assert.doesNotMatch(formatDecisionHashtags(vacancy, [], {
        location: "unknown",
        confidence: 100,
        reason: "Remote with no country restriction",
    }), /#(?:\u0440\u0444|\u0432\u0443)\b/u);

    assert.equal(
        normalizeLocationDecision({
            location: "outside",
            confidence: LOCATION_CONFIDENCE_THRESHOLD - 1,
            reason: "The evidence is not certain enough",
        }).location,
        "unknown"
    );
});

test("classifies every explicit employment format with a strict schema", async () => {
    const fake = fakeOpenAI({
        types: ["full_time", "b2b", "project", "part_time"],
        confidence: 99,
        reason: "The post explicitly states a fixed six-month project, B2B, and both schedules.",
    });

    const decision = await analyzeVacancyEmployment(
        "B2B contract for a six-month project; part-time or full-time.",
        fake.client
    );
    const request = fake.calls[0];

    assert.deepEqual(decision.types, EMPLOYMENT_TYPES);
    assert.equal(request.model, MODEL);
    assert.equal(request.store, false);
    assert.equal(request.text.format.schema, EMPLOYMENT_DECISION_SCHEMA);
    assert.match(request.instructions, /temporary and has a definite finite project term/);
    assert.match(request.instructions, /B2B is explicitly stated/);
    assert.match(request.instructions, /Do not infer it from a normal schedule/);
    assert.match(request.instructions, /empty types array/);
});

test("formats combined employment hashtags without adding a tag for an empty decision", () => {
    assert.deepEqual(
        formatEmploymentHashtags({
            types: ["full_time", "b2b", "project", "part_time"],
            confidence: 99,
            reason: "All formats are explicit",
        }),
        ["#проект", "#контракт", "#part-time", "#фуллтайм"]
    );
    assert.deepEqual(formatEmploymentHashtags([]), []);

    const hashtags = formatDecisionHashtags(
        {
            verdict: "certain",
            confidence: 99,
            primary_stack: "frontend",
            reason: "Explicit senior frontend vacancy",
        },
        ["recruiter"],
        null,
        ["b2b", "part_time"]
    );

    assert.equal(
        hashtags,
        "#достоверно #frontend #контракт #part-time #рекрутер"
    );
});

test("rejects unknown and duplicate employment types", () => {
    assert.throws(
        () => normalizeEmploymentDecision({
            types: ["freelance"],
            confidence: 99,
            reason: "Unsupported output",
        }),
        /Unknown employment type/
    );
    assert.throws(
        () => normalizeEmploymentDecision({
            types: ["b2b", "b2b"],
            confidence: 99,
            reason: "Duplicate output",
        }),
        /Duplicate employment type/
    );
});

test("classifies one explicit work mode with a strict schema", async () => {
    const fake = fakeOpenAI({
        mode: "hybrid",
        confidence: 99,
        reason: "The post explicitly requires hybrid work between home and the employer office.",
    });

    const decision = await analyzeVacancyWorkMode(
        "Hybrid work: three days at home and two days in our office.",
        fake.client
    );
    const request = fake.calls[0];

    assert.deepEqual(decision, {
        mode: "hybrid",
        confidence: 99,
        reason: "The post explicitly requires hybrid work between home and the employer office.",
    });
    assert.deepEqual(WORK_MODES, ["remote", "onsite", "hybrid", "unknown"]);
    assert.equal(request.model, MODEL);
    assert.equal(request.text.format.schema, WORK_MODE_DECISION_SCHEMA);
    assert.match(request.instructions, /mutually exclusive/);
    assert.match(request.instructions, /fully remote or fully remote-only/);
    assert.match(request.instructions, /employer's office/);
    assert.match(request.instructions, /empty types array|unknown when no work format/i);
});

test("formats only one mutually exclusive work-mode hashtag", () => {
    assert.equal(formatWorkModeHashtag({
        mode: "remote",
        confidence: 99,
        reason: "Fully remote is explicit",
    }), "#remote");
    assert.equal(formatWorkModeHashtag({
        mode: "unknown",
        confidence: 100,
        reason: "No work mode is stated",
    }), null);
    assert.throws(
        () => normalizeWorkModeDecision({
            mode: "office",
            confidence: 99,
            reason: "Unsupported output",
        }),
        /Unknown work mode/
    );
});

test("classifies LinkedIn only when it is an explicit application route", async () => {
    const fake = fakeOpenAI({
        linkedin: true,
        confidence: 98,
        reason: "The post explicitly asks candidates to apply through LinkedIn.",
    });

    const decision = await analyzeLinkedinApplication(
        "Please apply through LinkedIn.",
        fake.client
    );
    const request = fake.calls[0];

    assert.deepEqual(decision, {
        linkedin: true,
        confidence: 98,
        reason: "The post explicitly asks candidates to apply through LinkedIn.",
    });
    assert.equal(request.text.format.schema, LINKEDIN_APPLICATION_DECISION_SCHEMA);
    assert.match(request.instructions, /application action and LinkedIn/);
    assert.match(request.instructions, /company LinkedIn page/);
    assert.throws(
        () => normalizeLinkedinApplicationDecision({
            linkedin: "yes",
            confidence: 98,
            reason: "Malformed output",
        }),
        /boolean linkedin/
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
