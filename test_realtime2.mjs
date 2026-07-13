import pg from 'pg';

const client = new pg.Client({
  host: 'db.jlfrtyyjxkmdetdbeakv.supabase.co',
  database: 'postgres',
  user: 'postgres',
  password: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpsZnJ0eXlqeGttZGV0ZGJlYWt2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MzM1ODc5MywiZXhwIjoyMDk4OTM0NzkzfQ.nXykeLDd8hVg5dzxDcCPiPsyuyR8hYY-Uc_e2X4rUUA',
  ssl: { rejectUnauthorized: false },
  port: 6543,
});

try {
  await client.connect();
  const res = await client.query("SELECT schemaname, tablename FROM pg_publication_tables WHERE pubname = 'supabase_realtime'");
  console.log('Tables in publication:', res.rows.map(r => r.tablename));
  
  const hasTransactions = res.rows.some(r => r.tablename === 'transactions');
  if (!hasTransactions) {
    await client.query("ALTER PUBLICATION supabase_realtime ADD TABLE ONLY transactions");
    console.log('Added transactions to supabase_realtime publication');
  } else {
    console.log('transactions already in publication');
  }
  
  await client.end();
} catch(e) {
  console.log('Error:', e.message);
}
