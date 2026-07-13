import { config } from '../config.js';

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

async function tryFetch(url, body) {
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) {
      const err = await resp.text();
      console.error(`[AI] ${url.split('//')[1]} error ${resp.status}:`, err.slice(0, 100));
      return null;
    }
    const data = await resp.json();
    return data?.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    console.error(`[AI] ${url.split('//')[1]} fetch error:`, e.message);
    return null;
  }
}

export async function askAI(jid, message) {
  if (!message?.trim()) return '...';

  const userHist = getHistory(jid);
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];

  const recent = userHist.slice(-CONTEXT_SIZE);
  for (const m of recent) messages.push(m);
  messages.push({ role: 'user', content: message });

  const baseBody = { model: MODEL, messages, max_tokens: 150, temperature: 0.5 };

  const endpoints = [
    { url: `${API_BASE}/openai`, body: baseBody },
    { url: 'https://text.pollinations.ai/openai', body: { ...baseBody, model: MODEL || 'openai' } },
    { url: 'https://text.pollinations.ai/openai', body: { ...baseBody, model: 'llama' } },
  ];

  for (const { url, body } of endpoints) {
    const reply = await tryFetch(url, body);
    if (reply) {
      addHistory(jid, 'user', message);
      addHistory(jid, 'assistant', reply);
      return reply;
    }
  }

  console.error('[AI] All endpoints failed');
  return null;
}
