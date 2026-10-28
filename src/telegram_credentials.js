function loadTelegramCredentials(env = process.env) {
    const useDefault = Boolean(env.API_ID || env.API_HASH);
    const apiId = Number(useDefault ? env.API_ID : env.API_ID_SUPPORT);
    const apiHash = useDefault ? env.API_HASH : env.API_HASH_SUPPORT;
    if (!Number.isSafeInteger(apiId) || apiId <= 0 || !/^[a-f0-9]{32}$/iu.test(apiHash || "")) {
        throw new Error("Проверьте API_ID/API_HASH или API_ID_SUPPORT/API_HASH_SUPPORT в .env.");
    }
    return { apiId, apiHash };
}

module.exports = { loadTelegramCredentials };
