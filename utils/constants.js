export const API_BASE = process.env.API_BASE || 'https://ndxstoreid.vercel.app';

export const PAYMENT_OK_STATUSES = ['SUCCESS', 'PROCESSING'];

export const VALID_ORDER_STATUSES = ['SUCCESS', 'PROCESSING', 'REJECTED', 'PENDING', 'WAITING_PAYMENT'];
