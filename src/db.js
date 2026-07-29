const { Pool } = require('pg');

// Pool compartilhado por toda a aplicação, usando o pooler de transação
// (pgbouncer) do Supabase — ver DATABASE_URL no .env.
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Sem isso, um erro numa conexão ociosa do pool (ex: o pooler do Supabase
// fechando uma conexão parada) vira um evento 'error' sem listener no
// EventEmitter do Pool, o que DERRUBA o processo Node inteiro — passa por
// cima até do process.on('uncaughtException') do server.js. Só logar aqui é
// suficiente: o pool cria uma conexão nova sozinho na próxima query.
pool.on('error', (err) => {
  console.error('[db] erro numa conexão ociosa do pool (processo mantido no ar):', err.message);
});

module.exports = { pool };
