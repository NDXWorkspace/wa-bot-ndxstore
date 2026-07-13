import { config } from '../config.js';
import { getDb } from './supabase.js';

const MODEL = config.aiModel || 'openai';
const API_BASE = config.aiApiBase.replace(/\/+$/, '');

const SYSTEM_PROMPT = `Kamu temen ngobrol casual, santai.

ATURAN:
- Jawab singkat, ga usah panjang lebar
- Pake bahasa Indonesia santai anak muda: pake "sih", "deh", "kok", "yah"
- JANGAN ngarumus, jangan nambah-nambahin informasi
- Kalo gak tau jawabannya, bilang "gatau" atau "gak tau deh"
- Kalo chat cuma "halo", jawab "halo" doang
- JANGAN ngomong pake bahasa Inggris kalo gak ditanya
- JANGAN ngejelasin panjang lebar, cukup respon natural kayak chat WA
- Fokus jawab apa yang ditanya doang, jangan ngelantur
- Kalo ditanya opini, bilang seadanya
- JANGAN berpura-pura jadi bot CS atau toko`;

let conversationHistory = new Map();
const MAX_HISTORY = 20;
const CONTEXT_SIZE = 6;

function getHistory(jid) {
  return conversationHistory.get(jid) || [];
}

function addHistory(jid, role, content) {
  const hist = getHistory(jid);
  hist.push({ role, content });
  if (hist.length > MAX_HISTORY) hist.splice(0, hist.length - CONTEXT_SIZE);
  conversationHistory.set(jid, hist);
}

export function clearHistory(jid) {
  conversationHistory.delete(jid);
}

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
    // Table might not exist yet — ignore
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
    conversationHistory.set(jid, hist);
    return hist;
  } catch {
    return [];
  }
}

async function getOrLoadHistory(jid) {
  let hist = getHistory(jid);
  if (hist.length === 0) {
    hist = await loadHistoryFromDb(jid);
  }
  return hist;
}

function maskKey(str) {
  if (!str || str.length < 8) return str;
  return str.slice(0, 4) + '****' + str.slice(-4);
}

async function tryFetch(url, body, headers = {}) {
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    });
    if (!resp.ok) {
      const err = await resp.text();
      const short = url.length > 50 ? url.split('//')[1]?.slice(0, 40) : url;
      console.error(`[AI] ${short} error ${resp.status}:`, err.slice(0, 100));
      return null;
    }
    const data = await resp.json();
    return data?.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    const short = url.length > 50 ? url.split('//')[1]?.slice(0, 40) : url;
    console.error(`[AI] ${short} fetch error:`, e.message);
    return null;
  }
}

function saveExchange(jid, userMsg, reply) {
  addHistory(jid, 'user', userMsg);
  addHistory(jid, 'assistant', reply);
  persistToDb(jid, 'user', userMsg);
  persistToDb(jid, 'assistant', reply);
}

export async function askAI(jid, message) {
  if (!message?.trim()) return '...';

  const userHist = await getOrLoadHistory(jid);
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];

  const recent = userHist.slice(-CONTEXT_SIZE);
  for (const m of recent) messages.push(m);
  messages.push({ role: 'user', content: message });

  const baseBody = { messages, max_tokens: 150, temperature: 0.5 };

  // 1) Pollinations with configured model
  const reply1 = await tryFetch(`${API_BASE}/openai`, { ...baseBody, model: MODEL || 'openai' });
  if (reply1) { saveExchange(jid, message, reply1); return reply1; }

  // 2) Pollinations fallback model llama
  const reply2 = await tryFetch(`${API_BASE}/openai`, { ...baseBody, model: 'llama' });
  if (reply2) { saveExchange(jid, message, reply2); return reply2; }

  // 3) Pollinations direct (bypass configured base)
  const reply3 = await tryFetch('https://text.pollinations.ai/openai', { ...baseBody, model: 'openai' });
  if (reply3) { saveExchange(jid, message, reply3); return reply3; }

  // 4) Groq (if API key configured) — fast & free
  if (config.groqKey) {
    const reply4 = await tryFetch(
      'https://api.groq.com/openai/v1/chat/completions',
      { ...baseBody, model: 'llama3-70b-8192' },
      { Authorization: `Bearer ${config.groqKey}` }
    );
    if (reply4) { saveExchange(jid, message, reply4); return reply4; }
  }

  console.error('[AI] All endpoints failed');
  return null;
}
