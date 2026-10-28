const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveTargetChat } = require("../src/target_chat");

function clientWithDialogs(dialogs) {
    return { iterDialogs: async function* () { yield* dialogs; } };
}

test("finds a private numeric destination in dialogs after a fresh session load", async () => {
    const entity = { title: "Destination", className: "Channel", broadcast: true, adminRights: { postMessages: true } };
    const client = clientWithDialogs([{ id: "-1001", entity: {} }, { id: "-1002", entity }]);
    assert.equal(await resolveTargetChat(client, "-1002"), entity);
});

test("rejects a channel subscriber without publishing rights before processing jobs", async () => {
    const client = clientWithDialogs([{ id: "-1002", entity: { title: "Destination", broadcast: true } }]);
    await assert.rejects(resolveTargetChat(client, "-1002"), /Публикация сообщений/u);
});

test("requires membership and respects group message restrictions", async () => {
    await assert.rejects(resolveTargetChat(clientWithDialogs([]), "-1002"), /Добавьте аккаунт/u);
    const entity = { title: "Group", defaultBannedRights: { sendPlain: true } };
    const client = clientWithDialogs([{ id: "-42", entity }]);
    await assert.rejects(resolveTargetChat(client, "-42"), /запрещена отправка/u);
    entity.adminRights = { changeInfo: true };
    assert.equal(await resolveTargetChat(client, "-42"), entity);
    entity.bannedRights = { sendMessages: true };
    await assert.rejects(resolveTargetChat(client, "-42"), /запрещена отправка/u);
});

test("resolves a public destination by username and allows its owner to publish", async () => {
    const entity = { title: "Destination", broadcast: true, creator: true };
    const client = { getEntity: async (target) => { assert.equal(target, "@destination"); return entity; } };
    assert.equal(await resolveTargetChat(client, "@destination"), entity);
});
