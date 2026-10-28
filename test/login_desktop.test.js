const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { Api } = require("telegram");
const { authorizeFromDesktop, loadDesktopSession, saveSession } = require("../scripts/login_desktop");

function clients(overrides = {}) {
    const calls = [];
    const owner = { id: 42n, phone: "79991234567" };
    const desktop = {
        connect: async () => calls.push("desktop.connect"),
        getMe: async () => owner,
        invoke: async (request) => {
            assert.ok(request instanceof Api.auth.AcceptLoginToken);
            assert.deepEqual(request.token, Buffer.from("local-test-token"));
            calls.push("accept");
        },
    };
    const client = {
        connect: async () => calls.push("client.connect"),
        signInUserWithQrCode: async (credentials, params) => {
            assert.equal(credentials.apiId, 12345);
            await params.qrCode({ token: Buffer.from("local-test-token") });
            assert.equal(await params.password(), "test-password");
        },
        getMe: async () => owner,
        session: { save: () => "new-independent-session" },
        ...overrides,
    };
    return { desktop, client, calls, apiId: 12345, apiHash: "unused", phone: "+7 999 123-45-67", askPassword: async () => "test-password" };
}

test("confirms a separate login with the local session and supports 2FA", async () => {
    const context = clients();
    assert.equal(await authorizeFromDesktop(context), "new-independent-session");
    assert.deepEqual(context.calls, ["desktop.connect", "client.connect", "accept"]);
});

test("does not authorize the parser with another Desktop account", async () => {
    const context = clients();
    context.phone = "+78881234567";
    await assert.rejects(authorizeFromDesktop(context), /другой аккаунт/u);
    assert.deepEqual(context.calls, ["desktop.connect"]);
});

test("does not return a session if Telegram authorizes an unexpected user", async () => {
    let saved = false;
    const context = clients({
        getMe: async () => ({ id: 43n }),
        session: { save: () => { saved = true; } },
    });
    await assert.rejects(authorizeFromDesktop(context), /подтвердить аккаунт/u);
    assert.equal(saved, false);
});

test("propagates failed login without overwriting the saved session", async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-desktop-auth-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "session.txt");
    fs.writeFileSync(file, "existing-session");
    const context = clients({ signInUserWithQrCode: async () => { throw new Error("SESSION_REVOKED"); } });
    await assert.rejects(async () => saveSession(file, await authorizeFromDesktop(context)), /SESSION_REVOKED/);
    assert.equal(fs.readFileSync(file, "utf8"), "existing-session");
    saveSession(file, "new-session");
    assert.equal(fs.readFileSync(file, "utf8"), "new-session");
    assert.deepEqual(fs.readdirSync(dir), ["session.txt"]);
});

test("loads the active nonzero tdata account and never modifies Desktop files", async (t) => {
    const { Tdata, convertToTdata, convertFromGramjsSession } = await import("@mtcute/convert");
    const { DC_MAPPING_PROD } = await import("@mtcute/convert");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-desktop-data-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const keys = [randomBytes(256), randomBytes(256)];
    await convertToTdata(keys.map((authKey, i) => ({
        version: 3,
        primaryDcs: DC_MAPPING_PROD[2],
        authKey,
        self: { userId: 100 + i },
    })), { path: dir });
    const tdata = await Tdata.open({ path: dir });
    await tdata.writeKeyData({ ...tdata.keyData, active: 1 });
    const before = new Map(fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile())
        .map((entry) => [entry.name, fs.readFileSync(path.join(dir, entry.name))]));
    const session = await loadDesktopSession(dir, undefined, () => assert.fail("unexpected password request"));
    assert.deepEqual(Buffer.from(convertFromGramjsSession(session).authKey), keys[1]);
    for (const [name, bytes] of before) assert.deepEqual(fs.readFileSync(path.join(dir, name)), bytes);
    await assert.rejects(loadDesktopSession(dir, "9", () => {}), /Доступные номера/u);
});

test("asks for the Desktop passcode only when the tdata is encrypted with one", async (t) => {
    const { convertToTdata, convertFromGramjsSession, DC_MAPPING_PROD } = await import("@mtcute/convert");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-desktop-locked-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const authKey = randomBytes(256);
    await convertToTdata({ version: 3, primaryDcs: DC_MAPPING_PROD[2], authKey }, { path: dir, passcode: "1234" });
    let prompts = 0;
    const session = await loadDesktopSession(dir, undefined, async () => { prompts++; return "1234"; });
    assert.deepEqual(Buffer.from(convertFromGramjsSession(session).authKey), authKey);
    assert.equal(prompts, 1);
});
