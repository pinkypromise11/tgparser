const axios = require("axios");
const cheerio = require("cheerio");
const dns = require("node:dns").promises;
const http = require("node:http");
const https = require("node:https");
const ipaddr = require("ipaddr.js");
const { canonicalUrl } = require("./digest_links");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function publicAddress(address) {
    try {
        const parsed = ipaddr.process(address);
        return parsed.range() === "unicast";
    } catch { return false; }
}

async function resolvePublicUrl(value, lookup = dns.lookup) {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
        (url.port && !["80", "443"].includes(url.port))) throw new Error("Unsafe URL");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = ipaddr.isValid(host)
        ? [{ address: host, family: ipaddr.parse(host).kind() === "ipv6" ? 6 : 4 }]
        : await lookup(host, { all: true, verbatim: true });
    if (!addresses.length || addresses.some((item) => !publicAddress(item.address))) throw new Error("Non-public destination");
    return { url, addresses };
}

// Resolve and pin the destination for every hop: validation cannot race a second DNS lookup.
async function safeRequest(value, { timeout = 20000, maxBytes = 5 * 1024 * 1024 } = {}) {
    let current = value;
    for (let hop = 0; hop <= 5; hop++) {
        const { url, addresses } = await resolvePublicUrl(current);
        const lookup = (_host, opts, cb) => {
            if (typeof opts === "function") { cb = opts; opts = {}; }
            if (opts.all) cb(null, addresses);
            else cb(null, addresses[0].address, addresses[0].family);
        };
        const httpAgent = new http.Agent({ lookup });
        const httpsAgent = new https.Agent({ lookup });
        let response;
        try {
            response = await axios.get(url.href, { timeout, maxRedirects: 0, proxy: false,
                httpAgent, httpsAgent, responseType: "arraybuffer", maxContentLength: maxBytes,
                maxBodyLength: maxBytes, validateStatus: () => true,
                headers: { "User-Agent": "Mozilla/5.0 (compatible; VacancyReader/1.0)", Accept: "text/html,application/xhtml+xml,*/*;q=0.8" } });
        } finally { httpAgent.destroy(); httpsAgent.destroy(); }
        if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
            current = new URL(response.headers.location, url).href;
            continue;
        }
        return { url: url.href, status: response.status, headers: response.headers, body: Buffer.from(response.data) };
    }
    throw new Error("Too many redirects");
}

function plainHtml(html) {
    const $ = cheerio.load(html || "");
    $("script,style,nav,footer,header,noscript,aside").remove();
    $("br").replaceWith("\n");
    $("p,li,div,h1,h2,h3,h4,section").append("\n");
    return $.text().replace(/[ \t\u00a0]+/gu, " ").replace(/\n\s*\n/gu, "\n").trim();
}

function locationMetadata(value) {
    // Some boards expand "worldwide" into every country. This is not employer confirmation for Russia.
    return Array.isArray(value) && value.length > 50
        ? "Worldwide: broad aggregator-generated country list, not explicit country eligibility"
        : value;
}

function extractPage(html, url) {
    const $ = cheerio.load(html);
    const postings = [];
    function walk(value) {
        if (!value || typeof value !== "object") return;
        if ([].concat(value["@type"] || []).includes("JobPosting")) postings.push(value);
        if (Array.isArray(value)) value.forEach(walk);
        else if (value["@graph"]) walk(value["@graph"]);
    }
    $('script[type="application/ld+json"]').each((_i, element) => {
        try { walk(JSON.parse($(element).text())); } catch { /* Malformed unrelated JSON-LD is common. */ }
    });
    const title = $("h1").first().text().trim() || $("title").text().trim();
    // Multiple postings are normally a search/catalog page, not one vacancy.
    const job = postings.length === 1 ? postings[0] : null;
    const root = $("main").first().length ? $("main").first() : $("article").first().length ? $("article").first() : $("body");
    root.find('nav,footer,aside,[class*="related"],[class*="recommended"]').remove();
    const body = plainHtml(root.html()).split(/\n(?:Similar Jobs|Related Jobs|Recommended Jobs|Смотреть ещ[её] вакансии|Похожие вакансии)\s*\n/iu)[0].slice(0, 35000);
    const description = job ? plainHtml(job.description) : "";
    const metadata = job ? JSON.stringify({ title: job.title, company: job.hiringOrganization?.name,
        employmentType: job.employmentType, jobLocation: locationMetadata(job.jobLocation),
        applicantLocationRequirements: locationMetadata(job.applicantLocationRequirements), jobLocationType: job.jobLocationType,
        baseSalary: job.baseSalary, validThrough: job.validThrough, datePosted: job.datePosted }) : "";
    const text = `${description}\n${metadata}\n${body}`.trim().slice(0, 45000);
    const catalog = postings.length > 1 || new URL(url).pathname === "/";
    const closedNotice = /(?:this (?:job|position|vacancy) (?:is |has been )?(?:closed|expired|filled)|no longer accepting applications|вакансия (?:закрыта|в архиве))/iu.test(body);
    return { url, title: job?.title || title, company: job?.hiringOrganization?.name || "", text,
        readable: !catalog && (closedNotice || description.length > 180 || (body.length > 350 && /responsibilit|requirement|qualificat|about (?:the |this )?(?:role|job)|обязанност|требован|what you|who you|your role/iu.test(body))),
        reason: catalog ? "Ссылка ведёт на каталог или главную страницу" : "Не удалось прочитать описание вакансии" };
}

async function renderPage(url, { request = safeRequest } = {}) {
    const { chromium } = require("playwright");
    const browser = await chromium.launch({ headless: true, channel: "chromium" });
    try {
        const context = await browser.newContext({ serviceWorkers: "block" });
        await context.route("**/*", async (route) => {
            try {
                if (route.request().method() !== "GET" || ["image", "media", "font"].includes(route.request().resourceType())) return await route.abort();
                const response = await request(route.request().url(), { timeout: 12000 });
                // Fulfill all requests ourselves: browser subresources obey the same pinned-DNS policy.
                const headers = { ...response.headers };
                for (const key of ["content-encoding", "content-length", "transfer-encoding", "set-cookie", "connection"]) delete headers[key];
                await route.fulfill({ status: response.status, headers, body: response.body });
            } catch { await route.abort().catch(() => {}); }
        });
        await context.routeWebSocket("**/*", (socket) => socket.close());
        const page = await context.newPage();
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForLoadState("networkidle", { timeout: 7000 }).catch(() => {});
        return extractPage(await page.content(), page.url());
    } finally { await browser.close(); }
}

// Official documented public API, matched by canonical job URL, never by search rank.
async function fetchHimalayas(candidate, request, pause) {
    const url = new URL(candidate.url);
    const match = /^\/companies\/([^/]+)\/jobs\/([^/]+)\/?$/u.exec(url.pathname);
    if (url.hostname !== "himalayas.app" || !match) return null;
    const query = new URL("https://himalayas.app/jobs/api/search");
    query.searchParams.set("company", match[1]);
    query.searchParams.set("q", candidate.label.split(",")[0]);
    for (let page = 1; page <= 5; page++) {
        query.searchParams.set("page", String(page));
        let response;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                response = await request(query.href);
                if (response.status === 429 || response.status >= 500) throw new Error(`HTTP ${response.status}`);
                break;
            } catch (error) {
                if (attempt === 2) throw error;
                await pause(1000 * 2 ** attempt);
            }
        }
        if (response.status !== 200) return null;
        const data = JSON.parse(response.body.toString("utf8"));
        if (!Array.isArray(data.jobs)) return null;
        const job = data.jobs.find((item) => canonicalUrl(item.guid) === canonicalUrl(candidate.url));
        if (job && typeof job.description === "string") {
            const description = plainHtml(job.description);
            if (description.length < 180) return null;
            const metadata = { ...job };
            delete metadata.description;
            delete metadata.companyLogo;
            return { status: "readable", url: candidate.url, fetchedVia: query.href,
                attribution: "Himalayas", title: job.title, company: job.companyName,
                text: `${description}\n${JSON.stringify(metadata, null, 2)}`.slice(0, 45000) };
        }
        if (!data.jobs.length || data.jobs.length * page >= data.totalCount) break;
    }
    return null;
}

async function fetchVacancy(candidate, { request = safeRequest, render = renderPage, pause = sleep } = {}) {
    if (new URL(candidate.url).hostname === "himalayas.app") {
        try {
            const apiPage = await fetchHimalayas(candidate, request, pause);
            if (apiPage) return apiPage;
        } catch { /* A missing/temporarily unavailable API record falls back to the linked page. */ }
    }
    let response;
    let reason = "Не удалось загрузить страницу";
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            response = await request(candidate.url);
            if (response.status === 429 || response.status >= 500) throw new Error(`HTTP ${response.status}`);
            break;
        } catch (error) {
            reason = error.message;
            if (/Unsafe|Non-public|Too many redirects/iu.test(reason)) break;
            if (attempt < 2) await pause(1000 * 2 ** attempt);
        }
    }
    if (!response || response.status >= 400) {
        return { status: "unavailable", url: candidate.url, reason: response ? `HTTP ${response.status}` : reason };
    }
    if (!/html|xhtml/i.test(response.headers["content-type"] || "")) return { status: "unavailable", url: candidate.url, reason: "Страница не содержит HTML-описания" };
    let page = extractPage(response.body.toString("utf8"), response.url);
    if (!page.readable && new URL(response.url).pathname !== "/") {
        try { page = await render(response.url); } catch (error) { page.reason = `Описание недоступно; браузер: ${error.message.split("\n")[0]}`; }
    }
    return page.readable ? { ...page, status: "readable" } : { status: "unavailable", url: response.url, reason: page.reason };
}

module.exports = { publicAddress, resolvePublicUrl, safeRequest, extractPage, fetchVacancy, renderPage, fetchHimalayas };
