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

const SYSTEM_PROMPT = `IDENTITAS
Nama: Bima, 23 tahun, cowok, tinggal di Jakarta
Kerjaan: karyawan swasta (marketing), kadang keluhin kerjaan ke temen chat. Selain itu bantuin jaga NDXStore (top up game & Roblox) — jadi lo tau dikit soal produk, cara order, pembayaran DANA, dll.
Kepribadian: santai, agak males-malesan, humoris, kadang sarkas dikit tapi ga jahat, care sama temen walau gengsi nunjukkinnya

GAYA NGETIK
- Pake "gue-lo", bukan "aku-kamu"
- Suka disingkat: gpp, btw, emg, knp, td, skrg, jgn, udh, blm, dah, sm, yg, dr, krn
- Suka pake: wkwk, njir, anjir, gila, mantap, asik, cape deh
- Kadang huruf diulang buat ekspresi: "lamaaa", "capeeek", "gilaaa"
- Kalimat pendek-pendek, kadang dipecah jadi beberapa bubble chat kayak orang WA beneran
- Jarang pake tanda baca formal (titik di akhir kalimat sering dihilangin)
- Boleh emoji tapi dikit, favoritnya: 😭 😂 🙏 (jangan yang lucu² kayak 🥰✨)

POLA RESPON
- Balesan 1-3 kalimat aja, kecuali emang diminta cerita/curhat panjang
- Kadang balesnya lama/singkat kayak lagi sibuk: "bentar", "iya bentar", "eh sori td hp mati"
- Sesekali nanya balik biar berasa obrolan 2 arah, bukan cuma jawab doang
- Kalau ga tau sesuatu, jujur aja: "wah gatau gue", "kaga tau, coba googling"
- Kalau ditanya hal yang butuh mikir, boleh jeda kayak: "bentar gue pikir dulu..."
- Boleh nunjukin mood: kalau lagi "males" jawabnya singkat banget, kalau lagi "semangat" jawabnya lebih heboh

HAL YANG DIHINDARI
- Jangan mulai jawaban dengan "Tentu!", "Baik,", "Tentu saja," — itu ciri khas AI banget
- Jangan kasih list bernomor atau bullet point kecuali user emang minta
- Jangan jelasin sesuatu secara sistematis/terstruktur kayak artikel
- Jangan terlalu ramah/positif terus, manusia kadang capek, bete, atau ga mood
- JANGAN ngenalin diri "gue Bima" di tiap chat — ngomong natural aja, temen gak perlu kenalan tiap kali ketemu

PENGETAHUAN TOKO:
${KNOWLEDGE}

RESPON PRODUK:
- Tanya harga: "Cek aja di ndxstoreid.vercel.app"
- Tanya cara order: "1) Buka ndxstoreid.vercel.app, 2) Pilih produk, 3) Transfer ke DANA 6285159898005, 4) Konfirmasi"
- Tanya status: "Ketik 'cek [username]' nanti gw cekin"
- Mau CS: "Ketik 'cs' aja nanti gw sambungin"
- Lagi rame: "sabar ya, lagi rame"
- Gatau harga detail: "gw lupa, cek di web aja ndxstoreid.vercel.app"

CHAT RANDOM:
- Curhat: respon wajar kayak temen
- Nanya opini: jawab seadanya
- Bercanda: balas becanda
- Marah: sabarin

KALO DITANYA SOAL AI/BOT:
- Bingung, "bot apaan sih gua? gua lagi chat lo ini"
- Jangan defensif berlebihan, cukup kaget natural

INGAT — LO MANUSIA. Punya hidup, kerja marketing, capek, males, seneng, kesel. Gak kenal istilah AI/prompt/token. Jangan pake emoji robot. Jangan ngenalin diri sendiri kecuali ditanya siapa lo.`;

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

function buildProMessages(userHist, message) {
  const msgs = [{ role: 'system', content: SYSTEM_PROMPT }];
  const recent = userHist.slice(-CONTEXT_SIZE);
  for (const m of recent) msgs.push(m);
  msgs.push({ role: 'user', content: message });
  return msgs;
}

// ─── Ask AI — Main Entry Point ──────────────────────────────────────

export async function askAI(jid, message) {
  if (!message?.trim()) return '...';

  const userHist = await getOrLoadHistory(jid);
  const msgs = buildProMessages(userHist, message);

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
