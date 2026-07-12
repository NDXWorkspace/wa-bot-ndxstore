import { createClient } from '@supabase/supabase-js';

const url = 'https://jlfrtyyjxkmdetdbeakv.supabase.co';
const key = process.env.SUPABASE_KEY || '';

const db = createClient(url, key);

// Test 1: Basic query
console.log('=== Test 1: Basic query ===');
const { data, error } = await db.from('transactions').select('id, product_name, order_status, created_at').order('created_at', { ascending: false }).limit(3);
if (error) { console.log('ERROR:', error.message); process.exit(1); }
console.log('Latest orders:', JSON.stringify(data, null, 2));

// Test 2: Realtime subscription
console.log('\n=== Test 2: Realtime subscription ===');
console.log('Subscribing to transactions INSERT...');

const channel = db
  .channel('test-monitor')
  .on('postgres_changes',
    { event: 'INSERT', schema: 'public', table: 'transactions' },
    (payload) => {
      console.log('\n>>> REALTIME INSERT RECEIVED:', payload.new.id, payload.new.product_name);
    }
  )
  .subscribe((status) => {
    console.log('Subscription status:', status);
    if (status === 'SUBSCRIBED') {
      console.log('✅ Realtime connected! Waiting for new orders...');
      console.log('Create a new order at https://ndxstoreid.vercel.app to test.');
      console.log('Press Ctrl+C to exit after 30s.');
      setTimeout(() => {
        console.log('\nTimeout - closing channel');
        db.removeChannel(channel);
        process.exit(0);
      }, 30000);
    } else if (status === 'CHANNEL_ERROR') {
      console.log('❌ Realtime connection failed!');
      console.log('Make sure the table is in the realtime publication:');
      console.log('  ALTER PUBLICATION supabase_realtime ADD TABLE transactions;');
      process.exit(1);
    }
  });
