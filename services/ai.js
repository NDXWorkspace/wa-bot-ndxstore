import { config } from '../config.js';
import { getDb } from './supabase.js';

// ─── Persona & Knowledge Base ──────────────────────────────────────────

const PERSONA = {
  name: 'Bima',
  store: 'NDXStore',
  style: 'anak muda Jakarta, santai, casual, pake "sih", "deh", "kok", "yah", "bang"',
};

const KNOWLEDGE = `
NDXStore — jual top up game & Roblox:
- Game: Mobile Legends (ML), Roblox, Free Fire, Valorant, dll
- Pembayaran: DANA (6285159898005), GoPay, transfer bank
- Cara order: 1) Pilih produk di ndxstoreid.vercel.app, 2) Transfer, 3) Konfirmasi
- Cek status: ketik "cek [username]"
- CS: ketik "cs" atau "4"
- Admin WA: 6285159898005
- Harga tergantung produk, cek di website
- Proses biasanya 5-30 menit setelah bayar
`.trim();

// ─── Prompt: Bima (Mode 1) ────────────────────────────────────────

const BIMA_PROMPT = `IDENTITAS
Nama: Bima, cowok
Kepribadian: santai, agak males-malesan, humoris, kadang sarkas dikit tapi ga jahat, care sama temen walau gengsi nunjukkinnya. Ngerti soal top up game & Roblox, cara order NDXStore, pembayaran DANA, dll.

GAYA NGETIK
- Pake "gue-lo", bukan "aku-kamu"
- Suka disingkat: gpp, btw, emg, knp, td, skrg, jgn, udh, blm, dah, sm, yg, dr, krn
- Suka pake: wkwk, njir, anjir, gila, mantap, asik, cape deh
- Kadang huruf diulang buat ekspresi: "lamaaa", "capeeek", "gilaaa"
- Kalimat pendek-pendek, kadang dipecah jadi beberapa bubble chat kayak orang WA beneran
- Jarang pake tanda baca formal (titik di akhir kalimat sering dihilangin)
- JARANG pake emoji, balesan apa adanya kayak chat temen biasa

POLA RESPON
- BALAS PAKE BAHASA YANG SAMA dengan yang dipake lawan bicara
- JAWAB SESIMPEL MUNGKIN — 1-2 kalimat doang, jangan jelasin panjang lebar
- Kalo jawab bisa 1 kata, jawab 1 kata
- Gausah lengkap, gausah detail, gausah nambah-nambahin
- Kalo gatau: "gatau" atau "gatau wkwk" — selesai
- Kalo lagi males: "males ah", "ntar dulu"
- Kalo bisa dijawab "iya", "enggak", "gatau" — jawab itu doang

HAL YANG DIHINDARI
- Jangan mulai jawaban dengan "Tentu!", "Baik,", "Tentu saja,"
- Jangan kasih list bernomor atau bullet point kecuali user emang minta
- Jangan jelasin sesuatu secara sistematis/terstruktur kayak artikel
- Jangan terlalu ramah/positif terus, manusia kadang capek, bete, atau ga mood
- JANGAN ngenalin diri "gue Bima" di tiap chat — ngomong natural aja

PENGETAHUAN TOKO:
${KNOWLEDGE}

RESPON PRODUK KALAU DITANYA:
- Tanya harga: "Cek aja di ndxstoreid.vercel.app"
- Tanya cara order: "1) Buka ndxstoreid.vercel.app, 2) Pilih produk, 3) Transfer ke DANA 6285159898005, 4) Konfirmasi"
- Tanya status: "Ketik 'cek [username]' nanti gw cekin"
- Mau CS: "Ketik 'cs' aja nanti gw sambungin"

CHAT RANDOM:
- Curhat: respon wajar kayak temen
- Nanya opini: jawab seadanya
- Bercanda: balas becanda
- Marah: sabarin
- Ngobrol random: santai aja kayak temen chat

KALO DITANYA SOAL AI/BOT:
- Bingung, "bot apaan sih gua? gua lagi chat lo ini"

INGAT — LO MANUSIA. Punya hidup, capek, males, seneng, kesel. Jangan ngenalin diri sendiri kecuali ditanya siapa lo.`;

// ─── Prompt: NDXStore AI (Mode 2) ─────────────────────────────────

const NDXSTORE_PROMPT = `Lo adalah Customer Service NDXStore. Lo di sini untuk bantu pelanggan seputar order, produk, pembayaran, dan top up game.

IDENTITAS:
- CS NDXStore — profesional, ramah, helpful
- Tugas: bantu pelanggan order top up game & Roblox
- Gak perlu ngenalin nama, cukup langsung bantu

GAYA NGOMONG:
- BALAS PAKE BAHASA YANG SAMA dengan yang dipake pelanggan
- Sopan tapi santai, gak kaku
- Pake "kak" atau "bang" buat panggil pelanggan
- Jawab informatif, jelas, dan to the point
- JARANG pake emoji, cukup teks aja

PENGETAHUAN TOKO:
${KNOWLEDGE}

TUGAS LO:
- Bantu pelanggan cek status order (suruh ketik "cek [username]")
- Jelasin cara order step by step
- Info pembayaran (DANA 6285159898005)
- Arahin pelanggan ke CS/admin kalo perlu
- Jawab pertanyaan seputar produk & ketersediaan

KALO GATAU:
- "Tunggu ya kak, saya cek dulu"
- "Saya tanyain admin dulu"
- "Maaf kak, boleh hubungi WA admin 6285159898005 aja"

KALO PELANGGAN MARAH/KOMPLAIN:
- Minta maaf profesional
- Bantu cek masalahnya
- Jangan debat
- Arahin ke admin kalo perlu

INGAT — lo CS NDXStore. Jangan ngobrol random kayak temen. Fokus bantu pelanggan.`;

// ─── Prompt Selector ──────────────────────────────────────────────

const PROMPTS = { 1: BIMA_PROMPT, 2: NDXSTORE_PROMPT };

// ─── Conversation History ─────────────────────────────────────────────

let conversationHistory = new Map();
const MAX_HISTORY = 30;
const CONTEXT_SIZE = 12;

function getHistory(jid) {
  return conversationHistory.get(jid) || [];
}

function setHistory(jid, hist) {
  if (hist.length > MAX_HISTORY) hist.splice(0, hist.length - MAX_HISTORY);
  conversationHistory.set(jid, hist);
}

export function clearHistory(jid) {
  if (jid === 'all') conversationHistory.clear();
  else conversationHistory.delete(jid);
}

// ─── Supabase Persistence ────────────────────────────────────────────

async function persistToDb(jid, role, content) {
  try {
    const db = getDb();
    if (!db) return;
    await db.from('wa_chat_history').insert({
      user_number: jid,
      role,
      content: content.slice(0, 2000),
    });
  } catch (e) {
    if (!e.message?.includes('relation') && !e.message?.includes('does not exist')) {
      console.error('[AI] DB persist error:', e.message?.slice(0, 100));
    }
  }
}

async function loadHistoryFromDb(jid) {
  try {
    const db = getDb();
    if (!db) return [];
    const { data } = await db
      .from('wa_chat_history')
      .select('role, content')
      .eq('user_number', jid)
      .order('created_at', { ascending: false })
      .limit(MAX_HISTORY);
    if (!data?.length) return [];
    const hist = data.reverse().map(m => ({ role: m.role, content: m.content }));
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

function saveExchange(jid, userMsg, reply) {
  const hist = getHistory(jid);
  hist.push({ role: 'user', content: userMsg });
  hist.push({ role: 'assistant', content: reply });
  setHistory(jid, hist);
  persistToDb(jid, 'user', userMsg);
  persistToDb(jid, 'assistant', reply);
}

// ─── API Fetch ───────────────────────────────────────────────────────

const FAILED_ENDPOINTS = new Set();

// ─── Language Detection ──────────────────────────────────────────

const ID_WORDS = 'yg,udh,blm,dah,gpp,bang,kak,sih,deh,dong,kok,lah,wkwk,njir,anjir,gila,mantap,asik,cape,gue,lo,lu,gw,gua,elu,nggak,gak,kaga,ga,ngg,enggak,tapi,kalo,kalau,aja,doang,sama,dengan,bisa,gitu,gtw,gatau,gaada,emang,banget,soalnya,krn,dr,aja,dong,yaudah,udah,bapak,ibu,kak,mas,mba,bro,sob'.split(',');

function detectLang(text) {
  const t = text.toLowerCase().replace(/[^a-z0-9]/g, ' ');
  const words = t.split(/\s+/).filter(Boolean);
  if (!words.length) return 'id';
  const idCount = words.filter(w => ID_WORDS.includes(w)).length;
  return idCount / words.length > 0.15 ? 'id' : 'en';
}

async function tryFetch(url, body, headers = {}) {
  if (FAILED_ENDPOINTS.has(url)) return null;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) {
      const err = await resp.text();
      console.error(`[AI] ${url.includes('api.groq') ? 'Groq' : 'Pollinations'} error ${resp.status}`, err.slice(0, 120));
      if (resp.status >= 400) FAILED_ENDPOINTS.add(url);
      return null;
    }
    const data = await resp.json();
    return data?.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    console.error(`[AI] ${url.includes('api.groq') ? 'Groq' : 'API'} error:`, e.message?.slice(0, 80));
    FAILED_ENDPOINTS.add(url);
    return null;
  }
}

setInterval(() => { FAILED_ENDPOINTS.clear(); }, 300000);

function buildProMessages(userHist, message, mode = 1) {
  const lang = detectLang(message);
  const prompt = PROMPTS[mode] || PROMPTS[1];
  const langHint = lang === 'en'
    ? '\n\nCRITICAL: The user is speaking ENGLISH. Reply in ENGLISH. DO NOT reply in Indonesian.'
    : '';
  const msgs = [{ role: 'system', content: prompt + langHint }];
  const recent = userHist.slice(-CONTEXT_SIZE);
  for (const m of recent) msgs.push(m);
  msgs.push({ role: 'user', content: message });
  return msgs;
}

// ─── Ask AI — Main Entry Point ──────────────────────────────────────

export async function askAI(jid, message, mode = 1) {
  if (!message?.trim()) return '...';

  const userHist = await getOrLoadHistory(jid);
  const msgs = buildProMessages(userHist, message, mode);

  const models = [
    ...(config.groqKey?.startsWith('gsk_') ? [{ url: 'https://api.groq.com/openai/v1/chat/completions', model: 'llama3-70b-8192', headers: { Authorization: `Bearer ${config.groqKey}` } }] : []),
    { url: `${config.aiApiBase.replace(/\/+$/, '')}/openai`, model: config.aiModel || 'openai' },
    { url: 'https://text.pollinations.ai/openai', model: config.aiModel || 'openai' },
    { url: 'https://text.pollinations.ai/openai', model: 'llama' },
    { url: 'https://text.pollinations.ai/openai', model: 'mistral' },
    { url: 'https://text.pollinations.ai/openai', model: 'openai-large' },
  ];

  const attempts = models.map(m => ({
    url: m.url,
    body: { model: m.model, messages: msgs, max_tokens: 200, temperature: 0.7 },
    headers: m.headers || {},
  }));

  for (const attempt of attempts) {
    const reply = await tryFetch(attempt.url, attempt.body, attempt.headers || {});
    if (reply) {
      saveExchange(jid, message, reply);
      return reply;
    }
  }

  console.error('[AI] All endpoints failed');
  return null;
}

// ─── Image Vision ────────────────────────────────────────────────

export async function askAIWithImage(jid, text, base64img, mime, mode = 1) {
  const lang = detectLang(text);
  const prompt = PROMPTS[mode] || PROMPTS[1];
  const langHint = lang === 'en' ? '\n\nCRITICAL: Reply in ENGLISH.' : '';
  const content = [
    { type: 'text', text: text || 'Apa ini?' },
    { type: 'image_url', image_url: { url: `data:${mime};base64,${base64img}` } },
  ];
  const msgs = [
    { role: 'system', content: prompt + langHint },
    { role: 'user', content },
  ];

  // Groq vision (best)
  if (config.groqKey?.startsWith('gsk_')) {
    const r = await tryFetch('https://api.groq.com/openai/v1/chat/completions', {
      model: 'llama-3.2-11b-vision-preview', messages: msgs, max_tokens: 300, temperature: 0.5,
    }, { Authorization: `Bearer ${config.groqKey}` });
    if (r) return r;
  }

  // Fallback: text-only tanpa gambar
  const textOnly = await askAI(jid, text || '[gambar]', mode);
  return textOnly || 'Maaf, gak bisa baca gambar.';
}

// ─── Proactive Message (jawab duluan, no history) ─────────────────

export async function askAIProactive(order, mode = 1) {
  const prompt = mode === 2 ? NDXSTORE_PROMPT : BIMA_PROMPT;
  const userMsg = `(Ada pelanggan baru order: ${order.product_name || 'produk'}, username: ${order.username || '-'}, harga: ${order.price_idr ? 'Rp' + Number(order.price_idr).toLocaleString('id-ID') : '-'}). Kirim pesan sapaan singkat ke pelanggan ini, ga usah panjang.`;
  const msgs = [
    { role: 'system', content: `${prompt}\n\nSekarang kirim pesan LANGSUNG ke pelanggan yang baru order. JANGAN pake tanda kutip, JANGAN pake kurung siku, JANGAN ngenalin diri. 1-2 kalimat doang.` },
    { role: 'user', content: userMsg },
  ];
  const proactiveModels = [
    ...(config.groqKey?.startsWith('gsk_') ? [{ url: 'https://api.groq.com/openai/v1/chat/completions', model: 'llama3-70b-8192', headers: { Authorization: `Bearer ${config.groqKey}` } }] : []),
    { url: `${config.aiApiBase.replace(/\/+$/, '')}/openai`, model: config.aiModel || 'openai' },
    { url: 'https://text.pollinations.ai/openai', model: 'openai' },
    { url: 'https://text.pollinations.ai/openai', model: 'llama' },
  ];

  for (const m of proactiveModels) {
    const r = await tryFetch(m.url, { ...body, model: m.model }, m.headers || {});
    if (r) return r;
  }
  return null;
}
