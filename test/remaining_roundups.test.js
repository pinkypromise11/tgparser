const test=require("node:test");
const assert=require("node:assert/strict");
const {extractCandidates,SELECTION}=require("../scripts/process_remaining_roundups");
const {extractPage}=require("../src/digest_fetch");
function message(text,pairs){return {message:text,entities:pairs.map(([label,url])=>({className:"MessageEntityTextUrl",offset:text.indexOf(label),length:label.length,url}))};}
test("remaining batch contains exactly the 46 non-young posts",()=>{
    assert.equal(Object.values(SELECTION).reduce((n,a)=>n+a.length,0),46);
    assert.ok(!SELECTION.young_relocate);
});
test("Habr excludes catalog and keeps role numbering",()=>{
    const m=message("Senior React Developer\n\nSenior Python Developer\n\nБольше вакансий",[
        ["Senior React Developer","https://u.habr.com/one"],["Senior Python Developer","https://u.habr.com/two"],["Больше вакансий","https://u.habr.com/catalog"]]);
    assert.deepEqual(extractCandidates(m,"habr_career").map(c=>c.originalNumber),[1,2]);
});
test("repeated URL does not shift the original number of a later role",()=>{
    const m=message("First\nSecond\nThird",[["First","https://wantapply.com/one"],["Second","https://wantapply.com/one"],["Third","https://wantapply.com/three"]]);
    assert.deepEqual(extractCandidates(m,"opento_dev").map(c=>c.originalNumber),[1,3]);
});
test("career bullet blocks combine application links and retain gaps for Telegram-only jobs",()=>{
    const m=message("🔹First Engineer\nApply here\n\n🔹Second Engineer\nTelegram only\n\n🔹Third Engineer\nDetails",[
        ["First Engineer","https://example.com/first"],["Apply here","https://example.com/apply"],["Second Engineer","https://t.me/recruiter"],["Third Engineer","https://example.com/third"]]);
    const result=extractCandidates(m,"careerylej");
    assert.deepEqual(result.map(c=>c.originalNumber),[1,3]);
    assert.deepEqual(result[0].alternateUrls,["https://example.com/apply"]);
    assert.ok(!result[0].context.includes("Second"));
});
test("01.tech uses the job title rather than generic application anchor",()=>{
    const m=message("⚪️ Senior Backend Developer — Node.js\n→ Details",[["Details","https://01.tech/ru/vacancies/abc"]]);
    assert.equal(extractCandidates(m,"youritjob")[0].label,"Senior Backend Developer — Node.js");
});
test("Russian recommendations never supply keywords or seniority to the target description",()=>{
    const page=extractPage('<main><h1>Frontend</h1><p>Требования: React</p><h2>Смотреть ещё вакансии</h2><p>Senior QA Python</p></main>','https://career.habr.com/vacancies/123');
    assert.ok(page.text.includes("React"));
    assert.ok(!page.text.includes("Senior QA"));
});
