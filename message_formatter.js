function formatVacancyMessage({
    hashtags,
    postText,
    sourceTitle,
    postLink,
}) {
    const sourceLines = sourceTitle && postLink
        ? [
            `📢 Источник: ${sourceTitle}`,
            `🔗 ${postLink}`,
            "",
        ]
        : [];

    return [
        "💼 ВАКАНСИЯ",
        hashtags,
        "",
        ...sourceLines,
        "────────────────",
        "",
        postText,
    ].join("\n");
}

module.exports = { formatVacancyMessage };
