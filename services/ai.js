import { config } from '../config.js';

const MODEL = config.aiModel || 'openai';

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

async function callAI(body) {
  const url = `${config.aiApiBase.replace(/\/+$/, '')}/openai`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) {
    const err = await resp.text();
    console.error(`[AI] ${url} error ${resp.status}:`, err.slice(0, 200));
    return null;
  }
  const data = await resp.json();
  return data?.choices?.[0]?.message?.content?.trim() || null;
}

export async function askAI(jid, message) {
  if (!message?.trim()) return '...';

  const userHist = getHistory(jid);
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];

  const recent = userHist.slice(-CONTEXT_SIZE);
  for (const m of recent) messages.push(m);
  messages.push({ role: 'user', content: message });

  const body = { model: MODEL, messages, max_tokens: 200, temperature: 0.9 };

  const reply = await callAI(body);
  if (reply) {
    addHistory(jid, 'user', message);
    addHistory(jid, 'assistant', reply);
    return reply;
  }

  console.error('[AI] API failed');
  return 'Error, coba lagi ya.';
}
