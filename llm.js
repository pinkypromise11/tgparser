const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

async function analyzeVacancy(postText) {
  const prompt = `
Ты HR-фильтр.

Определи, подходит ли вакансия кандидату.

Подходит только если:

1. Есть JavaScript/TypeScript стек
2. Есть React, Node.js, NestJS, Next.js, Python backend
3. Роль разработчика:
   - frontend
   - backend
   - fullstack
   - software engineer

Исключить:

- product manager
- project manager
- sales
- recruiter
- php
- java
- ios
- android
- designer
- analyst
- data scientist
- specialist

Верни JSON.

{
  "relevant": true/false,
  "confidence": 0-100,
  "reason": "..."
}

Текст вакансии:

${postText}
`;

  const response = await client.responses.create({
    model: "gpt-5-mini",
    input: prompt
  });

  return response.output_text;
}

module.exports = { analyzeVacancy };