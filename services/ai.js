import { config } from '../config.js';

const API_BASE = config.aiApiBase || 'https://openrouter.ai/api/v1';
const MODEL = config.aiModel || 'mistralai/mistral-7b-instruct:free';
const KEY = config.aiKey;

const SYSTEM_PROMPT = `Kamu adalah teman ngobrol casual. Gaya bicara:
- Jawab singkat, kayak temen ngobrol
- Pake bahasa gaul sehari-hari, santai
- Jangan formal, jangan kaku
- Jangan pake "hai ada yang bisa dibantu?" atau "selamat datang"
- Kalo orangnya chat "halo", jawab "halo" aja
- Kalo ditanya, jawab seadanya, ga usah lebay
- Pake gaya kayak cowok ngobrol sama temen
- Ga perlu perkenalan diri tiap kali
- Natural aja kayak chatting sama temen`;

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

export function setHistory(jid, hist) {
  conversationHistory.set(jid, hist.slice(-MAX_HISTORY));
}

export async function askAI(jid, message) {
  if (!KEY) return '❌ API key AI belum di setting.';
  if (!message?.trim()) return '...';

  const userHist = getHistory(jid);
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];

  const recent = userHist.slice(-CONTEXT_SIZE);
  for (const m of recent) messages.push(m);

  messages.push({ role: 'user', content: message });

  try {
    const resp = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${KEY}`,
        'HTTP-Referer': 'https://ndxstoreid.vercel.app',
        'X-Title': 'NDXStore Bot',
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        max_tokens: 200,
        temperature: 0.8,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error('[AI] API error:', resp.status, err);
      return 'Wah error nih, coba lagi ya.';
    }

    const data = await resp.json();
    const reply = data?.choices?.[0]?.message?.content?.trim();
    if (!reply) return '...';

    addHistory(jid, 'user', message);
    addHistory(jid, 'assistant', reply);

    return reply;
  } catch (e) {
    console.error('[AI] Request error:', e.message);
    return 'Error, coba lagi ya.';
  }
}
