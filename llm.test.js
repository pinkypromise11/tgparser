const test = require("node:test");
const assert = require("node:assert/strict");

const { analyzeVacancy } = require("./llm");

test("analyzeVacancy requests and parses a structured decision", async () => {
    let request;
    const fakeClient = {
        responses: {
            create: async (value) => {
                request = value;
                return {
                    output_text: JSON.stringify({
                        relevant: true,
                        confidence: 93,
                        reason: "Node.js backend vacancy",
                    }),
                };
            },
        },
    };

    const decision = await analyzeVacancy(
        "Hiring a Node.js backend developer",
        fakeClient
    );

    assert.deepEqual(decision, {
        relevant: true,
        confidence: 93,
        reason: "Node.js backend vacancy",
    });
    assert.equal(request.model, "gpt-5-mini");
    assert.equal(request.text.format.type, "json_schema");
    assert.equal(request.text.format.strict, true);
});

test("analyzeVacancy rejects an empty model response", async () => {
    const fakeClient = {
        responses: {
            create: async () => ({ output_text: "" }),
        },
    };

    await assert.rejects(
        analyzeVacancy("A vacancy", fakeClient),
        /returned no vacancy decision/
    );
});
