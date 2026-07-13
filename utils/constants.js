export const API_BASE = process.env.API_BASE || 'https://ndxstoreid.vercel.app';

export const PAYMENT_OK_STATUSES = ['SUCCESS', 'PROCESSING'];

export const AI_MODELS = {
  groq: [
    { model: 'llama-3.3-70b-versatile', priority: 1 },
    { model: 'llama-3.1-8b-instant', priority: 2 },
  ],
  pollinations: [
    { model: 'openai', priority: 3 },
    { model: 'llama', priority: 4 },
    { model: 'mistral', priority: 5 },
    { model: 'openai-large', priority: 6 },
  ],
};

export const VALID_ORDER_STATUSES = ['SUCCESS', 'PROCESSING', 'REJECTED', 'PENDING', 'WAITING_PAYMENT'];
