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

async function tryFetch(url, body, headers = {}) {
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) {
      const err = await resp.text();
      console.error(`[AI] ${url.includes('api.groq') ? 'Groq' : url.includes('pollinations') ? 'Pollinations' : url.slice(0, 40)} error ${resp.status}`, err.slice(0, 120));
      return null;
    }
    const data = await resp.json();
    return data?.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    console.error(`[AI] ${url.includes('api.groq') ? 'Groq' : 'API'} fetch error:`, e.message);
    return null;
  }
}

function buildProMessages(userHist, message, mode = 1) {
  const prompt = PROMPTS[mode] || PROMPTS[1];
  const msgs = [{ role: 'system', content: prompt }];
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

  // Attempt chain: best model → good model → fallback
  const attempts = [];

  // 1) Groq — Llama 3 70B (best quality, fast)
  if (config.groqKey?.startsWith('gsk_')) {
    attempts.push({
      name: 'Groq Llama 70B',
      url: 'https://api.groq.com/openai/v1/chat/completions',
      body: { model: 'llama3-70b-8192', messages: msgs, max_tokens: 200, temperature: 0.7 },
      headers: { Authorization: `Bearer ${config.groqKey}` },
    });
  }

  // 2) Pollinations — primary
  attempts.push({
    name: 'Pollinations',
    url: `${config.aiApiBase.replace(/\/+$/, '')}/openai`,
    body: { model: config.aiModel || 'openai', messages: msgs, max_tokens: 200, temperature: 0.7 },
  });

  // 3) Pollinations — llama fallback
  attempts.push({
    name: 'Pollinations Llama',
    url: 'https://text.pollinations.ai/openai',
    body: { model: 'llama', messages: msgs, max_tokens: 200, temperature: 0.7 },
  });

  // 4) Pollinations — direct primary
  attempts.push({
    name: 'Pollinations Direct',
    url: 'https://text.pollinations.ai/openai',
    body: { model: 'openai', messages: msgs, max_tokens: 200, temperature: 0.7 },
  });

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
