async function resolveTargetChat(client, target) {
    let entity;
    if (/^-?\d+$/u.test(target)) {
        // StringSession does not persist channel access hashes. Reading dialogs
        // loads the private destination into GramJS's cache on every startup.
        for await (const dialog of client.iterDialogs({})) {
            if (String(dialog.id) === target) {
                entity = dialog.entity;
                break;
            }
        }
    } else {
        entity = await client.getEntity(target);
    }
    if (!entity || entity.left || entity.kicked || /Forbidden/u.test(entity.className || "")) {
        throw new Error(`Нет доступа к чату назначения ${target}. Добавьте аккаунт парсера в этот чат.`);
    }
    if (entity.broadcast && !entity.creator && !entity.adminRights?.postMessages) {
        throw new Error(`В канале «${entity.title}» аккаунту парсера нужны права администратора с разрешением «Публикация сообщений».`);
    }
    const restricted = entity.bannedRights?.sendMessages || entity.bannedRights?.sendPlain;
    const groupRestricted = !entity.creator && !entity.adminRights &&
        (entity.defaultBannedRights?.sendMessages || entity.defaultBannedRights?.sendPlain);
    if (restricted || groupRestricted) {
        throw new Error(`В чате «${entity.title}» аккаунту парсера запрещена отправка сообщений.`);
    }
    return entity;
}

module.exports = { resolveTargetChat };
