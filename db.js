const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Função para criar tabelas se não existirem
async function initDatabase() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Criar tabela de usuários
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                full_name VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Criar tabela de transações
        await client.query(`
            CREATE TABLE IF NOT EXISTS transactions (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id),
                type VARCHAR(20) NOT NULL,
                amount DECIMAL(10, 2) NOT NULL,
                payer_name VARCHAR(255),
                payer_document VARCHAR(20),
                receiver_name VARCHAR(255),
                receiver_pix_key VARCHAR(255),
                transaction_id VARCHAR(100) UNIQUE,
                qr_code TEXT,
                description TEXT,
                status VARCHAR(20) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Criar tabela de chaves PIX
        await client.query(`
            CREATE TABLE IF NOT EXISTS pix_keys (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id),
                key_type VARCHAR(20) NOT NULL,
                key_value VARCHAR(255) NOT NULL,
                holder_name VARCHAR(255) NOT NULL,
                holder_document VARCHAR(20),
                bank_name VARCHAR(100),
                status VARCHAR(20) DEFAULT 'active',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Criar índices
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id)
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status)
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_pix_keys_user ON pix_keys(user_id)
        `);

        await client.query('COMMIT');
        console.log('✅ Tabelas criadas com sucesso!');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Erro ao criar tabelas:', error);
        throw error;
    } finally {
        client.release();
    }
}

module.exports = { pool, initDatabase };
