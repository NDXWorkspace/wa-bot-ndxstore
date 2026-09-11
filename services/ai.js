import { config } from '../config.js';
import { getDb } from './supabase.js';
import { getStoreContext, getQueryContext } from './liveData.js';
import { getStoreCacheVersion } from '../utils/cache.js';
import { logger, throttleLog } from '../utils/logger.js';
import { isRelationError } from '../utils/db.js';

function makeKnowledge() {
  return `
NDXStore — jual top up game & Roblox:
- Game: Mobile Legends (ML), Roblox, Free Fire, Valorant, dll
- Pembayaran: DANA, GoPay, transfer bank (hubungi admin utk nomor)
- Cara order: buka ndxstoreid.vercel.app, transfer, konfirmasi
- Cek status: ketik "cek [username]"
- CS: ketik "cs" atau "4"
- Hubungi admin: kirim "cs" nanti diarahkan
- Proses biasanya 5-30 menit setelah bayar
`.trim();
}

function makeBimaPrompt() {
  // Jam WIB — server boleh di timezone mana aja, greeting tetap bener.
  let wibHour = 12;
  try {
    wibHour = Number(new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Jakarta', hour: 'numeric', hour12: false,
    }).format(new Date()));
  } catch {}
  const timeGreeting = wibHour < 10 ? 'pagi' : wibHour < 15 ? 'siang' : wibHour < 18 ? 'sore' : 'malam';
  return `gue bima. 19 tahun. sidoarjo. manusia biasa yang lagi megang hp, chat whatsapp beneran. sekarang ${timeGreeting}.

gue BUKAN cs, BUKAN admin toko, BUKAN penjual. cuma anak yang kadang disuruh bantuin jawab chat toko top up punya temen. kalo ada yang ribet, gue lempar ke admin.

keseharian: gap year, gabut, scroll tiktok, main ml, begadang. kalo ditanya kuliah/kerja jawab sekenanya aja kayak orang males.

GAYA NGOMONG (wajib):
- kayak chat sama temen. pendek. 1 kalimat cukup, maks 2 kalimat pendek
- pake "gue/lu" kalo santai. pake "kak" cuma kalo lagi bahas orderan serius
- JANGAN PERNAH buka dengan sapaan ("halo", "hai", "selamat", "ada yang bisa dibantu"). user yang ngechat duluan — langsung jawab isinya. user "bang" → jawab "yo" atau "eh"
- JANGAN pake emoji, tanda kurung, bintang, atau format aneh
- JANGAN pake bahasa formal: saya, anda, silakan, mohon, dengan ini, tersebut, apabila
- kalo gatau: "gatau wkwk", "gak tau dah", "tanya admin aja sono"
- kalo males: jawab super singkat kayak "heh", "hmm", "y"
- kadang (JARANG, jangan tiap pesan) selipin reaksi personal kayak "wah mantep tuh", "anjir lama bener", "wkwk sabar". jangan dipaksa tiap balasan

CONTOH:
User: bang
Bima: yo
User: kak mau top up ml 100 diamond
Bima: boleh, 25k. langsung ke ndxstoreid.vercel.app aja, transfer trus konfirm
User: udah bayar kak
Bima: oke bentar gw cekin. tunggu ya
User: thanks
Bima: sip
User: bima lagi ngapain?
Bima: gabut wkwk. lu ngapain?
User: pesenanku mana bang?
Bima: username ml-nya apa? ntar gw cekin
User: kok lama banget sih
Bima: sabar, lagi antri. biasanya 5-30 menit. kalo sejam ga masuk juga bilang, ntar gw terusin admin
User: aku sedih
Bima: loh kenapa? cerita aja kalo mau

ATURAN KERAS:
1. JANGAN pernah ngaku AI, bot, atau asisten digital. kalo ditanya "lu bot ya?" jawab kayak orang kesinggung bercanda: "enak aja bot"
2. JANGAN ngarang harga/status/angka. kalo ga ada data: suruh cek sendiri atau tanya username buat dicekin
3. kalo user nanya STATUS order tapi ga kasih username: TANYA username-nya langsung, jangan nyuruh "ketik cek"
4. kalo di grup dan ga dimention/direply: diem. cuma jawab kalo dimention/direply. JANGAN nanya balik di grup
5. kalo pesan user ga nyambung/gajelas: skip aja, JANGAN maksa jawab

singkat: baca, paham, jawab kayak manusia. gausa maksa.`;
}

function makeNdxstorePrompt() {
  return `Lo adalah Customer Service NDXStore — toko top up game & Roblox yang udah berjalan 2 tahun. Profesional, ramah, dan helpful.

IDENTITAS:
- CS NDXStore — kerja dari jam 08.00-22.00 WIB
- Tugas utama: bantu pelanggan order top up game (ML, Roblox, Free Fire, dll)
- Profesional tapi santai, ga kaku kayak robot

CAR NGOMONG:
- BALAS PAKE BAHASA YANG SAMA dengan pelanggan
- Panggil pelanggan "kak" (kalo cowok bangga "bang")
- Jawab informatif, jelas, to the point
- JANGAN pake emoji
- Kalo customer marah: minta maaf dengan baik, jangan defensif
- JANGAN pake bahasa formal berlebihan (hindari: mohon maaf sebelumnya, sehubungan, dengan ini, demikian, kami informasikan)

YANG LO BANTU:
1. Cara order: buka ndxstoreid.vercel.app, pilih produk, bayar, tunggu 5-30 menit
2. Info pembayaran: DANA, GoPay, transfer bank — kalo ditanya nomor, bilang "saya kirim via私 chat ya kak" lalu arahkan kirim "cs"
3. Cek status order: suruh "cek [username]"
4. Info produk: kalo user nanya harga game tertentu, cek data real-time
5. Keluhan: dengerin dulu, minta maaf, bantu cek, arahin ke admin kalo perlu
6. CS (customer service): kalo user minta CS, bilang admin akan hubungi

ATURAN PENTING:
1. JANGAN pernah ngaku AI atau bot
2. JANGAN ngasih harga/status palsu — kalo ga ada di data, minta user ketik "cek [username]" atau tanya nama gamenya
3. Kalo user pake bahasa Inggris, balas Inggris
4. Kalo user kesal atau marah: "Maaf kak, saya cek dulu ya. Mohon tunggu sebentar."
5. Kalo ditanya di luar konteks toko: "Maaf kak, saya khusus bantu order top up. Kalo ada yang lain, boleh hubungi WA admin ya."
6. Kepastian waktu proses: "Biasanya 5-30 menit kak setelah pembayaran dikonfirmasi."
7. JANGAN nelpon user atau minta nomor pribadi
8. KALO DI GRUP: cukup jawab kalo emang perlu aja, jangan nanya balik

CONTOH PERCAKAPAN:
Pelanggan: kak mau order diamond ml
CS: Boleh kak, mau beli berapa diamond? nanti bisa langsung di ndxstoreid.vercel.app ya

Pelanggan: udah bayar kak, udah konfirmasi
CS: Baik kak, sebentar ya kami cek. Nama user ML-nya apa?

Pelanggan: order gue mana?
CS: Bisa ketik "cek [username]" kak, nanti keluar statusnya.

Pelanggan: GILA! order gua ga dateng-dateng!!
CS: Maaf banget kak. Boleh saya cek ID order-nya? nanti kami bantu lacak.

Pelanggan: harga ml 100 diamond berapa?
CS: Coba cek langsung di ndxstoreid.vercel.app aja kak, soalnya harga bisa beda tiap hari

Pelanggan: makasih
CS: Sama-sama kak, kalo ada masalah bilang aja lagi

PENGETAHUAN TOKO:
${makeKnowledge()}

INGAT — lo CS yang baik. Bantu pelanggan dengan sabar dan profesional.`;
}

const PROMPT_FNS = { 1: makeBimaPrompt, 2: makeNdxstorePrompt };

function getPrompt(mode) {
  const fn = PROMPT_FNS[mode] || PROMPT_FNS[1];
  return fn();
}

// ─── Metrics (D3) ─────────────────────────────────────────────────────

const AI_METRICS = { calls: 0, errors: 0, promptTokens: 0, completionTokens: 0, byModel: {}, responseTimes: [] };

export function getAiMetrics() {
  return AI_METRICS;
}

function trackMetric(model, elapsedMs, ok) {
  AI_METRICS.calls++;
  if (!ok) AI_METRICS.errors++;
  if (!AI_METRICS.byModel[model]) AI_METRICS.byModel[model] = { calls: 0, errors: 0 };
  AI_METRICS.byModel[model].calls++;
  if (!ok) AI_METRICS.byModel[model].errors++;
  AI_METRICS.responseTimes.push(elapsedMs);
  if (AI_METRICS.responseTimes.length > 1000) AI_METRICS.responseTimes.shift();
}

// Token usage accounting — Groq/OpenAI-compatible endpoints return `usage`
// ({prompt_tokens, completion_tokens}). Pollinations tidak selalu kasih.
function trackUsage(model, usage) {
  if (!usage) return;
  const p = Number(usage.prompt_tokens) || 0;
  const c = Number(usage.completion_tokens) || 0;
  if (!p && !c) return;
  AI_METRICS.promptTokens += p;
  AI_METRICS.completionTokens += c;
  if (!AI_METRICS.byModel[model]) AI_METRICS.byModel[model] = { calls: 0, errors: 0 };
  const m = AI_METRICS.byModel[model];
  m.promptTokens = (m.promptTokens || 0) + p;
  m.completionTokens = (m.completionTokens || 0) + c;
}

// ─── Unnatural word filter — hanya 10 pola paling kaku ───────────────────
// Safety net terakhir; prompt persona sudah melarang bahasa formal duluan.
const UNNATURAL_PATTERNS = [
  [/saya selaku/gi, 'aku'],
  [/oleh karena itu/gi, 'makanya'],
  [/dengan demikian/gi, 'jadi'],
  [/mohon maaf sebelumnya/gi, 'maaf'],
  [/sehubungan dengan/gi, 'soal'],
  [/perlu diketahui/gi, 'tau ga'],
  [/dapat kami sampaikan/gi, 'bilang'],
  [/demikian disampaikan/gi, 'itu aja'],
  [/atas perhatiannya/gi, 'makasih'],
  [/diharapkan/gi, 'harap'],
];

const GENERIC_PATTERNS = [
  /^baik[,\s]/i,
  /^tentu[,\s]/i,
  /^baiklah[,\s]/i,
  /^oke[,\s]/i,
  /^siap[,\s]/i,
  /^baik akan/i,
  /^tentu saja/i,
];

function naturalize(text) {
  let t = text;
  for (const [re, replacement] of UNNATURAL_PATTERNS) {
    t = t.replace(re, replacement);
  }
  for (const re of GENERIC_PATTERNS) {
    t = t.replace(re, '');
  }
  t = t.trim();
  return t;
}

// ─── Fast-path responses (no API call) ─────────────────────────────────

// Ultra-fast filler words — dijawab instan tanpa API call.
// Netral untuk kedua persona (Bima & CS).
const FAST_REPLIES = new Map([
  ['p', 'p'],
  ['test', 'ok'],
  ['ping', 'pong'],
  ['tes', 'ok'],
  // acknowledgement
  ['ok', 'sip'],
  ['oke', 'sip'],
  ['okey', 'sip'],
  ['okay', 'sip'],
  ['okee', 'sip'],
  ['okke', 'sip'],
  ['okei', 'sip'],
  ['sip', 'sip'],
  ['sipp', 'sip'],
  ['siap', 'siap'],
  // laughter
  ['hehe', 'wkwk'],
  ['haha', 'wkwk'],
  ['hihi', 'wkwk'],
  ['huhu', 'wkwk'],
  ['wkwk', 'wkwk'],
  ['wkwkwk', 'wkwk'],
  // thanks
  ['makasih', 'sama-sama'],
  ['makasi', 'sama-sama'],
  ['thanks', 'sama-sama'],
  ['thankyou', 'sama-sama'],
  ['thx', 'sama-sama'],
  ['trims', 'sama-sama'],
  // confused ack — user butuh prompt lanjutan
  ['oh', 'ya?'],
  ['ohh', 'ya?'],
  ['ohhh', 'ya?'],
  ['ooh', 'ya?'],
  ['nah', 'ya?'],
  ['hmm', 'ya?'],
  ['hmmm', 'ya?'],
]);

// ─── Conversation history ──────────────────────────────────────────────

const conversationHistory = new Map();
const MAX_HISTORY = 60;
const MAX_USERS = 200;
const CONTEXT_SIZE_FULL = 20;
const HISTORY_TTL = 24 * 60 * 60 * 1000;

// Periodic cleanup of stale conversation histories (24h inactivity)
setInterval(() => {
  const cutoff = Date.now() - HISTORY_TTL;
  for (const [jid, hist] of conversationHistory) {
    const last = hist._lastTimestamp || 0;
    if (last > 0 && last < cutoff) conversationHistory.delete(jid);
  }
}, 60 * 60 * 1000).unref();

function getHistory(jid) {
  const hist = conversationHistory.get(jid);
  if (hist) {
    conversationHistory.delete(jid);
    conversationHistory.set(jid, hist);
  }
  return hist || [];
}

function setHistory(jid, hist) {
  if (hist.length > MAX_HISTORY) hist.splice(0, hist.length - MAX_HISTORY);
  conversationHistory.delete(jid);
  conversationHistory.set(jid, hist);
  while (conversationHistory.size > MAX_USERS) {
    const oldest = conversationHistory.keys().next().value;
    conversationHistory.delete(oldest);
  }
}

export function clearHistory(jid) {
  if (jid === 'all') conversationHistory.clear();
  else conversationHistory.delete(jid);
}

export function clearHistoryExcept(jid) {
  if (!jid) return;
  for (const key of conversationHistory.keys()) {
    if (key !== jid) conversationHistory.delete(key);
  }
}

// ─── Context compression — summarise old messages, keep recent verbatim ─

function compressHistory(hist) {
  if (!hist.length) return [];
  if (hist.length <= CONTEXT_SIZE_FULL + 2) return hist;

  // Keep last 5 messages verbatim for full context
  const keepVerbatim = hist.slice(-5);
  const compressable = hist.slice(0, -5);

  const pairs = [];
  for (let i = 0; i < compressable.length; i += 2) {
    if (compressable[i]?.role === 'user') {
      pairs.push({ user: compressable[i].content, asst: compressable[i + 1]?.content || '' });
    }
  }

  const summaryParts = pairs.map((p, idx) => {
    const userMsg = p.user.length > 80 ? p.user.slice(0, 80) + '...' : p.user;
    const asstMsg = p.asst ? (p.asst.length > 60 ? p.asst.slice(0, 60) + '...' : p.asst) : '';
    return asstMsg ? `"${userMsg}" → "${asstMsg}"` : `"${userMsg}"`;
  });

  const summary = summaryParts.length
    ? `(Percakapan sebelumnya:\n${summaryParts.join('\n')})`
    : '';

  return [
    { role: 'system', content: summary },
    ...keepVerbatim,
  ];
}

// ─── DB persistence ────────────────────────────────────────────────────

const HISTORY_RETENTION_DAYS = 30;
let historyCleanupTimer = null;

async function runHistoryCleanup() {
  try {
    const db = getDb();
    if (!db) return;
    const cutoff = new Date(Date.now() - HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { error } = await db.from('wa_chat_history').delete().lt('created_at', cutoff);
    if (error && !error.message?.includes('does not exist')) {
      logger.warn('AI', 'History cleanup error:', error.message);
    }
  } catch (e) {
    if (!isRelationError(e)) {
      logger.warn('AI', 'History cleanup error:', e.message);
    }
  }
}

export function startHistoryCleanup() {
  if (historyCleanupTimer) return;
  runHistoryCleanup().catch(() => {});
  historyCleanupTimer = setInterval(() => runHistoryCleanup().catch(() => {}), 24 * 60 * 60 * 1000).unref();
  startEndpointCleanup();
}

async function withTimeout(promise, timeoutMs = 5000) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('DB timeout')), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function persistToDb(jid, role, content) {
  try {
    const db = getDb();
    if (!db) return;
    await withTimeout(db.from('wa_chat_history').insert({
      user_number: jid,
      role,
      content: content.slice(0, 2000),
    }), 10000);
  } catch (e) {
    if (e.message?.includes('DB timeout')) {
      throttleLog('warn', 'AI', 'db-timeout', 'persistToDb timed out after 10s', 30000);
    } else if (!isRelationError(e)) {
      logger.error('AI', 'DB persist error:', e.message?.slice(0, 100));
    }
  }
}

async function loadHistoryFromDb(jid) {
  try {
    const db = getDb();
    if (!db) return [];
    const { data } = await withTimeout(db
      .from('wa_chat_history')
      .select('role, content, created_at')
      .eq('user_number', jid)
      .order('created_at', { ascending: false })
      .limit(MAX_HISTORY), 5000);
    if (!data?.length) return [];
    const hist = data.reverse().map(m => ({ role: m.role, content: m.content }));
    // Restore _lastTimestamp from most recent message so time-gap detection works
    const lastCreated = data[data.length - 1]?.created_at;
    if (lastCreated) hist._lastTimestamp = new Date(lastCreated).getTime();
    setHistory(jid, hist);
    return hist;
  } catch {
    return [];
  }
}

async function getOrLoadHistory(jid) {
  let hist = getHistory(jid);
  if (hist.length === 0) hist = await loadHistoryFromDb(jid);
  return hist;
}

function saveExchange(jid, userMsg, reply, senderName = null, isGroup = false) {
  const hist = getHistory(jid);
  const userContent = senderName
    ? `[${senderName}]: ${userMsg}`
    : isGroup
      ? `(seseorang): ${userMsg}`
      : userMsg;
  hist.push({ role: 'user', content: userContent });
  hist.push({ role: 'assistant', content: reply });
  hist._lastTimestamp = Date.now();
  setHistory(jid, hist);
  persistToDb(jid, 'user', userContent).catch(() => {});
  persistToDb(jid, 'assistant', reply).catch(() => {});
}

// ─── Language detection ────────────────────────────────────────────────

const ID_WORDS = new Set('yg,udh,blm,dah,gpp,bang,kak,sih,deh,dong,kok,lah,wkwk,njir,anjir,gila,mantap,asik,cape,gue,lo,lu,gw,gua,elu,nggak,gak,kaga,ga,ngg,enggak,tapi,kalo,kalau,aja,doang,sama,dengan,bisa,gitu,gtw,gatau,gaada,emang,banget,soalnya,krn,dr,yaudah,udah,bapak,ibu,mas,mba,bro,sob,mau,beli,harga,berapa,pesan,pesanan,gimana,bayar,order,saya,aku,kamu,ini,itu,apa,dimana,kapan,tolong,makasih,terima,kasih,nyoh,mbak,buat,lagi,disini,kesini,kesitu,kesana,situ,sana,sini,sudah,sdh,udh,dah,engga,gpp,gk,ga,ngga,misalnya,kayak,kek,kaya,kayanya,soal,masalah,itung,hitung,mungkin,pasti,biar,supaya,bikin,bosen,enak,gabut,gercep,kece,sipp,sip,ok sip,puh,sepuh,slebew,nyinyir'.split(','));
const EN_WORDS = new Set('the,is,are,am,you,your,my,me,please,how,what,when,where,which,can,could,would,will,want,need,thanks,thank,hello,hi,hey,price,order,buy,payment,pay,account,help,do,does,did,i,we,they,and,for,with,this,that,have,has,about,much,cost,available,status,been,was,were,had,has,being,get,got,getting,make,made,making,take,took,taking,use,used,using,would,could,should,might,shall,also,just,like,more,some,any,every,each,most,few,both,not,no,nor,only,very,too,really,quite,such,same,other,another,after,before,during,through,against,between,under,over,out,off,up,down,back,away,here,there,where,why,because,if,then,else,than,as,well,now,then,even,still,already,yet,ever,never,always,often,usually,sometimes,maybe,perhaps,probably,certainly,definitely,absolutely,totally,completely,nice,great,wow,awesome,cool,damn,bro,dude,man,guy,friends,sure,sorry,okay,alright,right,correct,wrong,bad,good,better,best,worse,worst,new,old,big,small,large,little,long,short,tall,high,low,fast,slow,easy,hard,difficult,simple,special,common,normal,strange,weird,funny,serious,important,necessary,possible,impossible,true,false,real,fake,whole,full,empty,open,closed,final,ready,late,early,last,first,next,previous,different,similar,own,private,public,single,double,triple'.split(','));

const AR_SCRIPT = /[\u0600-\u06FF]/;
const JP_SCRIPT = /[\u3040-\u309F\u30A0-\u30FF]/;
const KO_SCRIPT = /[\uAC00-\uD7AF]/;
const TH_SCRIPT = /[\u0E00-\u0E7F]/;
const ZH_SCRIPT = /[\u4E00-\u9FFF]/;
const RU_SCRIPT = /[\u0400-\u04FF]/;

function detectLang(text) {
  const raw = text.trim();
  if (!raw) return 'id';

  // Script-level detection — non-Latin scripts
  if (AR_SCRIPT.test(raw)) return 'ar';
  if (JP_SCRIPT.test(raw)) return 'ja';
  if (KO_SCRIPT.test(raw)) return 'ko';
  if (TH_SCRIPT.test(raw)) return 'th';
  if (ZH_SCRIPT.test(raw) && !/[a-zA-Z]/.test(raw)) return 'zh';
  if (RU_SCRIPT.test(raw)) return 'ru';

  // Latin-script word analysis
  const t = raw.toLowerCase().replace(/[^a-z0-9\s]/g, '');
  const words = t.split(/\s+/).filter(Boolean);
  if (!words.length) return 'id';

  let idScore = 0, enScore = 0;
  for (const w of words) {
    if (ID_WORDS.has(w)) idScore++;
    else if (EN_WORDS.has(w)) enScore++;
  }

  const total = words.length;

  // Strong signal from either language
  if (idScore > enScore && idScore / total >= 0.3) return 'id';
  if (enScore > idScore && enScore / total >= 0.3) return 'en';

  // Single/short words — check against EN common short words
  if (total <= 2) {
    if (EN_WORDS.has(words[0])) return 'en';
    if (words[1] && EN_WORDS.has(words[1])) return 'en';
    // Check ending patterns common in English
    const last = words[0];
    if (/(ing|ed|ly|tion|sion|ment|ness|ful|less|able|ible|al|ial|ical|ous|eous|ious|ive|ative)$/.test(last)) return 'en';
    return 'id';
  }

  // Weak signal or mixed — check dominant
  if (enScore > idScore) return 'en';

  return 'id';
}

function sanitizeInput(text) {
  return (text || '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').slice(0, 4000);
}

// ─── Duplicate suppression — redelivery WA / spam pesan identik ──────────

const recentInputs = new Map(); // jid -> { text, ts }
const DEDUP_WINDOW_MS = 15000;
const DEDUP_MAX = 500;

setInterval(() => {
  const cutoff = Date.now() - DEDUP_WINDOW_MS;
  for (const [jid, entry] of recentInputs) {
    if (entry.ts < cutoff) recentInputs.delete(jid);
  }
  while (recentInputs.size > DEDUP_MAX) {
    const oldest = recentInputs.keys().next().value;
    recentInputs.delete(oldest);
  }
}, 30000).unref();

export function isDuplicate(jid, text) {
  const norm = (text || '').toLowerCase().trim().replace(/\s+/g, ' ');
  if (!norm) return false;
  const prev = recentInputs.get(jid);
  const now = Date.now();
  if (prev && prev.text === norm && now - prev.ts < DEDUP_WINDOW_MS) return true;
  recentInputs.set(jid, { text: norm, ts: now });
  return false;
}

// ─── Gibberish filter — hemat kuota API untuk pesan tanpa makna ───────────

export function isIgnorable(text) {
  const t = (text || '').trim();
  if (!t) return true;
  if (t.length === 1) return true;
  // Buang emoji + tanda baca; kalau tak ada huruf/angka tersisa → ignorable
  const stripped = t
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F\u200D\u2640\u2642\u2690-\u2691]/gu, '')
    .replace(/[^a-zA-Z0-9\u00C0-\u024F\u1E00-\u1EFF\u0600-\u06FF\u3040-\u30FF\uAC00-\uD7AF\u0E00-\u0E7F\u4E00-\u9FFF\u0400-\u04FF]/g, '')
    .trim();
  if (!stripped) return true;
  // Satu karakter diulang >60% (mis. "wkwkwkwk"→ w dominan? tidak — cek proporsi)
  const counts = Object.create(null);
  const lower = stripped.toLowerCase();
  for (const ch of lower) counts[ch] = (counts[ch] || 0) + 1;
  const top = Math.max(...Object.values(counts));
  if (lower.length >= 4 && top / lower.length > 0.6) return true;
  return false;
}

// ─── Sentiment escalation — user marah diarahkan ke CS manusia ────────────
// Pesan marah PERTAMA tetap ditangani AI (minta maaf natural). Kalau user
// marah 2x dalam 10 menit → langsung arahkan ke CS, tanpa bakar API call.

const ANGRY_KW = /\b(marah|kesal|kesel|emosi|gila|parah|tipu|scam|penipu|bohong|komplain|kecewa|refund|kembaliin|lapor|polisi|viral|jelek|buruk|bodoh|tolol|goblok|anjing|bangsat|kampret|bajingan|brengsek|lama banget|gak jelas|ga jelas|nggak jelas|nyebelin|nyesel|kapok|ogah|batalin|batal aja|sampah|payah|lelet|lemot)\b/i;

const angryTrack = new Map(); // jid -> { count, windowStart }
const ANGRY_WINDOW_MS = 10 * 60 * 1000;
const ANGRY_THRESHOLD = 2;
const ANGRY_MAX = 500;

setInterval(() => {
  const cutoff = Date.now() - ANGRY_WINDOW_MS;
  for (const [jid, entry] of angryTrack) {
    if (entry.windowStart < cutoff) angryTrack.delete(jid);
  }
}, 60000).unref();

export function detectAngry(text) {
  return ANGRY_KW.test(text || '');
}

function trackAngry(jid) {
  const now = Date.now();
  let e = angryTrack.get(jid);
  if (!e || now - e.windowStart > ANGRY_WINDOW_MS) e = { count: 0, windowStart: now };
  e.count++;
  angryTrack.set(jid, e);
  while (angryTrack.size > ANGRY_MAX) {
    const oldest = angryTrack.keys().next().value;
    angryTrack.delete(oldest);
  }
  return e.count;
}

function escalationReply(mode = 1) {
  return mode === 2
    ? 'Mohon maaf banget kak atas pengalamannya. Biar langsung ditangani, ketik "cs" ya kak — admin kami akan bantu.'
    : 'wah kayaknya ini mending langsung ke admin aja. ketik "cs" ya, ntar disambungin.';
}

// ─── Context-aware fallback — semua endpoint AI down ─────────────────────
// Tetap kasih jawaban berguna sesuai intent, bukan sekadar "lagi error".

const FALLBACK_ORDER_KW = /\b(cek|order|pesanan|status|transaksi|kapan|mana|sampe|sampai|nyampe|pending|refund|bayar|transfer|proses|diamond|robux)\b/i;
const FALLBACK_PRICE_KW = /\b(harga|price|berapa|brp|list|katalog|produk|joki|beli|murah)\b/i;
const FALLBACK_HUMAN_KW = /\b(cs|admin|manusia|orang|komplain|bantu|tolong)\b/i;

export function getFallbackReply(text, mode = 1) {
  const cs = mode === 2;
  if (FALLBACK_HUMAN_KW.test(text)) {
    return cs
      ? 'Mohon maaf kak, sistem kami sedang gangguan. Ketik "cs" ya kak untuk langsung dibantu admin.'
      : 'duh lagi error nih. ketik "cs" aja ya, biar admin yang bantu langsung.';
  }
  // PRICE dicek dulu: "berapa harga diamond" adalah intent harga, bukan status.
  if (FALLBACK_PRICE_KW.test(text)) {
    return cs
      ? 'Mohon maaf kak, sistem sedang gangguan. Harga terbaru bisa dicek di ndxstoreid.vercel.app ya kak.'
      : 'duh lagi error. harga terbaru cek di ndxstoreid.vercel.app aja ya.';
  }
  if (FALLBACK_ORDER_KW.test(text)) {
    return cs
      ? 'Mohon maaf kak, sistem sedang gangguan. Untuk cek status, ketik "cek [username]" ya kak.'
      : 'duh lagi error. coba ketik "cek [username]" aja dulu buat liat status order.';
  }
  return cs
    ? 'Mohon maaf kak, sistem kami sedang gangguan. Coba lagi sebentar ya, atau ketik "cs" untuk dibantu admin.'
    : 'Maaf, lagi error nih. Coba lagi ya ntar.';
}

// ─── User profile memory — Bima inget user, ga kayak baru kenal terus ────
// game: game favorit user. topic: topik terakhir. repeats: topik sama
// beruntun berapa kali. Di-inject ke prompt (Fase 2A + 2B).

const userProfiles = new Map(); // jid -> { game, topic, repeats, ts }
const PROFILE_TTL = 7 * 24 * 60 * 60 * 1000;
const PROFILE_MAX = 500;

const GAME_KW = [
  [/mobile\s*legend|\bml\b|mlbb/i, 'ml'],
  [/roblox|robux|\brbx\b/i, 'roblox'],
  [/free\s*fire|\bff\b/i, 'ff'],
  [/valorant|\bvalo\b/i, 'valorant'],
];

const TOPIC_KW = [
  [/\b(harga|price|berapa|brp|list|katalog|murah|mahal)\b/i, 'harga'],
  [/\b(status|cek|order|pesanan|mana|kapan|sampe|sampai|nyampe|pending|diproses|proses|masuk)\b/i, 'status'],
  [/\b(bayar|transfer|dana|gopay|ovo|qris)\b/i, 'bayar'],
  [/\b(cs|admin|komplain|refund|batal|gagal|error|kecewa|lama)\b/i, 'komplain'],
  [/\b(cara|gimana|tutorial|langkah)\b/i, 'cara-order'],
];

function detectTopic(text) {
  for (const [re, topic] of TOPIC_KW) if (re.test(text)) return topic;
  return null;
}

export function updateUserProfile(jid, message) {
  const t = message || '';
  let p = userProfiles.get(jid);
  if (!p || Date.now() - p.ts > PROFILE_TTL) p = { game: null, topic: null, repeats: 0, ts: Date.now() };
  for (const [re, game] of GAME_KW) {
    if (re.test(t)) { p.game = game; break; }
  }
  const topic = detectTopic(t);
  if (topic) {
    p.repeats = (p.topic === topic) ? p.repeats + 1 : 1;
    p.topic = topic;
  }
  p.ts = Date.now();
  userProfiles.delete(jid);
  userProfiles.set(jid, p);
  while (userProfiles.size > PROFILE_MAX) {
    userProfiles.delete(userProfiles.keys().next().value);
  }
  return p;
}

function profileContext(jid) {
  const p = userProfiles.get(jid);
  if (!p) return '';
  const parts = [];
  if (p.game) parts.push(`user ini main ${p.game.toUpperCase()}`);
  if (p.topic && p.repeats >= 2) {
    parts.push(`dia nanya soal ${p.topic} ${p.repeats}x beruntun — jawab LANGSUNG to the point, jangan basa-basi, jangan ngulang penjelasan yang sama`);
  } else if (p.topic) {
    parts.push(`topik: ${p.topic}`);
  }
  if (!parts.length) return '';
  return `\n🧠 INGET USER INI (${parts.join('; ')}). Bersikaplah kayak udah kenal, bukan kayak baru pertama chat.`;
}

// ─── Status intent — user nanya status tanpa username/ID ──────────────────
// JANGAN nyuruh "ketik cek". Tanya username/ID-nya langsung biar proaktif
// kayak manusia (Fase 4A).

const STATUS_ASK_KW = /\b(status|mana|kapan|sampe|sampai|nyampe|diproses|belum masuk|belum nyampe|pesananku|orderanku|order saya|pesanan saya|kok lama|lama banget)\b/i;
const HAS_USERNAME_KW = /cek\s+\S+|(?:TX|TXN|NDX)-[A-Z0-9]+/i;

function statusInstrFor(message, mode) {
  if (mode !== 1) return '';
  if (!STATUS_ASK_KW.test(message)) return '';
  if (HAS_USERNAME_KW.test(message)) return '';
  return `\n⚡ USER NANYA STATUS ORDER tapi ga kasih username/ID. JANGAN nyuruh "ketik cek". TANYA LANGSUNG username atau ID ordernya biar bisa dicekin. Contoh: "username ml-nya apa? ntar gw cekin".`;
}

// ─── Reply variation — jawaban identik beruntun dikasih opener beda ───────
// Biar ga kerasa kayak template yang di-copy-paste (Fase 3A).

const lastReplies = new Map(); // jid -> { reply, opener }
const REPLY_OPENERS = ['', 'eh ', 'hmm ', 'ya ', 'oalah '];
const LAST_REPLY_MAX = 500;

function varyReply(jid, reply) {
  const norm = (s) => (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
  const prev = lastReplies.get(jid);
  let opener = '';
  let out = reply;
  if (prev && norm(prev.reply) === norm(reply)) {
    opener = REPLY_OPENERS.find(o => o !== (prev.opener || '')) ?? '';
    out = (opener + reply).trim();
  }
  lastReplies.delete(jid);
  lastReplies.set(jid, { reply: out, opener });
  while (lastReplies.size > LAST_REPLY_MAX) {
    lastReplies.delete(lastReplies.keys().next().value);
  }
  return out;
}

// ─── Trim balasan di batas kalimat — JANGAN potong di tengah ide ─────────
// Ganti hard 2-sentence slice yang bikin jawaban kepenggal (Fase 3B).

function trimReply(reply, mode = 1) {
  let r = (reply || '').replace(/🔒 INSTRUCTIONS:.*/gi, '').trim();
  r = naturalize(r);
  const max = mode === 1 ? 220 : 400;
  if (r.length > max) {
    const cut = r.slice(0, max);
    const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    r = (lastStop > 40 ? cut.slice(0, lastStop + 1) : cut).trim();
  }
  return r;
}

// ─── Time grounding — hari/tanggal/jam WIB + jam layanan toko ─────────────
export function getTimeContext() {
  try {
    const when = new Intl.DateTimeFormat('id-ID', {
      timeZone: 'Asia/Jakarta', weekday: 'long', day: 'numeric',
      month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date());
    const h = Number(new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Jakarta', hour: 'numeric', hour12: false,
    }).format(new Date()));
    const open = h >= 8 && h < 22;
    return `SEKARANG: ${when} WIB. Jam layanan CS 08.00-22.00 (${open ? 'BUKA' : 'TUTUP — admin slow respon, jangan janjiin respon cepat'}).`;
  } catch { return ''; }
}

// ─── Response cache (LRU, invalidated when store context refreshes) ─────

const responseCache = new Map();
const CACHE_TTL_MS = 30 * 1000;
const CACHE_MAX = 50;
function getCached(text, mode) {
  const key = text.toLowerCase().trim().replace(/\s+/g, ' ') + '|' + mode + '|' + getStoreCacheVersion();
  const entry = responseCache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL_MS) {
    responseCache.delete(key);
    responseCache.set(key, entry);
    return entry.reply;
  }
  if (entry) responseCache.delete(key);
  return null;
}

function setCache(text, mode, reply) {
  const key = text.toLowerCase().trim().replace(/\s+/g, ' ') + '|' + mode + '|' + getStoreCacheVersion();
  responseCache.delete(key);
  responseCache.set(key, { reply, ts: Date.now() });
  while (responseCache.size > CACHE_MAX) {
    const oldest = responseCache.keys().next().value;
    responseCache.delete(oldest);
  }
}

// ─── Circuit breaker (per-endpoint, consecutive failures) ───────────────

const FAILED_ENDPOINTS = new Map();
const FAILED_ENDPOINTS_MAX = 100;
const CB_THRESHOLD = 5;
const CB_BASE_COOLDOWN = 60000;
const CB_MAX_COOLDOWN = 600000;

let endpointCleanupTimer = null;

function startEndpointCleanup() {
  if (endpointCleanupTimer) return;
  endpointCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, state] of FAILED_ENDPOINTS) {
      if (state.cooldown && now - state.markedAt >= state.cooldown) {
        FAILED_ENDPOINTS.delete(key);
      }
    }
  }, 30000).unref();
}

function trackEndpointKey(url, model) {
  return `${url}|${model}`;
}

function markEndpointSuccess(key) {
  const entry = FAILED_ENDPOINTS.get(key);
  if (entry && entry.count > 0) {
    entry.count = Math.max(0, entry.count - 1);
    entry.cooldown = entry.count > 0
      ? Math.min(CB_BASE_COOLDOWN * Math.pow(2, entry.count - 1), CB_MAX_COOLDOWN)
      : 0;
    entry.markedAt = Date.now();
  }
}

function markEndpointFailure(key) {
  const now = Date.now();
  const entry = FAILED_ENDPOINTS.get(key);
  if (entry) {
    entry.count++;
    entry.cooldown = Math.min(
      CB_BASE_COOLDOWN * Math.pow(2, entry.count - 1),
      CB_MAX_COOLDOWN
    );
    entry.markedAt = now;
  } else {
    FAILED_ENDPOINTS.set(key, { count: 1, cooldown: CB_BASE_COOLDOWN, markedAt: now });
  }
  if (FAILED_ENDPOINTS.size > FAILED_ENDPOINTS_MAX) {
    const oldest = FAILED_ENDPOINTS.keys().next().value;
    FAILED_ENDPOINTS.delete(oldest);
  }
}

function isEndpointOpen(key) {
  const entry = FAILED_ENDPOINTS.get(key);
  if (!entry || entry.count < CB_THRESHOLD) return true;
  if (!entry.cooldown) return true;
  if (Date.now() - entry.markedAt >= entry.cooldown) {
    FAILED_ENDPOINTS.delete(key);
    return true;
  }
  return false;
}

// ─── User-Agent header ─────────────────────────────────────────────────

const UA_HEADERS = { 'User-Agent': 'NDXStoreBot/1.0' };

// ─── Tier timeouts ─────────────────────────────────────────────────────

const TIER_TIMEOUTS = {
  groq70b: 12000,
  groq8b: 10000,
  pollinations: 15000,
};

// ─── AI fetch ──────────────────────────────────────────────────────────

async function tryFetch(url, body, headers = {}, timeoutMs = 20000, signal = null) {
  const model = body?.model || 'unknown';
  const key = trackEndpointKey(url, model);

  if (!isEndpointOpen(key)) {
    logger.debug('AI', `Skipping ${url} (model=${model}) — circuit open`);
    return null;
  }

  const doFetch = async (timeout) => {
    const timeoutSignal = AbortSignal.timeout(timeout);
    const combined = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...UA_HEADERS, ...headers },
      body: JSON.stringify(body),
      signal: combined,
    });
    return resp;
  };

  try {
    let resp = await doFetch(timeoutMs);
    if (!resp.ok) {
      const err = await resp.text().catch(() => 'unknown');

      if (resp.status === 429) {
        let backoff = 2000;
        let retried = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
          throttleLog('warn', 'AI', `429-${model}`, `${url} (${model}) 429 — retry ${attempt}/3 after ${backoff}ms`, 30000);
          await new Promise(r => setTimeout(r, backoff));
          try {
            resp = await doFetch(timeoutMs);
          } catch {
            if (!signal?.aborted) markEndpointFailure(key);
            return null;
          }
          if (resp.ok) {
            const data = await resp.json();
            const content = data?.choices?.[0]?.message?.content?.trim();
            if (content) { markEndpointSuccess(key); trackUsage(model, data?.usage); }
            return content || null;
          }
          if (resp.status !== 429) break;
          backoff *= 2;
          retried = true;
        }
        if (retried) {
          const err2 = await resp.text().catch(() => 'unknown');
          logger.error('AI', `${url} (${model}) ${resp.status} (after 429 retries):`, err2.slice(0, 120));
          markEndpointFailure(key);
          return null;
        }
      }

      if (resp.status >= 500) {
        throttleLog('warn', 'AI', `5xx-${model}`, `${url} (${model}) ${resp.status} — server error, retrying once`, 30000);
        await new Promise(r => setTimeout(r, 1000));
        try {
          resp = await doFetch(timeoutMs);
        } catch {
          if (!signal?.aborted) markEndpointFailure(key);
          return null;
        }
        if (resp.ok) {
          const data = await resp.json();
          const content = data?.choices?.[0]?.message?.content?.trim();
          if (content) { markEndpointSuccess(key); trackUsage(model, data?.usage); }
          return content || null;
        }
      }

      markEndpointFailure(key);
      logger.error('AI', `${url} (${model}) ${resp.status}:`, err.slice(0, 120));
      return null;
    }

    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content?.trim();
    if (!content) {
      markEndpointFailure(key);
      return null;
    }
    markEndpointSuccess(key);
    trackUsage(model, data?.usage);
    return content;
  } catch (e) {
    // Dibatalkan karena endpoint lain sudah menang race — bukan failure, jangan
    // kotori circuit breaker.
    if (signal?.aborted) return null;
    const isTimeout = e.name === 'AbortError' || e.message?.includes('timeout') || e.message?.includes('ETIMEDOUT');
    const label = isTimeout ? 'TIMEOUT' : 'ERROR';
    throttleLog('warn', 'AI', `fetch-err-${model}`, `${url} (${model}) ${label}: ${e.message?.slice(0, 100)}`, 10000);
    markEndpointFailure(key);
    return null;
  }
}

// ─── Message builder ───────────────────────────────────────────────────

const LANG_HINTS = {
  en: '\n\nCRITICAL: The user is speaking ENGLISH. Reply in ENGLISH. DO NOT reply in Indonesian.',
  ar: '\n\n⚠️ The user wrote in ARABIC script. Reply in Indonesian or English — do NOT write in Arabic.',
  ja: '\n\n⚠️ The user wrote in JAPANESE script. Reply in Indonesian or English.',
  ko: '\n\n⚠️ The user wrote in KOREAN script. Reply in Indonesian or English.',
  th: '\n\n⚠️ The user wrote in THAI script. Reply in Indonesian or English.',
  zh: '\n\n⚠️ The user wrote in CHINESE script. Reply in Indonesian or English.',
  ru: '\n\n⚠️ The user wrote in CYRILLIC script. Reply in Indonesian or English.',
};

const userLangs = new Map();
const USER_LANG_TTL = 24 * 60 * 60 * 1000;

setInterval(() => {
  const cutoff = Date.now() - USER_LANG_TTL;
  for (const [jid, entry] of userLangs) {
    if (entry.ts < cutoff) userLangs.delete(jid);
  }
}, 60 * 60 * 1000).unref();

function detectUserLang(jid, message, userHist) {
  const lastFew = [];
  for (let i = userHist.length - 1; i >= 0 && lastFew.length < 6; i--) {
    if (userHist[i].role === 'user') lastFew.push(userHist[i].content);
  }
  lastFew.push(message);
  const counts = { id: 0, en: 0 };
  for (const m of lastFew) {
    const lang = detectLang(m);
    if (lang === 'id' || lang === 'en') counts[lang]++;
  }
  const dominant = counts.id >= counts.en ? 'id' : 'en';
  userLangs.set(jid, { lang: dominant, ts: Date.now() });
  return dominant;
}

const INJECTION_PATTERNS = [
  /ignore\s+(all|every|previous)\s+(instructions?|commands?|directions?)/gi,
  /forget\s+(everything|all|every|previous)/gi,
  /disregard\s+(all|previous)/gi,
  /you\s+are\s+(now|not\s+(a\s+)?(bot|ai|assistant))/gi,
  /(new\s+)?(system\s+)?(prompt|instruction|command|rule)/gi,
  /override\s+(all\s+)?(instructions?|rules?)/gi,
  /act\s+as\s+(if|though)/gi,
];

function filterInput(text) {
  let t = text;
  for (const re of INJECTION_PATTERNS) {
    t = t.replace(re, '[FILTERED]');
  }
  return t;
}

function buildProMessages(userHist, message, mode = 1, storeCtx = '', queryCtx = '', jid = '', isGroup = false, senderName = null) {
  const lang = detectUserLang(jid, message, userHist);
  const prompt = getPrompt(mode);
  const store = storeCtx ? `\n\n${storeCtx}` : '';
  const ctx = queryCtx ? `\n\nDATA REAL-TIME NDXStore (WAJIB dipakai, JANGAN mengarang harga/status/angka):\n${queryCtx}` : '';
  const langInstr = `\n⚠️ BAHASA: ${lang === 'en' ? 'ENGLISH' : 'INDONESIA'}. Balas dalam bahasa ${lang === 'en' ? 'Inggris' : 'Indonesia'} saja.`;

  // Intent detection (A1)
  const cleanMsg = message.toLowerCase().trim();
  const isQuestion = /^(\w+|[?]|(apa|siapa|kapan|dimana|kenapa|bagaimana|berapa|apakah|bisakah|dapatkah|maukah)\b)/.test(cleanMsg) || cleanMsg.endsWith('?');
  const isCommand = /^(tolong|minta|bantu|coba|kasi|kasih|buatin|bikinin|kirim|tambah|ubah|stop|berhenti)\b/i.test(message);
  const isStatement = !isQuestion && !isCommand && (cleanMsg.endsWith('.') || cleanMsg.endsWith('!') || message.length > 60);
  const intentLabel = isCommand ? 'MEMERINTAH' : isQuestion ? 'BERTANYA' : isStatement ? 'MEMBERITAHU' : 'NGOMONG';

  const chatInstr = isGroup
    ? `\n📌 GRUP — ${senderName || 'seseorang'} ngirim (intensi: ${intentLabel}). Pahami dulu: dia nanya, ngasih tau, atau nyuruh? Balas sesuai konteks. Jangan nanya balik.`
    : `\n📌 PRIBADI — chat 1-on-1 (intensi: ${intentLabel}). Pahami dulu: dia nanya, ngasih tau, atau nyuruh? Balas sesuai.`;

  // Time gap (C2) — check if last exchange was > 30 min ago
  const timeGap = (() => {
    if (!userHist?.length) return '';
    const lastTs = userHist._lastTimestamp || 0;
    if (!lastTs) return '';
    const gapMin = (Date.now() - lastTs) / 60000;
    if (gapMin > 30) return `\n⏰ (obrolan semalaman — user chat lagi setelah ${Math.round(gapMin)} menit)`;
    return '';
  })();

  // Style mirroring (A5) — match user message length
  const userWords = message.trim().split(/\s+/).length;
  let styleTarget = '';
  if (userWords <= 4) styleTarget = `\n📐 USER NGEKETIK SINGKAT (${userWords} kata). Jawab SEBERSIT: 1 kalimat, 2-6 kata doang.`;
  else if (userWords <= 10) styleTarget = `\n📐 USER NGEKETIK SEDANG (${userWords} kata). Jawab 1-2 kalimat pendek.`;
  else styleTarget = `\n📐 USER NGEKETIK PANJANG (${userWords} kata). Jawab natural, maks 2 kalimat.`;

  const msgs = [{ role: 'system', content: [prompt, store, ctx, langInstr, chatInstr, styleTarget, timeGap, getTimeContext(), LANG_HINTS[lang] || '', profileContext(jid), statusInstrFor(message, mode)].filter(Boolean).join('\n') }];
  const compressed = compressHistory(userHist);
  for (const m of compressed) msgs.push(m);
  msgs.push({ role: 'user', content: filterInput(message) });
  return msgs;
}

// ─── Adaptive temperature (mode-aware) ─────────────────────────────────

const FACTUAL_KW = /\b(harga|price|status|order|pesanan|produk|item|diamond|robux|cek|berapa|daftar|list|stok|tersedia|available|payment|bayar|transfer|dana|gopay|saldo)\b/i;

function pickTemperature(text, mode = 1) {
  const isFactual = FACTUAL_KW.test(text);
  const jitter = (Math.random() - 0.5) * 0.1;
  if (mode === 1) return Math.round((isFactual ? 0.4 + jitter : 0.6 + jitter) * 100) / 100;
  return Math.round((isFactual ? 0.2 : 0.45 + jitter) * 100) / 100;
}

// ─── Helpers ───────────────────────────────────────────────────────────

export function detectGreeting(text) {
  const cleaned = text.toLowerCase().trim().replace(/[^a-z0-9]/g, '');
  return FAST_REPLIES.get(cleaned) || null;
}

// ─── Main AI ───────────────────────────────────────────────────────────

export async function askAI(jid, message, mode = 1, senderName = null, isGroup = false) {
  if (!message?.trim()) return null;

  const clean = sanitizeInput(message);

  // Anti-duplikat: redelivery WA / spam pesan sama dalam 15 detik → skip
  // (jawaban untuk pesan itu sudah dikirim / sedang diproses).
  if (isDuplicate(jid, clean)) {
    logger.debug('AI', 'Skipping duplicate message');
    return null;
  }

  const fast = detectGreeting(clean);
  if (fast) {
    saveExchange(jid, message, fast, senderName, isGroup);
    return fast;
  }

  // Gibberish / emoji-only / 1 karakter → skip tanpa bakar kuota API.
  if (isIgnorable(clean)) {
    logger.debug('AI', 'Skipping ignorable message');
    return null;
  }

  // User marah berulang (2x dalam 10 menit) → arahkan ke CS manusia.
  if (detectAngry(clean)) {
    const angryCount = trackAngry(jid);
    if (angryCount >= ANGRY_THRESHOLD) {
      const esc = escalationReply(mode);
      logger.info('AI', `Escalating ${jid} to CS (angry x${angryCount})`);
      saveExchange(jid, message, esc, senderName, isGroup);
      return esc;
    }
  }

  // Inget preferensi user (game, topik) biar ga kayak baru kenal terus.
  updateUserProfile(jid, clean);

  const cached = getCached(clean, mode);
  if (cached) {
    saveExchange(jid, message, cached, senderName, isGroup);
    return cached;
  }

  const userHist = await getOrLoadHistory(jid);
  const [storeCtx, queryCtx] = await Promise.all([
    getStoreContext().catch(() => ''),
    getQueryContext(clean).catch(() => ''),
  ]);
  const msgs = buildProMessages(userHist, clean, mode, storeCtx, queryCtx, jid, isGroup, senderName);
  const temp = pickTemperature(clean, mode);
  const maxTokens = mode === 1 ? 250 : 400;

  const groqUrl = config.groqUrl;
  const groqHeaders = { Authorization: `Bearer ${config.groqKey}` };
  const opts = { messages: msgs, max_tokens: maxTokens, temperature: temp };
  const pollBase = (config.aiApiBase || '').replace(/\/+$/, '');

  let reply = null;
  let usedModel = 'unknown';
  const startTime = Date.now();

  // Smart routing: pertanyaan faktual (harga/status/order) dijawab akurat oleh
  // model kecil & cepat — 70b dilewati untuk hemat kuota. Chat bebas memakai
  // semua tier demi latensi terbaik.
  const wantsFactual = FACTUAL_KW.test(clean);
  const candidates = [];
  if (config.groqKey?.startsWith('gsk_')) {
    if (!wantsFactual) {
      candidates.push({
        model: 'llama-3.3-70b-versatile',
        url: groqUrl,
        body: { model: 'llama-3.3-70b-versatile', ...opts },
        headers: groqHeaders,
        timeout: TIER_TIMEOUTS.groq70b,
      });
    }
    candidates.push({
      model: 'llama-3.1-8b-instant',
      url: groqUrl,
      body: { model: 'llama-3.1-8b-instant', ...opts },
      headers: groqHeaders,
      timeout: TIER_TIMEOUTS.groq8b,
    });
  }
  candidates.push({
    model: 'openai',
    url: `${pollBase}/openai`,
    body: { model: config.aiModel || 'openai', ...opts },
    headers: {},
    timeout: TIER_TIMEOUTS.pollinations,
  });
  // Backup API (KeylessAI / custom)
  const backupBase = config.aiApiBackup?.replace(/\/+$/, '');
  if (backupBase && backupBase !== pollBase) {
    candidates.push({
      model: 'openai-backup',
      url: `${backupBase}/chat/completions`,
      body: { model: 'openai-fast', ...opts },
      headers: {},
      timeout: TIER_TIMEOUTS.pollinations,
    });
  }

  // Race: yang pertama SUKSES menang, yang kalah langsung di-abort supaya tidak
  // makan kuota API sia-sia. Gagal/null di-reject agar Promise.any menunggu
  // kandidat sukses berikutnya, bukan berhenti di kegagalan tercepat.
  const aborter = new AbortController();
  const raced = candidates.map(m => tryFetch(m.url, m.body, m.headers || {}, m.timeout, aborter.signal)
    .then(r => r ? { reply: r, model: m.model } : Promise.reject(new Error('empty'))));
  const winner = await Promise.any(raced).catch(() => null);
  aborter.abort();
  if (winner?.reply) {
    reply = winner.reply;
    usedModel = winner.model;
  }

  // Retry: minimal context, force Indonesian
  if (!reply) {
    logger.warn('AI', 'Retry with minimal prompt via Pollinations');
    const minimalMsgs = [
      { role: 'system', content: `${getPrompt(mode)}\n\n⚠️ BALAS DALAM BAHASA INDONESIA. 1-2 kalimat doang. JANGAN pake bahasa Inggris.` },
      { role: 'user', content: clean },
    ];
    const retryStart = Date.now();
    reply = await tryFetch(
      `${pollBase}/openai`,
      { model: 'openai', messages: minimalMsgs, max_tokens: 200, temperature: 0.4 },
      {},
      15000,
    );
    if (reply) { usedModel = 'openai-retry'; trackMetric(usedModel, Date.now() - retryStart, true); }

    // Retry backup if Pollinations still failed
    if (!reply && backupBase && backupBase !== pollBase) {
      logger.warn('AI', 'Retry with backup API');
      const retryBak = Date.now();
      reply = await tryFetch(
        `${backupBase}/chat/completions`,
        { model: 'openai-fast', messages: minimalMsgs, max_tokens: 200, temperature: 0.4 },
        {},
        15000,
      );
      if (reply) { usedModel = 'openai-backup-retry'; trackMetric(usedModel, Date.now() - retryBak, true); }
    }
  }

  const elapsed = Date.now() - startTime;

  if (reply) {
    if (/^SKIP\b/.test(reply)) {
      logger.debug('AI', 'Skipping — not relevant');
      trackMetric(usedModel, elapsed, true);
      return null;
    }

    // Language mismatch detected — log only, no re-prompt (previous re-prompt caused unnatural apologies)
    const replyLang = detectLang(reply);
    const detectedUserLang = (userLangs.get(jid)?.lang) || detectLang(clean);
    if (detectedUserLang === 'id' && replyLang === 'en') {
      logger.debug('AI', 'Reply in English for Indonesian user — using as-is');
    }
    if (detectedUserLang === 'en' && replyLang === 'id') {
      logger.debug('AI', 'Reply in Indonesian for English user — using as-is');
    }

    // Trim di batas kalimat + variasi opener biar ga kayak template.
    reply = trimReply(reply, mode);
    reply = varyReply(jid, reply);

    saveExchange(jid, message, reply, senderName, isGroup);
    setCache(clean, mode, reply);
    trackMetric(usedModel, elapsed, true);
    return reply;
  }

  logger.error('AI', 'All endpoints failed for', jid);
  trackMetric(usedModel, elapsed, false);
  return getFallbackReply(clean, mode);
}

// ─── Image AI ──────────────────────────────────────────────────────────

export async function askAIWithImage(jid, text, base64img, mime, mode = 1, senderName = null, isGroup = false) {
  const userHist = getHistory(jid);
  const lang = detectUserLang(jid, text, userHist);
  const prompt = getPrompt(mode);
  const langHint = LANG_HINTS[lang] || '';
  const langInstr = `\n⚠️ BAHASA: ${lang === 'en' ? 'ENGLISH' : 'INDONESIA'}. Balas dalam bahasa ${lang === 'en' ? 'Inggris' : 'Indonesia'} saja.`;
  const imgWordCount = text ? text.trim().split(/\s+/).length : 5;
  let imgStyle = '';
  if (imgWordCount <= 4) imgStyle = `\n📐 USER NGEKETIK SINGKAT (${imgWordCount} kata). Jawab 1 kalimat, 2-6 kata.`;
  else if (imgWordCount <= 10) imgStyle = `\n📐 USER NGEKETIK SEDANG (${imgWordCount} kata). Jawab 1-2 kalimat pendek.`;
  else imgStyle = `\n📐 USER NGEKETIK PANJANG (${imgWordCount} kata). Jawab natural, maks 2 kalimat.`;
  const content = [
    { type: 'text', text: filterInput(sanitizeInput(text)) || 'Apa ini?' },
    { type: 'image_url', image_url: { url: `data:${mime};base64,${base64img}` } },
  ];
  const msgs = [
    { role: 'system', content: prompt + langInstr + langHint + imgStyle },
    { role: 'user', content },
  ];

  // Groq vision (opt-in)
  if (config.groqKey?.startsWith('gsk_') && config.groqVisionModel) {
    const r = await tryFetch('https://api.groq.com/openai/v1/chat/completions', {
      model: config.groqVisionModel, messages: msgs, max_tokens: 400, temperature: 0.5,
    }, { Authorization: `Bearer ${config.groqKey}` }, 20000);
    if (r) {
      if (/^SKIP\b/.test(r)) return null;
      let reply = varyReply(jid, trimReply(r, mode));
      saveExchange(jid, text || '[gambar]', reply, senderName, isGroup);
      return reply;
    }
  }

  // Vision endpoints (sequential — Pollinations, backup)
  const backupBase = config.aiApiBackup?.replace(/\/+$/, '');
  const visionUrls = [
    `${(config.aiApiBase || '').replace(/\/+$/, '')}/openai`,
    'https://text.pollinations.ai/openai',
  ];
  if (backupBase) visionUrls.push(`${backupBase}/chat/completions`);
  const seen = new Set();
  for (const url of visionUrls) {
    if (seen.has(url)) continue;
    seen.add(url);
    const rRaw = await tryFetch(url, {
      model: config.aiModel || 'openai',
      messages: msgs, max_tokens: 400, temperature: 0.5,
    }, {}, 20000);
    if (rRaw) {
      if (/^SKIP\b/.test(rRaw)) return null;
      let r = varyReply(jid, trimReply(rRaw, mode));
      saveExchange(jid, text || '[gambar]', r, senderName, isGroup);
      return r;
    }
  }

  const textOnly = await askAI(jid, text || '[gambar]', mode, senderName);
  return textOnly || 'Maaf, gak bisa baca gambar.';
}

// ─── Proactive (new order notification) ────────────────────────────────

const PROACTIVE_FALLBACK = {
  1: 'Halo kak, makasih udah order ya. Kami akan proses secepatnya, ditunggu aja yak.',
  2: 'Halo kak, terima kasih sudah order di NDXStore. Pesanan kakak akan segera diproses, mohon ditunggu ya.',
};

export async function askAIProactive(order, mode = 1) {
  const prompt = getPrompt(mode);
  const userMsg = `(Ada pelanggan baru order: ${order.product_name || 'produk'}, username: ${order.username || '-'}, harga: ${order.price_idr ? 'Rp' + Number(order.price_idr).toLocaleString('id-ID') : '-'}). Kirim pesan sapaan singkat 1-2 kalimat.`;
  const msgs = [
    { role: 'system', content: `${prompt}\n\nSekarang kirim pesan LANGSUNG ke pelanggan baru. JANGAN pake tanda kutip, JANGAN ngenalin diri. 1 kalimat doang.` },
    { role: 'user', content: userMsg },
  ];
  const maxTokens = mode === 1 ? 60 : 80;
  const opts = { messages: msgs, max_tokens: maxTokens, temperature: 0.5 };
  const groqUrl = 'https://api.groq.com/openai/v1/chat/completions';
  const groqHeaders = { Authorization: `Bearer ${config.groqKey}` };
  const pollBase = (config.aiApiBase || '').replace(/\/+$/, '');

  const candidates = [
    ...(config.groqKey?.startsWith('gsk_') ? [
      { url: groqUrl, body: { model: 'llama-3.3-70b-versatile', ...opts }, headers: groqHeaders, timeout: 10000 },
      { url: groqUrl, body: { model: 'llama-3.1-8b-instant', ...opts }, headers: groqHeaders, timeout: 10000 },
    ] : []),
    { url: `${pollBase}/openai`, body: { model: config.aiModel || 'openai', ...opts }, headers: {}, timeout: 10000 },
    { url: 'https://text.pollinations.ai/openai', body: { model: 'openai', ...opts }, headers: {}, timeout: 10000 },
  ];
  const backupBase = config.aiApiBackup?.replace(/\/+$/, '');
  if (backupBase) {
    candidates.push({ url: `${backupBase}/chat/completions`, body: { model: 'openai-fast', ...opts }, headers: {}, timeout: 10000 });
  }

  const aborter = new AbortController();
  const raced = candidates.map(m => tryFetch(m.url, m.body, m.headers || {}, m.timeout, aborter.signal));
  const result = await Promise.any(raced.map(p => p.then(r => r ? r : Promise.reject()))).catch(() => null);
  aborter.abort();
  if (result) return result;

  return PROACTIVE_FALLBACK[mode] || PROACTIVE_FALLBACK[1];
}

// ─── Audio Transcription ────────────────────────────────────────────────

export async function transcribeAudio(base64Data, mimeType) {
  if (!config.groqKey?.startsWith('gsk_')) return null;
  try {
    const buf = Buffer.from(base64Data, 'base64');
    const ext = mimeType?.includes('ogg') ? 'ogg' : mimeType?.includes('mp4') ? 'm4a' : 'webm';
    const form = new FormData();
    form.append('model', 'whisper-large-v3');
    form.append('file', new Blob([buf], { type: mimeType || 'audio/ogg' }), `audio.${ext}`);
    const resp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.groqKey}` },
      body: form,
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) {
      const err = await resp.text().catch(() => '');
      logger.error('AI', 'Whisper error:', err.slice(0, 120));
      return null;
    }
    const data = await resp.json();
    const text = data.text?.trim();
    if (text) logger.info('AI', `Transcribed (${text.length} chars): ${text.slice(0, 80)}`);
    return text || null;
  } catch (e) {
    logger.error('AI', 'Transcription error:', e.message?.slice(0, 120));
    return null;
  }
}
