const test = require("node:test");
const assert = require("node:assert/strict");
const { retainPositions } = require("../scripts/refilter_published_digest");

test("editing an existing digest preserves text and original numbers, including gaps", () => {
    const text = "Подборка\nчасть 2/3\n\n6. Первая\n#remote\nОписание A\n\n7. Вторая\nОписание B\n\n8. Третья\nОписание C";
    const after = retainPositions(text, new Set([6, 8]));
    assert.deepEqual(after.retained, [6, 8]);
    assert.equal(after.text, "Подборка\nчасть 2/3\n\n6. Первая\n#remote\nОписание A\n\n8. Третья\nОписание C");
    assert.deepEqual(after.entities.map((e) => after.text.slice(e.offset, e.offset + e.length)), ["6. Первая", "8. Третья"]);
});

test("no matches replaces the list with an explicit empty-result notice, keeping its header", () => {
    const after = retainPositions("Источник /37\nчасть 1/3\n\n1. A\nText\n\n2. B\nText", new Set());
    assert.equal(after.text, "Источник /37\nчасть 1/3\n\nПодходящих вакансий по актуальным фильтрам нет.");
    assert.deepEqual(after.entities, []);
    assert.deepEqual(after.retained, []);
});
