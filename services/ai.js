import { config } from '../config.js';
import { getDb } from './supabase.js';
import { getStoreContext, getQueryContext } from './liveData.js';
import { getStoreCacheVersion } from '../utils/cache.js';
import { logger, throttleLog } from '../utils/logger.js';
import { isRelationError } from '../utils/db.js';

function makeKnowledge() {
  return `
NDXStore — jual top up game & Roblox:
- Website resmi: ndxstoreid.vercel.app
- Game: Mobile Legends (ML), Roblox (Robux Reguler & Instant, Gamepass/Item Blox Fruits, Grow a Garden, Fisch, Blade Ball, dll), Free Fire (FF)
- Pembayaran: QRIS, DANA, GoPay, OVO, transfer bank (otomatis di web ndxstoreid.vercel.app)
- Cara order: buka ndxstoreid.vercel.app, pilih game & nominal, bayar, otomatis diproses
- Cek status: ketik "cek [username]" atau sebutkan username / ID order (NDXSTORE/... atau TX-xxxx)
- CS manusia: ketik "cs" atau "4"
- Estimasi proses: Robux Instant / ML / FF biasanya 5-30 menit setelah pembayaran sukses; Robux Reguler via Gamepass estimasi 5 hari
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

gue BUKAN cs kaku, BUKAN robot. gue anak yang bantuin jaga chat toko top up NDXStore punya temen. santai tapi tetep nyambung dan ngebantu kalo ada yang nanya harga atau orderan.

keseharian: gap year, gabut, scroll tiktok, main ml, begadang. kalo diajak ngobrol santai jawab asik kayak temen tongkrongan.

GAYA NGOMONG (wajib):
- kayak chat sama temen di WA. pendek, ngalir, 1-2 kalimat cukup
- pake "gue/lu" kalo ngobrol santai. pake "kak" atau "bang" kalo bahas orderan/harga
- JANGAN PERNAH buka dengan sapaan formal ("halo", "selamat pagi", "ada yang bisa dibantu"). langsung sikat jawab intinya
- JANGAN pake emoji, tanda kurung, bintang (*), atau format list kaku kalo ga diminta
- JANGAN pake bahasa formal: saya, anda, silakan, mohon, dengan ini, tersebut, apabila
- kalo user nanya nominal diamond yang ga persis ada di katalog (misal nanya 86 dm padahal adanya 85 dm & 88 dm), LANGSUNG sebutin nominal paling deket beserta harganya dari DATA REAL-TIME NDXStore
- kalo user ngirim beberapa bubble chat beruntun (misal sapaan + pertanyaan + detail), BACA SEMUANYA DULU sebagai satu kesatuan dan jawab intinya aja dalam 1 balasan nyambung. JANGAN jawab satu-satu per bubble

CONTOH:
User: bang
Bima: yo
User: bang
mau tanya dong
kalo top up ml 86 dm berapa?
Bima: 86 dm ga ada bang, paling deket 85 dm Rp26.651 atau 88 dm Rp27.811. langsung gas di ndxstoreid.vercel.app aja
User: kalo wdp berapa bang?
Bima: wdp ml Rp31.633. order di ndxstoreid.vercel.app ya
User: udah bayar kak
Bima: oke bentar gw cekin. username atau id ordernya apa?
User: thanks
Bima: sip
User: bima lagi ngapain?
Bima: gabut scroll tiktok wkwk. lu ngapain?
User: pesenanku mana bang?
Bima: username atau id ordernya apa? sini gw cekin
User: kok lama banget sih
Bima: sabar bang lagi antri diproses, biasanya 5-30 menit. kalo ada kendala ketik cs aja biar langsung dipegang admin

ATURAN KERAS:
1. JANGAN pernah ngaku AI, bot, atau asisten digital. kalo ditanya "lu bot ya?" jawab santai: "enak aja bot, orang beneran ini"
2. JANGAN ngarang harga/status/angka. pake angka dari DATA REAL-TIME NDXStore. kalo nominal yang ditanya ga persis ada, tawarin nominal terdekat yang ada di DATA REAL-TIME NDXStore
3. kalo user nanya STATUS order tapi belum kasih username/ID: TANYA username atau ID ordernya langsung
4. kalo di grup dan ga dimention/direply: diem. JANGAN nanya balik di grup
5. kalo user kirim penggalan chat beruntun, rangkum jawabannya jadi 1 chat yang natural kayak manusia yang baca semua chat dulu baru bales

singkat: baca semua dulu, paham maksud utamanya, jawab 1x kayak manusia beneran.`;
}

function makeNdxstorePrompt() {
  return `Lo adalah Customer Service (CS) manusia di NDXStore — toko top up game & Roblox terpercaya. Ramah, sigap, jelas, dan komunikatif seperti admin toko sungguhan di WhatsApp/Instagram.

IDENTITAS:
- CS NDXStore — jam operasional 08.00-22.00 WIB
- Tugas utama: bantu pelanggan cek harga, cara order, dan cek status transaksi (Mobile Legends, Roblox Robux & Gamepass, Free Fire, dll)
- Gaya bahasa: sopan, akrab, santai tapi profesional (tidak kaku seperti mesin/template)

CARA NGOMONG:
- BALAS PAKE BAHASA YANG SAMA dengan pelanggan
- Panggil pelanggan "kak" (atau "bang" jika pelanggan memanggil bang/bro)
- Jawab langsung ke inti pertanyaan, jelas, dan solutif
- JANGAN pake emoji dan JANGAN pake format bintang (*) berlebihan
- JANGAN pake bahasa birokrasi kaku (hindari: sehubungan dengan, dapat kami sampaikan, dengan demikian)
- Kalo pelanggan kirim beberapa bubble chat beruntun (misal sapaan dulu lalu pertanyaan), BACA SEMUANYA DULU dan balas langsung ke intinya dalam 1 pesan utuh yang mengalir natural

YANG LO BANTU:
1. Info produk & harga:
   - WAJIB gunakan angka dari DATA REAL-TIME NDXStore jika tersedia.
   - Jika pelanggan menanyakan nominal yang tidak persis sama (misal tanya "86 dm" padahal di katalog adanya "85 Diamonds" dan "88 Diamonds"), JANGAN cuma bilang tidak ada — langsung sebutkan opsi nominal terdekat beserta harganya!
2. Cara order: langsung di website ndxstoreid.vercel.app, pilih produk, pilih metode pembayaran (QRIS/DANA/GoPay/Transfer), otomatis diproses 5-30 menit.
3. Cek status order:
   - Jika ada DATA REAL-TIME STATUS ORDER, jelaskan status pembayaran (Bayar: PENDING/SUCCESS) dan status pesanan (WAITING_PAYMENT/PROCESSING/SUCCESS) dengan jelas.
   - Jika belum ada username/ID order, tanyakan username atau ID ordernya (atau infokan bisa ketik "cek [username]").
4. Keluhan / kendala: minta maaf dengan tulus, bantu cek statusnya, atau arahkan ketik "cs" agar disambungkan langsung ke admin utama.

ATURAN PENTING:
1. JANGAN pernah mengaku sebagai AI, bot, atau sistem otomatis
2. JANGAN mengarang harga atau status order di luar DATA REAL-TIME NDXStore
3. Kalo pelanggan berbahasa Inggris, balas dalam bahasa Inggris yang natural
4. Kalo di grup: jawab singkat dan jelas tanpa bertanya balik

CONTOH PERCAKAPAN:
Pelanggan: kak
mau tanya dong
harga ml 86 diamond berapa?
CS: Untuk 86 Diamonds ML tidak ada nominal persisnya kak, paling dekat ada 85 Diamonds Rp26.651 atau 88 Diamonds Rp27.811. Kakak bisa langsung order di ndxstoreid.vercel.app ya.

Pelanggan: kalo wdp ml berapa kak?
CS: Untuk Weekly Diamond Pass ML harganya Rp31.633 kak. Bisa langsung dipesan di ndxstoreid.vercel.app ya.

Pelanggan: udah bayar kak, udah konfirmasi
CS: Baik kak, boleh infokan username atau ID ordernya kak biar langsung kami bantu cek statusnya?

Pelanggan: makasih kak
CS: Sama-sama kak, kalau ada yang perlu dibantu lagi kabarin aja ya.

PENGETAHUAN TOKO:
${makeKnowledge()}

INGAT — lo CS manusia yang cekatan. Baca semua penggalan chat pelanggan dulu, pahami utuh, lalu balas 1x dengan jelas dan membantu.`;
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

// ─── Unnatural word filter — hanya pola paling kaku ──────────────────────
const UNNATURAL_PATTERNS = [
  [/\bsaya selaku\b/gi, 'aku'],
  [/\boleh karena itu\b/gi, 'makanya'],
  [/\bdengan demikian\b/gi, 'jadi'],
  [/\bmohon maaf sebelumnya[,\s]*/gi, 'Maaf '],
  [/\bsehubungan dengan\b/gi, 'soal'],
  [/\bperlu diketahui\b/gi, 'info aja'],
  [/\bdapat kami sampaikan\b/gi, ''],
  [/\bdemikian disampaikan\b/gi, ''],
  [/\batas perhatiannya\b/gi, 'makasih'],
];

function naturalize(text) {
  let t = String(text || '');
  for (const [re, replacement] of UNNATURAL_PATTERNS) {
    t = t.replace(re, replacement);
  }
  return t.replace(/\s{2,}/g, ' ').trim();
}

// ─── Fast-path responses (no API call) ─────────────────────────────────

const FAST_REPLIES_BIMA = new Map([
  ['p', 'yo'],
  ['pp', 'yo'],
  ['test', 'masuk'],
  ['ping', 'pong'],
  ['tes', 'masuk'],
  ['ok', 'sip'],
  ['oke', 'sip'],
  ['okey', 'sip'],
  ['okay', 'sip'],
  ['sip', 'sip'],
  ['siap', 'siap'],
  ['hehe', 'wkwk'],
  ['haha', 'wkwk'],
  ['hihi', 'wkwk'],
  ['wkwk', 'wkwk'],
  ['makasih', 'sama-sama'],
  ['makasi', 'sama-sama'],
  ['terimakasih', 'sama-sama'],
  ['thanks', 'yo sama-sama'],
  ['thankyou', 'sama-sama'],
  ['thx', 'sip'],
  ['trims', 'sama-sama'],
  ['assalamualaikum', 'waalaikumsalam'],
  ['asalamualaikum', 'waalaikumsalam'],
]);

const FAST_REPLIES_CS = new Map([
  ['p', 'Halo kak, ada yang bisa dibantu?'],
  ['pp', 'Halo kak, ada yang bisa dibantu?'],
  ['halo', 'Halo kak, ada yang bisa kami bantu?'],
  ['hai', 'Halo kak, ada yang bisa kami bantu?'],
  ['hi', 'Halo kak, ada yang bisa kami bantu?'],
  ['pagi', 'Selamat pagi kak, ada yang bisa dibantu?'],
  ['siang', 'Selamat siang kak, ada yang bisa dibantu?'],
  ['sore', 'Selamat sore kak, ada yang bisa dibantu?'],
  ['malam', 'Selamat malam kak, ada yang bisa dibantu?'],
  ['malem', 'Selamat malam kak, ada yang bisa dibantu?'],
  ['assalamualaikum', 'Waalaikumsalam kak, ada yang bisa kami bantu?'],
  ['asalamualaikum', 'Waalaikumsalam kak, ada yang bisa kami bantu?'],
  ['test', 'Halo kak, WA NDXStore aktif. Ada yang bisa dibantu?'],
  ['tes', 'Halo kak, WA NDXStore aktif. Ada yang bisa dibantu?'],
  ['ping', 'Halo kak, ada yang bisa dibantu?'],
  ['ok', 'Baik kak'],
  ['oke', 'Baik kak'],
  ['okey', 'Baik kak'],
  ['okay', 'Baik kak'],
  ['sip', 'Siap kak'],
  ['siap', 'Siap kak'],
  ['makasih', 'Sama-sama kak, kalau ada yang perlu dibantu lagi kabarin aja ya'],
  ['makasi', 'Sama-sama kak, kalau ada yang perlu dibantu lagi kabarin aja ya'],
  ['terimakasih', 'Sama-sama kak, senang bisa membantu'],
  ['thanks', 'Sama-sama kak, kalau butuh bantuan lagi kabarin aja ya'],
  ['thankyou', 'Sama-sama kak'],
  ['thx', 'Sama-sama kak'],
  ['trims', 'Sama-sama kak'],
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
    // Guard: baris DB korup (content null) tidak boleh meledakkan reply (M3).
    const userMsg = String(p.user ?? '');
    const asstMsg = String(p.asst ?? '');
    const userShort = userMsg.length > 80 ? userMsg.slice(0, 80) + '...' : userMsg;
    const asstShort = asstMsg ? (asstMsg.length > 60 ? asstMsg.slice(0, 60) + '...' : asstMsg) : '';
    return asstShort ? `"${userShort}" → "${asstShort}"` : `"${userShort}"`;
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
    const { data, error } = await withTimeout(db
      .from('wa_chat_history')
      .select('role, content, created_at')
      .eq('user_number', jid)
      .order('created_at', { ascending: false })
      .limit(MAX_HISTORY), 5000);
    // DB error (RLS/kolom) bukan "user baru" — catat agar tidak diam (m2).
    if (error) {
      if (!isRelationError(error)) {
        logger.warn('AI', 'History load error:', error.message?.slice(0, 120));
      }
      return [];
    }
    if (!data?.length) return [];
    // Koersi defensif: baris korup (content null / role aneh) difilter (M3).
    const hist = data.reverse()
      .filter(m => (m.role === 'user' || m.role === 'assistant'))
      .map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : String(m.content ?? '') }));
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

export function isDuplicate(jid, text, recordNow = true) {
  const norm = (text || '').toLowerCase().trim().replace(/\s+/g, ' ');
  if (!norm) return false;
  const prev = recentInputs.get(jid);
  const now = Date.now();
  if (prev && prev.text === norm && now - prev.ts < DEDUP_WINDOW_MS) return true;
  if (recordNow) recentInputs.set(jid, { text: norm, ts: now });
  return false;
}

function recordRecentInput(jid, text) {
  const norm = (text || '').toLowerCase().trim().replace(/\s+/g, ' ');
  if (!norm) return;
  recentInputs.set(jid, { text: norm, ts: Date.now() });
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
  // Normalisasi huruf memanjang khas WA ("kakkk" -> "kak", "yaaa" -> "ya", "halooo" -> "halo")
  // agar kata valid yang dipanjangkan tidak dianggap gibberish!
  const deStretched = stripped.toLowerCase().replace(/(.)\1{2,}/g, '$1');
  if (deStretched.length === 1) return true; // misal "aaaaaa" atau "zzzzzz"
  const counts = Object.create(null);
  for (const ch of deStretched) counts[ch] = (counts[ch] || 0) + 1;
  const top = Math.max(...Object.values(counts));
  if (deStretched.length >= 6 && top / deStretched.length > 0.65) return true;
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
  [/mobile\s*legend|\b(ml|mlbb|wdp|starlight|twilight)\b/i, 'ml'],
  [/roblox|robux|\brbx\b|blox\s*fruit|grow\s*a\s*garden|fisch|blade\s*ball|brookhaven/i, 'roblox'],
  [/free\s*fire|\b(ff|epep)\b/i, 'ff'],
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
const HAS_USERNAME_KW = /cek\s+\S+|(?:TX|TXN|NDX)-[A-Z0-9]+|NDXSTORE\/[A-Z0-9_\/-]+/i;

function statusInstrFor(message, mode) {
  if (!STATUS_ASK_KW.test(message)) return '';
  if (HAS_USERNAME_KW.test(message)) return '';
  return mode === 2
    ? `\n⚡ PELANGGAN TANYA STATUS ORDER tapi belum sebut username/ID. Tanyakan langsung username atau ID ordernya dengan ramah biar bisa dicek.`
    : `\n⚡ USER NANYA STATUS ORDER tapi ga kasih username/ID. JANGAN nyuruh "ketik cek". TANYA LANGSUNG username atau ID ordernya biar bisa dicekin.`;
}

// ─── Reply variation — jawaban identik beruntun dikasih opener beda ───────
// Biar ga kerasa kayak template yang di-copy-paste (Fase 3A).

const lastReplies = new Map(); // jid -> { reply, opener }
const REPLY_OPENERS = ['', 'eh ', 'hmm ', 'ya ', 'oalah '];
const LAST_REPLY_MAX = 500;

function varyReply(jid, reply, mode = 1) {
  if (mode === 2) return reply; // CS mode tetap sopan & konsisten tanpa selipan "eh "/"oalah "
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
  const max = mode === 1 ? 350 : 700;
  if (r.length > max) {
    const cut = r.slice(0, max);
    const lastStop = Math.max(
      cut.lastIndexOf('. '),
      cut.lastIndexOf('! '),
      cut.lastIndexOf('? '),
      cut.lastIndexOf('\n'),
    );
    r = (lastStop > 60 ? cut.slice(0, lastStop + 1) : cut).trim();
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
function cacheKey(jid, text, mode) {
  return jid + '|' + text.toLowerCase().trim().replace(/\s+/g, ' ') + '|' + mode + '|' + getStoreCacheVersion();
}
function getCached(jid, text, mode) {
  const key = cacheKey(jid, text, mode);
  const entry = responseCache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL_MS) {
    responseCache.delete(key);
    responseCache.set(key, entry);
    return entry.reply;
  }
  if (entry) responseCache.delete(key);
  return null;
}

function setCache(jid, text, mode, reply) {
  const key = cacheKey(jid, text, mode);
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
  openrouter: 12000,
  gemini: 12000,
  pollinations: 15000,
};

// ─── Strict AI Output Validator (blocks upstream errors & leaks) ────────
// Prevents OpenRouter/providers from leaking 200-OK error messages (e.g.
// "Upstream error from Nvidia: Service temporarily overloaded") to users.
const INVALID_AI_OUTPUT_RE = new RegExp([
  '^\\s*(upstream\\s+error|provider\\s+returned\\s+error|service\\s+temporarily\\s+overloaded|internal\\s+server\\s+error|bad\\s+gateway|gateway\\s+timeout|service\\s+unavailable)',
  '\\b(upstream\\s+error\\s+from|service\\s+temporarily\\s+overloaded|provider\\s+returned\\s+error|rate\\s+limit\\s+exceeded|quota\\s+exceeded|insufficient_quota|model\\s+is\\s+(?:currently\\s+)?overloaded|context\\s+length\\s+exceeded|maximum\\s+context\\s+length|invalid\\s+api\\s+key|authentication\\s+failed|no\\s+endpoints\\s+found|model\\s+not\\s+found|decommissioned)\\b',
  '^\\s*(user\\s+safety|safety\\s+assessment|content\\s+safety|llama\\s+guard)\\s*:',
  '^\\s*(safe|unsafe)\\s*(?:s\\d+)?\\s*$',
  '^\\s*(\\{\\s*"error"|\\[\\s*\\{\\s*"error"|<!doctype\\s+html|<html\\b|<head\\b|```\\s*json)',
  '^\\s*(error|exception|traceback|syntaxerror|typeerror|referenceerror|fetcherror|aborterror)\\s*:',
  '\\b(DATA REAL-TIME NDXStore|MULTI-BUBBLE|USER NGEKETIK|ATURAN KERAS|ATURAN PENTING|PENGETAHUAN TOKO)\\b',
  '\\b(as\\s+an\\s+ai\\s+language\\s+model|sebagai\\s+(?:model\\s+bahasa\\s+)?ai|saya\\s+adalah\\s+(?:asisten\\s+virtual|bot|ai))\\b',
].join('|'), 'i');

export function sanitizeAiOutput(rawContent) {
  if (typeof rawContent !== 'string') return null;
  let text = rawContent
    .replace(/<(think|reasoning|thought)>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(think|reasoning|thought)>[\s\S]*$/gi, '')
    .replace(/^(?:\[Chat\s*\d+\]\s*:\s*|Bima\s*:\s*|CS(?:\s+NDXStore)?\s*:\s*|Admin\s*:\s*|Asisten\s*:\s*|Assistant\s*:\s*)+/i, '')
    .trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim();
  }
  if (!text || text.length < 2) return null;
  if (INVALID_AI_OUTPUT_RE.test(text)) return null;
  return text;
}

function extractValidContent(data, url, model) {
  if (!data || data.error || data?.choices?.[0]?.error) {
    const errMsg = data?.error?.message || data?.choices?.[0]?.error?.message || JSON.stringify(data?.error || data?.choices?.[0]?.error || {});
    throttleLog('warn', 'AI', `body-err-${model}`, `${url} (${model}) body error: ${String(errMsg).slice(0, 120)}`, 15000);
    return null;
  }
  const choice = data?.choices?.[0];
  if (choice?.finish_reason === 'error' || choice?.finish_reason === 'content_filter') {
    return null;
  }
  const raw = choice?.message?.content;
  const cleaned = sanitizeAiOutput(raw);
  if (!cleaned && raw) {
    throttleLog('warn', 'AI', `invalid-out-${model}`, `${url} (${model}) output tidak valid diblokir: "${String(raw).slice(0, 100)}"`, 15000);
  }
  return cleaned;
}

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

      // Jangan retry 429 berulang di OpenRouter agar langsung cepat pindah ke Gemini fallback
      if (resp.status === 429 && !url.includes('openrouter.ai')) {
        let backoff = 2000;
        let retried = false;
        for (let attempt = 1; attempt <= 2; attempt++) {
          throttleLog('warn', 'AI', `429-${model}`, `${url} (${model}) 429 — retry ${attempt}/2 after ${backoff}ms`, 30000);
          await new Promise(r => setTimeout(r, backoff));
          try {
            resp = await doFetch(timeoutMs);
          } catch {
            if (!signal?.aborted) markEndpointFailure(key);
            return null;
          }
          if (resp.ok) {
            const data = await resp.json();
            const content = extractValidContent(data, url, model);
            if (content) {
              markEndpointSuccess(key);
              trackUsage(model, data?.usage);
              return content;
            }
            markEndpointFailure(key);
            return null;
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

      if (resp.status >= 500 && !url.includes('openrouter.ai')) {
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
          const content = extractValidContent(data, url, model);
          if (content) {
            markEndpointSuccess(key);
            trackUsage(model, data?.usage);
            return content;
          }
          markEndpointFailure(key);
          return null;
        }
      }

      if (resp.status === 401 || resp.status === 403) {
        FAILED_ENDPOINTS.set(key, { count: CB_THRESHOLD, cooldown: 3600000, markedAt: Date.now() });
        throttleLog('warn', 'AI', `auth-${model}`, `${url} (${model}) ${resp.status} — API key ditolak, endpoint dinonaktifkan 1 jam`, 3600000);
        return null;
      }

      markEndpointFailure(key);
      throttleLog('warn', 'AI', `http-${resp.status}-${model}`, `${url} (${model}) ${resp.status}: ${err.slice(0, 120)}`, 15000);
      return null;
    }

    const data = await resp.json();
    const content = extractValidContent(data, url, model);
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
const USER_LANG_MAX = 500;

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
  userLangs.delete(jid);
  userLangs.set(jid, { lang: dominant, ts: Date.now() });
  // Cap seperti Map lain — tanpa ini JID masif <24 jam = memori bocor (m1).
  while (userLangs.size > USER_LANG_MAX) {
    userLangs.delete(userLangs.keys().next().value);
  }
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

  // Detect multiple chat bubbles sent in sequence
  const bubbles = message.split('\n').map(s => s.trim()).filter(Boolean);
  const isMultiBubble = bubbles.length > 1;
  const multiBubbleInstr = isMultiBubble
    ? `\n💬 MULTI-BUBBLE (${bubbles.length} chat beruntun): User mengirim ${bubbles.length} penggalan chat berturut-turut. Baca dan pahami SEMUA penggalan di bawah ini sebagai satu kesatuan pikiran, abaikan basa-basi pembuka jika sudah ada inti pertanyaannya, dan jawab sekaligus dalam SATU balasan utuh yang mengalir natural (JANGAN jawab satu per satu per baris).`
    : '';

  // Intent detection (A1) — evaluate across all bubbles
  const cleanMsg = message.toLowerCase().trim();
  const isQuestion = /(\?|(\b(apa|siapa|kapan|dimana|kenapa|bagaimana|gimana|berapa|brp|apakah|bisakah|dapatkah|maukah|ada\s+ga|bisa\s+ga)\b))/i.test(cleanMsg);
  const isCommand = /(?:^|\n)\s*(tolong|minta|bantu|coba|kasi|kasih|buatin|bikinin|kirim|tambah|ubah|stop|berhenti|cek)\b/i.test(message);
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

  // Style mirroring (A5) — match user message length & multi-bubble depth
  const userWords = message.trim().split(/\s+/).length;
  let styleTarget = '';
  if (!isMultiBubble && userWords <= 4 && !isQuestion) {
    styleTarget = `\n📐 USER NGEKETIK SINGKAT (${userWords} kata). Jawab SEBERSIT: 1 kalimat, 2-6 kata doang.`;
  } else if (userWords <= 10) {
    styleTarget = `\n📐 USER NGEKETIK SEDANG (${userWords} kata). Jawab 1-2 kalimat pendek yang langsung menjawab intinya.`;
  } else {
    styleTarget = `\n📐 USER NGEKETIK (${userWords} kata${isMultiBubble ? `, ${bubbles.length} bubble` : ''}). Rangkum jawaban semua pertanyaannya dalam 1-2 kalimat natural yang padat & jelas.`;
  }

  const msgs = [{ role: 'system', content: [prompt, store, ctx, langInstr, chatInstr, multiBubbleInstr, styleTarget, timeGap, getTimeContext(), LANG_HINTS[lang] || '', profileContext(jid), statusInstrFor(message, mode)].filter(Boolean).join('\n') }];
  const compressed = compressHistory(userHist);
  for (const m of compressed) msgs.push(m);
  const formattedUserContent = isMultiBubble
    ? bubbles.map((b, i) => `[Chat ${i + 1}]: ${filterInput(b)}`).join('\n')
    : filterInput(message);
  msgs.push({ role: 'user', content: formattedUserContent });
  return msgs;
}

// ─── Adaptive temperature (mode-aware) ─────────────────────────────────

const FACTUAL_KW = /\b(harga|price|status|order|pesanan|produk|item|diamond|dm|wdp|starlight|robux|rbx|cek|berapa|brp|daftar|list|stok|tersedia|available|payment|bayar|transfer|dana|gopay|saldo)\b/i;

function pickTemperature(text, mode = 1) {
  const isFactual = FACTUAL_KW.test(text);
  const jitter = (Math.random() - 0.5) * 0.1;
  if (mode === 1) return Math.round((isFactual ? 0.4 + jitter : 0.6 + jitter) * 100) / 100;
  return Math.round((isFactual ? 0.2 : 0.45 + jitter) * 100) / 100;
}

// ─── Helpers ───────────────────────────────────────────────────────────

export function detectGreeting(text, mode = 1) {
  const raw = String(text || '').trim();
  // Never use single-word fast reply if user sent multiple bubbles or multiple words
  if (!raw || raw.includes('\n') || raw.split(/\s+/).length > 1) return null;
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!cleaned) return null;
  const normalized = cleaned === 'pp' ? 'pp' : cleaned.replace(/(.)\1{2,}/g, '$1');
  const map = mode === 2 ? FAST_REPLIES_CS : FAST_REPLIES_BIMA;
  return map.get(cleaned) || map.get(normalized) || null;
}

export function getProviderHealth() {
  const openCircuits = [];
  for (const [k, v] of FAILED_ENDPOINTS) {
    if (v.count >= CB_THRESHOLD) openCircuits.push(k.split('|')[1] || k);
  }
  return {
    groq: Boolean(config.groqKey?.startsWith('gsk_')),
    gemini: Boolean(config.geminiKey),
    openrouter: Boolean(config.openrouterKey?.startsWith('sk-or-')),
    openCircuits,
  };
}

// ─── Main AI ───────────────────────────────────────────────────────────

export async function askAI(jid, message, mode = 1, senderName = null, isGroup = false, signal = null) {
  if (!message?.trim()) return null;
  if (signal?.aborted) return null;

  const clean = sanitizeInput(message);

  // Anti-duplikat: redelivery WA / spam pesan sama dalam 15 detik → skip
  // (jangan langsung catat kalau pakai signal agar kalau di-abort saat ada bubble susulan, tidak dianggap duplikat).
  if (isDuplicate(jid, clean, !signal)) {
    logger.debug('AI', 'Skipping duplicate message');
    return null;
  }

  const fast = detectGreeting(clean, mode);
  if (fast) {
    if (signal?.aborted) return null;
    if (signal) recordRecentInput(jid, clean);
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
      if (signal?.aborted) return null;
      const esc = escalationReply(mode);
      logger.info('AI', `Escalating ${jid} to CS (angry x${angryCount})`);
      if (signal) recordRecentInput(jid, clean);
      saveExchange(jid, message, esc, senderName, isGroup);
      return esc;
    }
  }

  const cached = getCached(jid, clean, mode);
  if (cached) {
    if (signal?.aborted) return null;
    if (signal) recordRecentInput(jid, clean);
    updateUserProfile(jid, clean);
    saveExchange(jid, message, cached, senderName, isGroup);
    return cached;
  }

  const profile = updateUserProfile(jid, clean);
  const userHist = await getOrLoadHistory(jid);
  if (signal?.aborted) return null;

  const [storeCtx, queryCtx] = await Promise.all([
    getStoreContext().catch(() => ''),
    getQueryContext(clean, profile?.game || null).catch(() => ''),
  ]);
  if (signal?.aborted) return null;

  const msgs = buildProMessages(userHist, clean, mode, storeCtx, queryCtx, jid, isGroup, senderName);
  const temp = pickTemperature(clean, mode);
  const maxTokens = mode === 1 ? 260 : 420;

  const groqUrl = config.groqUrl;
  const groqHeaders = { Authorization: `Bearer ${config.groqKey}` };
  const opts = { messages: msgs, max_tokens: maxTokens, temperature: temp };
  const pollBase = (config.aiApiBase || '').replace(/\/+$/, '');

  let reply = null;
  let usedModel = 'unknown';
  const startTime = Date.now();

  // 1. Primary Tier: Groq — gunakan llama-3.3-70b-versatile sebagai model utama
  //    untuk semua jenis pertanyaan (termasuk harga/order/multi-bubble agar cerdas & natural),
  //    dan llama-3.1-8b-instant sebagai fallback cepat jika 70b kena limit/gangguan.
  if (config.groqKey?.startsWith('gsk_') && !signal?.aborted) {
    for (const groqModel of ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant']) {
      if (signal?.aborted) break;
      const tOut = groqModel.includes('70b') ? TIER_TIMEOUTS.groq70b : TIER_TIMEOUTS.groq8b;
      const groqReply = await tryFetch(
        groqUrl,
        { model: groqModel, ...opts },
        groqHeaders,
        tOut,
        signal,
      );
      if (groqReply) {
        reply = groqReply;
        usedModel = groqModel;
        break;
      }
    }
  }
  if (signal?.aborted) return null;

  // 2. Fallback Tier 1: Google Gemini (cepat ~1.5s, stabil, bebas error upstream)
  if (!reply && config.geminiKey && !signal?.aborted) {
    const gemPrimary = config.geminiModel || 'gemini-3.5-flash-lite';
    const gemModels = [
      gemPrimary,
      'gemini-3.8-flash',
      'gemini-flash-latest',
    ].filter((m, i, a) => m && a.indexOf(m) === i);
    const gemHeaders = { Authorization: `Bearer ${config.geminiKey}` };
    for (const gemModel of gemModels) {
      if (signal?.aborted) break;
      const gemBody = gemModel.includes('3.8') || gemModel.includes('latest')
        ? { model: gemModel, ...opts, reasoning_effort: 'none' }
        : { model: gemModel, ...opts };
      const gemReply = await tryFetch(
        config.geminiUrl,
        gemBody,
        gemHeaders,
        TIER_TIMEOUTS.gemini,
        signal,
      );
      if (gemReply) {
        reply = gemReply;
        usedModel = gemModel;
        break;
      }
    }
  }
  if (signal?.aborted) return null;

  // 3. Fallback Tier 2: OpenRouter (dengan filter anti-error ketat)
  if (!reply && config.openrouterKey?.startsWith('sk-or-') && !signal?.aborted) {
    const orModel = config.openrouterModel || 'nvidia/nemotron-3-super-120b-a12b:free';
    const orCandidates = [
      orModel,
      'nvidia/nemotron-3-super-120b-a12b:free',
      'google/gemma-3-27b-it:free',
      'meta-llama/llama-3.3-70b-instruct:free',
      'openrouter/free',
    ].filter((m, i, a) => m && a.indexOf(m) === i);
    const orHeaders = {
      Authorization: `Bearer ${config.openrouterKey}`,
      'HTTP-Referer': config.apiBase || 'https://ndxstoreid.vercel.app',
      'X-Title': 'NDXStore WA Bot',
    };
    for (const candidateModel of orCandidates) {
      if (signal?.aborted) break;
      const orReply = await tryFetch(
        config.openrouterUrl,
        { model: candidateModel, ...opts, reasoning: { effort: 'none' } },
        orHeaders,
        TIER_TIMEOUTS.openrouter,
        signal,
      );
      if (orReply) {
        reply = orReply;
        usedModel = candidateModel;
        break;
      }
    }
  }
  if (signal?.aborted) return null;

  // 4. Fallback Tier 3: Pollinations & Backup API
  const backupBase = config.aiApiBackup?.replace(/\/+$/, '');
  if (!reply && !signal?.aborted) {
    const fallbackCandidates = [];
    if (pollBase) {
      fallbackCandidates.push({
        model: 'openai',
        url: `${pollBase}/openai`,
        body: { model: config.aiModel || 'openai', ...opts },
        headers: {},
        timeout: TIER_TIMEOUTS.pollinations,
      });
    } else {
      throttleLog('error', 'AI', 'pollbase-empty', 'AI_API_BASE kosong — tier Pollinations nonaktif. Isi AI_API_BASE di .env.', 3600000);
    }
    if (backupBase && backupBase !== pollBase) {
      fallbackCandidates.push({
        model: 'openai-backup',
        url: `${backupBase}/chat/completions`,
        body: { model: 'openai-fast', ...opts },
        headers: {},
        timeout: TIER_TIMEOUTS.pollinations,
      });
    }
    if (fallbackCandidates.length) {
      const aborter = new AbortController();
      const raceSig = signal ? AbortSignal.any([aborter.signal, signal]) : aborter.signal;
      const raced = fallbackCandidates.map(m => tryFetch(m.url, m.body, m.headers || {}, m.timeout, raceSig)
        .then(r => r ? { reply: r, model: m.model } : Promise.reject(new Error('empty'))));
      const winner = await Promise.any(raced).catch(() => null);
      aborter.abort();
      if (winner?.reply) {
        reply = winner.reply;
        usedModel = winner.model;
      }
    }
  }
  if (signal?.aborted) return null;

  // Retry: minimal context, force Indonesian
  if (!reply && pollBase && !signal?.aborted) {
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
      signal,
    );
    if (reply) { usedModel = 'openai-retry'; trackMetric(usedModel, Date.now() - retryStart, true); }

    // Retry backup if Pollinations still failed
    if (!reply && backupBase && backupBase !== pollBase && !signal?.aborted) {
      logger.warn('AI', 'Retry with backup API');
      const retryBak = Date.now();
      reply = await tryFetch(
        `${backupBase}/chat/completions`,
        { model: 'openai-fast', messages: minimalMsgs, max_tokens: 200, temperature: 0.4 },
        {},
        15000,
        signal,
      );
      if (reply) { usedModel = 'openai-backup-retry'; trackMetric(usedModel, Date.now() - retryBak, true); }
    }
  }
  if (signal?.aborted) return null;

  const elapsed = Date.now() - startTime;

  if (reply) {
    if (signal) recordRecentInput(jid, clean);

    if (/^SKIP\b/.test(reply)) {
      logger.debug('AI', 'Model SKIP — memakai fallback kontekstual');
      trackMetric(usedModel, elapsed, true);
      return getFallbackReply(clean, mode);
    }

    const replyLang = detectLang(reply);
    const detectedUserLang = (userLangs.get(jid)?.lang) || detectLang(clean);
    if (detectedUserLang === 'id' && replyLang === 'en') {
      logger.debug('AI', 'Reply in English for Indonesian user — using as-is');
    }
    if (detectedUserLang === 'en' && replyLang === 'id') {
      logger.debug('AI', 'Reply in Indonesian for English user — using as-is');
    }

    reply = trimReply(reply, mode);
    reply = varyReply(jid, reply, mode);

    saveExchange(jid, message, reply, senderName, isGroup);
    setCache(jid, clean, mode, reply);
    trackMetric(usedModel, elapsed, true);
    return reply;
  }

  logger.error('AI', 'All endpoints failed for', jid);
  trackMetric(usedModel, elapsed, false);
  return getFallbackReply(clean, mode);
}

// ─── Image AI ──────────────────────────────────────────────────────────

export async function askAIWithImage(jid, text, base64img, mime, mode = 1, senderName = null, isGroup = false, signal = null) {
  if (signal?.aborted) return null;
  const userHist = await getOrLoadHistory(jid);
  if (signal?.aborted) return null;
  const cleanText = sanitizeInput(text || '');
  const profile = cleanText ? updateUserProfile(jid, cleanText) : userProfiles.get(jid);
  const [storeCtx, queryCtx] = await Promise.all([
    getStoreContext().catch(() => ''),
    cleanText ? getQueryContext(cleanText, profile?.game || null).catch(() => '') : Promise.resolve(''),
  ]);
  if (signal?.aborted) return null;

  const lang = detectUserLang(jid, cleanText, userHist);
  const prompt = getPrompt(mode);
  const store = storeCtx ? `\n\n${storeCtx}` : '';
  const ctx = queryCtx ? `\n\nDATA REAL-TIME NDXStore:\n${queryCtx}` : '';
  const langHint = LANG_HINTS[lang] || '';
  const langInstr = `\n⚠️ BAHASA: ${lang === 'en' ? 'ENGLISH' : 'INDONESIA'}. Balas dalam bahasa ${lang === 'en' ? 'Inggris' : 'Indonesia'} saja.`;
  const imgWordCount = cleanText ? cleanText.trim().split(/\s+/).length : 5;
  let imgStyle = '';
  if (imgWordCount <= 4) imgStyle = `\n📐 USER NGEKETIK SINGKAT (${imgWordCount} kata). Jawab 1 kalimat, 2-6 kata.`;
  else if (imgWordCount <= 10) imgStyle = `\n📐 USER NGEKETIK SEDANG (${imgWordCount} kata). Jawab 1-2 kalimat pendek.`;
  else imgStyle = `\n📐 USER NGEKETIK PANJANG (${imgWordCount} kata). Jawab natural, maks 2 kalimat.`;
  const content = [
    { type: 'text', text: filterInput(cleanText) || 'Apa ini?' },
    { type: 'image_url', image_url: { url: `data:${mime};base64,${base64img}` } },
  ];
  const msgs = [
    { role: 'system', content: prompt + store + ctx + langInstr + langHint + imgStyle },
    ...compressHistory(userHist).slice(-4),
    { role: 'user', content },
  ];

  // 1. Groq vision (opt-in)
  if (config.groqKey?.startsWith('gsk_') && config.groqVisionModel && !signal?.aborted) {
    const r = await tryFetch('https://api.groq.com/openai/v1/chat/completions', {
      model: config.groqVisionModel, messages: msgs, max_tokens: 400, temperature: 0.5,
    }, { Authorization: `Bearer ${config.groqKey}` }, 20000, signal);
    if (signal?.aborted) return null;
    if (r && !/^SKIP\b/.test(r)) {
      const reply = varyReply(jid, trimReply(r, mode), mode);
      saveExchange(jid, text || '[gambar]', reply, senderName, isGroup);
      return reply;
    }
  }

  // 2. Google Gemini vision fallback (cepat & akurat untuk screenshot bukti bayar / game)
  if (config.geminiKey && !signal?.aborted) {
    for (const gemVisionModel of [config.geminiModel || 'gemini-3.5-flash-lite', 'gemini-3.8-flash']) {
      if (signal?.aborted) break;
      const r = await tryFetch(config.geminiUrl, {
        model: gemVisionModel, messages: msgs, max_tokens: 400, temperature: 0.5,
      }, { Authorization: `Bearer ${config.geminiKey}` }, 15000, signal);
      if (signal?.aborted) return null;
      if (r && !/^SKIP\b/.test(r)) {
        const reply = varyReply(jid, trimReply(r, mode), mode);
        saveExchange(jid, text || '[gambar]', reply, senderName, isGroup);
        return reply;
      }
    }
  }

  // 3. OpenRouter vision fallback
  if (config.openrouterKey?.startsWith('sk-or-') && !signal?.aborted) {
    const orVisionModels = [
      'google/gemma-3-27b-it:free',
      'nvidia/nemotron-3.5-super-vl:free',
      'openrouter/free',
    ];
    for (const orVisModel of orVisionModels) {
      if (signal?.aborted) break;
      const r = await tryFetch(config.openrouterUrl, {
        model: orVisModel, messages: msgs, max_tokens: 400, temperature: 0.5, reasoning: { effort: 'none' },
      }, {
        Authorization: `Bearer ${config.openrouterKey}`,
        'HTTP-Referer': config.apiBase || 'https://ndxstoreid.vercel.app',
        'X-Title': 'NDXStore WA Bot',
      }, 15000, signal);
      if (signal?.aborted) return null;
      if (r && !/^SKIP\b/.test(r)) {
        const reply = varyReply(jid, trimReply(r, mode), mode);
        saveExchange(jid, text || '[gambar]', reply, senderName, isGroup);
        return reply;
      }
    }
  }

  // 4. Vision endpoints (sequential — Pollinations, backup).
  const backupBase = config.aiApiBackup?.replace(/\/+$/, '');
  const pollVision = `${(config.aiApiBase || '').replace(/\/+$/, '')}/openai`;
  const visionUrls = [
    pollVision,
    'https://text.pollinations.ai/openai',
  ].filter(u => typeof u === 'string' && /^https?:\/\//.test(u) && u !== '/openai');
  if (backupBase) visionUrls.push(`${backupBase}/chat/completions`);
  const seen = new Set();
  for (const url of visionUrls) {
    if (signal?.aborted) return null;
    if (seen.has(url)) continue;
    seen.add(url);
    const rRaw = await tryFetch(url, {
      model: config.aiModel || 'openai',
      messages: msgs, max_tokens: 400, temperature: 0.5,
    }, {}, 20000, signal);
    if (signal?.aborted) return null;
    if (rRaw) {
      if (/^SKIP\b/.test(rRaw)) continue;
      const r = varyReply(jid, trimReply(rRaw, mode), mode);
      saveExchange(jid, text || '[gambar]', r, senderName, isGroup);
      return r;
    }
  }

  if (signal?.aborted) return null;
  const textOnly = await askAI(jid, text || '[gambar]', mode, senderName, isGroup, signal);
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
  const groqUrl = config.groqUrl || 'https://api.groq.com/openai/v1/chat/completions';
  const groqHeaders = { Authorization: `Bearer ${config.groqKey}` };
  const pollBase = (config.aiApiBase || '').replace(/\/+$/, '');

  // 1. Try Groq
  if (config.groqKey?.startsWith('gsk_')) {
    for (const groqModel of ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant']) {
      const result = await tryFetch(groqUrl, { model: groqModel, ...opts }, groqHeaders, 10000);
      if (result) return result;
    }
  }

  // 2. Fallback to Google Gemini
  if (config.geminiKey) {
    const gemModel = config.geminiModel || 'gemini-3.5-flash-lite';
    const gemResult = await tryFetch(
      config.geminiUrl,
      { model: gemModel, ...opts },
      { Authorization: `Bearer ${config.geminiKey}` },
      10000,
    );
    if (gemResult) return gemResult;
  }

  // 3. Fallback to OpenRouter
  if (config.openrouterKey?.startsWith('sk-or-')) {
    const orModel = config.openrouterModel || 'nvidia/nemotron-3-super-120b-a12b:free';
    const orResult = await tryFetch(
      config.openrouterUrl,
      { model: orModel, ...opts, reasoning: { effort: 'none' } },
      {
        Authorization: `Bearer ${config.openrouterKey}`,
        'HTTP-Referer': config.apiBase || 'https://ndxstoreid.vercel.app',
        'X-Title': 'NDXStore WA Bot',
      },
      10000,
    );
    if (orResult) return orResult;
  }

  // 4. Fallback to Pollinations & Backup API
  const candidates = [
    ...(pollBase ? [{ url: `${pollBase}/openai`, body: { model: config.aiModel || 'openai', ...opts }, headers: {}, timeout: 10000 }] : []),
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

// ─── Audio Transcription (Groq Whisper + Gemini Fallback) ───────────────

export async function transcribeAudio(base64Data, mimeType) {
  if (!base64Data) return null;

  // 1. Primary: Groq Whisper
  if (config.groqKey?.startsWith('gsk_')) {
    try {
      const buf = Buffer.from(base64Data, 'base64');
      const ext = mimeType?.includes('ogg') ? 'ogg' : mimeType?.includes('mp4') ? 'm4a' : 'webm';
      const form = new FormData();
      form.append('model', 'whisper-large-v3');
      form.append('language', 'id');
      form.append('file', new Blob([buf], { type: mimeType || 'audio/ogg' }), `audio.${ext}`);
      const resp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.groqKey}` },
        body: form,
        signal: AbortSignal.timeout(25000),
      });
      if (resp.ok) {
        const data = await resp.json();
        const text = data.text?.trim();
        if (text) {
          logger.info('AI', `Transcribed via Whisper (${text.length} chars): ${text.slice(0, 80)}`);
          return text;
        }
      } else {
        const err = await resp.text().catch(() => '');
        logger.warn('AI', 'Whisper failed, trying Gemini audio fallback:', err.slice(0, 100));
      }
    } catch (e) {
      logger.warn('AI', 'Whisper error, trying Gemini audio fallback:', e.message?.slice(0, 100));
    }
  }

  // 2. Fallback: Google Gemini Multimodal Audio Transcription
  if (config.geminiKey) {
    try {
      const format = mimeType?.includes('ogg') ? 'ogg' : mimeType?.includes('mp4') ? 'mp4' : 'wav';
      const gemModel = config.geminiModel || 'gemini-3.5-flash-lite';
      const resp = await fetch(config.geminiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.geminiKey}`,
        },
        body: JSON.stringify({
          model: gemModel,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Transkripsikan pesan suara ini ke teks bahasa Indonesia apa adanya tanpa tambahan komentar apa pun.' },
                { type: 'input_audio', input_audio: { data: base64Data, format } },
              ],
            },
          ],
          max_tokens: 300,
          temperature: 0.1,
        }),
        signal: AbortSignal.timeout(25000),
      });
      if (resp.ok) {
        const data = await resp.json();
        const text = sanitizeAiOutput(data?.choices?.[0]?.message?.content);
        if (text) {
          logger.info('AI', `Transcribed via Gemini (${text.length} chars): ${text.slice(0, 80)}`);
          return text;
        }
      }
    } catch (e) {
      logger.error('AI', 'Gemini audio transcription error:', e.message?.slice(0, 100));
    }
  }

  return null;
}

