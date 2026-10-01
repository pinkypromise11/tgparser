// One-off, explicitly scoped follow-up to the 55-post audit. No Telegram writes without --publish.
require("dotenv").config({ quiet: true });
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { atomicWrite, parseWebPage } = require("./process_young_roundups");
const { canonicalUrl, extractDigestLinks, TARGET_ID } = require("../src/digest_links");
const { fetchVacancy } = require("../src/digest_fetch");
const { prepareJob, publishJob, sendPart } = require("../src/digest_worker");
const { filterDigestVacancy, filterPolicy } = require("../src/digest_filter");
const SELECTION = {
    growglobaljobs: [30,31,33,34,35,36,37,38,39,40],
    opento_dev: [1285,1293,1298,1299],
    habr_career: [76007,76009,76011,76015,76018,76021,76023,76026,76028,76030,76032,76034,76036,76038,76040,76042,76044,76046,76049,76052,76054,76058,76060,76063],
    careerylej: [5375,5387,5390], remotegeekjob: [41803,41809,41819], youritjob: [8474], zarubezhom_jobs: [4258],
};
const DIR = path.resolve("config/remaining-roundups-20261001");
const jobFile = (source, id) => path.join(DIR, `${source}-${id}.json`);
const pageFile = url => path.join(DIR, "pages", `${crypto.createHash("sha256").update(url).digest("hex")}.json`);

const { extractCandidates } = require("../src/linked_vacancy_links");

function jobs() {
    return Object.entries(SELECTION).flatMap(([source,ids]) => ids.map(id => JSON.parse(fs.readFileSync(jobFile(source,id),"utf8"))));
}
function save(job) { atomicWrite(jobFile(job.sourceUsername,job.id),job); }
function readPage(candidate) {
    const page=JSON.parse(fs.readFileSync(pageFile(candidate.url),"utf8"));
    if(page.status==="readable"&&new URL(page.url).hostname==="career.habr.com") {
        page.text=page.text.split(/\n(?:Смотреть ещ[её] вакансии|Похожие вакансии)\s*\n/iu)[0];
    }
    return page;
}
function validateScope(job) {
    const config = require("../config/channels_with_ids.json").find(c => c.username.toLowerCase() === job.sourceUsername);
    if (!SELECTION[job.sourceUsername]?.includes(job.id) || job.source !== config?.id || job.target !== TARGET_ID) throw Error("Unexpected batch scope");
}

async function main() {
    const args=process.argv.slice(2);
    fs.mkdirSync(DIR,{recursive:true});
    let client;
    try {
        if (args.includes("--init") || args.includes("--publish")) {
            client = new TelegramClient(new StringSession(fs.readFileSync("session.txt","utf8").trim()),Number(process.env.API_ID),process.env.API_HASH,{connectionRetries:2});
            await client.connect();
        }
        if (args.includes("--init")) {
            for (const [source,ids] of Object.entries(SELECTION)) {
                const entity=await client.getEntity(source);
                const expected=require("../config/channels_with_ids.json").find(c=>c.username.toLowerCase()===source)?.id;
                if (`-100${entity.id}`!==expected) throw Error(`Wrong source: ${source}`);
                const messages=await client.getMessages(entity,{ids});
                for (const id of ids) {
                    if (fs.existsSync(jobFile(source,id))) continue;
                    const m=messages.find(m=>m.id===id);
                    if (!m?.message) throw Error(`Missing ${source}/${id}`);
                    const job={version:1,source:expected,sourceUsername:source,target:TARGET_ID,id,date:Number(m.date),sourceText:m.message,
                        candidates:extractCandidates(m,source),pages:[],results:[],parts:null,completed:false};
                    if (source==="growglobaljobs"&&id===37) {
                        const receipt=JSON.parse(fs.readFileSync("config/digest-refilter/37.json","utf8"));
                        if (receipt.target!==TARGET_ID||receipt.policy!==filterPolicy()||!receipt.verifiedAt||receipt.edits.some(e=>!e.applied)) throw Error("Unverified or outdated previous /37 edits");
                        job.alreadyHandled={receipt:"config/digest-refilter/37.json",messageIds:receipt.edits.map(e=>e.messageId)};
                    }
                    save(job); console.log(`Initialized ${source}/${id}: ${job.candidates.length}`);
                }
            }
            return;
        }
        const all=jobs(); all.forEach(validateScope);
        const active=all.filter(j=>!j.alreadyHandled);
        if (args.includes("--fetch")) {
            const cache=new Map();
            for (const dir of ["config/young-roundups-20261001/pages","config/digest-publications","config/digest-preview"]) {
                if (!fs.existsSync(dir)) continue;
                for (const file of fs.readdirSync(dir).filter(f=>f.endsWith(".json")&&!f.endsWith(".web.json"))) {
                    const value=JSON.parse(fs.readFileSync(path.join(dir,file),"utf8"));
                    if (value.status==="readable") cache.set(canonicalUrl(value.url),value);
                    if (value.candidates&&value.pages) value.candidates.forEach((c,i)=>{if(value.pages[i]?.status==="readable")cache.set(canonicalUrl(c.url),value.pages[i]);});
                }
            }
            const unique=[...new Map(active.flatMap(j=>j.candidates).map(c=>[c.url,c])).values()];
            let cursor=0,done=0;
            await Promise.all(Array.from({length:4},async()=>{
                while(cursor<unique.length) {
                    const c=unique[cursor++];
                    if(!fs.existsSync(pageFile(c.url))) {
                        const page=cache.get(c.url)||await fetchVacancy(c);
                        atomicWrite(pageFile(c.url),page);
                        console.log(`${++done}/${unique.length} ${page.status} ${c.label.slice(0,95)} ${page.reason||""}`);
                    }
                }
            }));
            return;
        }
        if(args.includes("--import-web")) {
            let imported=0;
            for(const c of new Map(active.flatMap(j=>j.candidates).map(c=>[c.url,c])).values()) {
                const file=pageFile(c.url).replace(/\.json$/u,".web.json");
                if(!fs.existsSync(file))continue;
                const data=JSON.parse(fs.readFileSync(file,"utf8"));
                const p=new URL(c.url).hostname==="wantapply.com"?parseWebPage(data.raw,c):null;
                if(p){atomicWrite(pageFile(c.url),p);imported++;}
            }
            console.log(`Imported ${imported} pages`);return;
        }
        if(args.includes("--prepare")) {
            for(const job of active) {
                try {
                    if(args.includes("--refresh-pages")) {
                        if(job.completed||job.parts?.some(p=>p.sent))throw Error("Cannot rebuild published results");
                        job.pages=job.candidates.map(readPage);job.parts=null;
                    }
                    await prepareJob(job,{save,log:()=>{},fetch:async c=>readPage(c),
                        filter:async(c,p,opts)=>p.closed?{accepted:false,stage:"description",reason:"Вакансия явно закрыта"}:filterDigestVacancy(c,p,opts)});
                    console.log(`Prepared ${job.sourceUsername}/${job.id}: accepted=${job.acceptedCount}/${job.candidates.length}`);
                }catch(e){console.error(`Pending ${job.sourceUsername}/${job.id}: ${e.message}`);process.exitCode=1;}
            }
            return;
        }
        if(args.includes("--publish")) {
            const target=await client.getEntity(TARGET_ID);if(`-100${target.id}`!==TARGET_ID)throw Error("Wrong target");
            if(active.some(j=>!j.parts||j.filterPolicy!==filterPolicy()))throw Error("Unprepared or outdated batch");
            for(const job of active) {
                await publishJob(job,{save,send:p=>sendPart(client,target,p)});
                for(const p of job.parts) {
                    if(!p.messageId)throw Error("Missing send receipt");
                    const [m]=await client.getMessages(target,{ids:[p.messageId]});
                    if(m?.message!==p.text)throw Error(`Verification failed ${p.messageId}`);
                }
                console.log(`Verified ${job.sourceUsername}/${job.id}: ${job.parts.map(p=>p.messageId).join(",")||"no matching vacancies"}`);
            }
            return;
        }
        const stages={};for(const j of active)for(const f of j.filters||[]){const key=f.accepted?"accepted":f.stage;stages[key]=(stages[key]||0)+1;}
        console.log(JSON.stringify({posts:all.length,alreadyHandled:all.filter(j=>j.alreadyHandled).map(j=>`${j.sourceUsername}/${j.id}`),positions:active.reduce((n,j)=>n+j.candidates.length,0),stages,
            publications:active.filter(j=>j.parts?.length).map(j=>({source:j.sourceUsername,id:j.id,parts:j.parts}))},null,2));
    }finally{if(client)await client.disconnect();}
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={SELECTION,extractCandidates,pageFile,DIR};
