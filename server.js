const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { pool, initDatabase } = require('./db');
const { register, login, authenticateToken } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));
app.use(express.json());

// Inicializar banco de dados ao iniciar
initDatabase().catch(console.error);

// ==================== ROTAS PÚBLICAS ====================

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Backend PixPay funcionando!' });
});

// Registrar novo usuário
app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password, fullName } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email e senha são obrigatórios' });
        }

        const user = await register(email, password, fullName);
        res.json({ success: true, user });
    } catch (error) {
        console.error('Erro ao registrar:', error);
        res.status(400).json({ error: error.message });
    }
});

// Login
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const result = await login(email, password);
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('Erro ao fazer login:', error);
        res.status(401).json({ error: error.message });
    }
});

// ==================== ROTAS PROTEGIDAS ====================

// Criar cobrança PIX
app.post('/api/create-pix', authenticateToken, async (req, res) => {
  try {
    const { valor, descricao, devedor } = req.body;

    if (!valor || valor <= 0) {
      return res.status(400).json({ error: 'Valor inválido' });
    }

    const pixData = {
      valor: parseFloat(valor).toFixed(2),
      calendario: { expiracao: 3600 },
      isDeposit: false,
      referencia: `REF${Date.now()}`,
      solicitacaoPagador: descricao || 'Pagamento via PixPay Cloud',
    };

    if (devedor && devedor.cpf && devedor.nome) {
      pixData.devedor = {
        cpf: devedor.cpf.replace(/\D/g, ''),
        nome: devedor.nome,
      };
    }

    console.log('Criando cobrança PIX:', pixData);

    const response = await fetch('https://api.polopag.com/v1/cobpix', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Key': process.env.POLOPAG_API_KEY,
      },
      body: JSON.stringify(pixData),
    });

    const responseData = await response.json();

    if (!response.ok) {
      console.error('Erro da PoloPag:', responseData);
      return res.status(response.status).json({
        error: responseData.message || 'Erro ao criar cobrança PIX',
        details: responseData,
      });
    }

    console.log('Cobrança criada com sucesso:', responseData);

    // Salvar no banco de dados
    await pool.query(
        'INSERT INTO transactions (user_id, type, amount, payer_name, payer_document, receiver_name, transaction_id, qr_code, description, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [
            req.user.userId,
            'received',
            parseFloat(valor),
            devedor?.nome || null,
            devedor?.cpf || null,
            pixData.solicitacaoPagador,
            responseData.txid,
            responseData.pixCopiaECola,
            descricao,
            'pending'
        ]
    );

    res.json({
      success: true,
      data: {
        txid: responseData.txid,
        qrCodeBase64: responseData.qrcodeBase64,
        pixCopiaECola: responseData.pixCopiaECola,
        valor: responseData.valor,
        status: responseData.status,
      },
    });
  } catch (error) {
    console.error('Erro no servidor:', error);
    res.status(500).json({
      error: 'Erro interno do servidor',
      message: error.message,
    });
  }
});

// Verificar status do pagamento
app.get('/api/check-pix/:txid', authenticateToken, async (req, res) => {
  try {
    const { txid } = req.params;

    if (!txid) {
      return res.status(400).json({ error: 'TXID não fornecido' });
    }

    console.log('Verificando status do PIX:', txid);

    const response = await fetch(`https://api.polopag.com/v1/check-pix/${txid}`, {
      method: 'GET',
      headers: {
        'Api-Key': process.env.POLOPAG_API_KEY,
      },
    });

    const statusData = await response.json();

    if (!response.ok) {
      console.error('Erro ao verificar status:', statusData);
      return res.status(response.status).json({
        error: statusData.message || 'Erro ao verificar pagamento',
        details: statusData,
      });
    }

    console.log('Status verificado:', statusData);

    // Atualizar status no banco se foi pago
    if (statusData.status === 'APROVADO') {
        await pool.query(
            'UPDATE transactions SET status = $1 WHERE transaction_id = $2',
            ['completed', txid]
        );
    }

    res.json({
      success: true,
      data: {
        status: statusData.status,
        isPaid: statusData.status === 'APROVADO',
        ...statusData,
      },
    });
  } catch (error) {
    console.error('Erro ao verificar status:', error);
    res.status(500).json({
      error: 'Erro interno do servidor',
      message: error.message,
    });
  }
});

// ==================== ROTAS CORRIGIDAS ====================

// Listar transações do usuário
app.get('/api/transactions', authenticateToken, async (req, res) => {
    try {
        console.log(`📊 Buscando transações do usuário ${req.user.userId}`);

        const result = await pool.query(
            'SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC',
            [req.user.userId]
        );

        console.log(`✅ Encontradas ${result.rows.length} transações`);

        // ✅ CORRIGIDO: Retornar array direto (compatível com frontend)
        res.json(result.rows);
    } catch (error) {
        console.error('❌ Erro ao listar transações:', error);
        res.status(500).json({ error: error.message });
    }
});

// Obter saldo
app.get('/api/balance', authenticateToken, async (req, res) => {
    try {
        console.log(`💰 Calculando saldo do usuário ${req.user.userId}`);

        const result = await pool.query(
            `SELECT
                SUM(CASE WHEN type = 'received' AND status = 'completed' THEN amount ELSE 0 END) as received,
                SUM(CASE WHEN type = 'sent' AND status = 'completed' THEN amount ELSE 0 END) as sent,
                COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_count
            FROM transactions
            WHERE user_id = $1`,
            [req.user.userId]
        );

        const received = parseFloat(result.rows[0].received || 0);
        const sent = parseFloat(result.rows[0].sent || 0);
        const balance = received - sent;
        const pendingTransactions = parseInt(result.rows[0].pending_count || 0);

        const balanceData = {
            balance: parseFloat(balance.toFixed(2)),
            totalReceived: parseFloat(received.toFixed(2)),
            totalSent: parseFloat(sent.toFixed(2)),
            pendingTransactions: pendingTransactions
        };

        console.log('✅ Saldo calculado:', balanceData);

        // ✅ CORRIGIDO: Retornar objeto direto (compatível com frontend)
        res.json(balanceData);
    } catch (error) {
        console.error('❌ Erro ao obter saldo:', error);
        res.status(500).json({ error: error.message });
    }
});

// Listar chaves PIX do usuário
app.get('/api/pix-keys', authenticateToken, async (req, res) => {
    try {
        console.log(`🔑 Listando chaves PIX do usuário ${req.user.userId}`);

        const result = await pool.query(
            'SELECT * FROM pix_keys WHERE user_id = $1 ORDER BY created_at DESC',
            [req.user.userId]
        );

        console.log(`✅ Encontradas ${result.rows.length} chaves PIX`);

        // ✅ CORRIGIDO: Retornar array direto (compatível com frontend)
        res.json(result.rows);
    } catch (error) {
        console.error('❌ Erro ao listar chaves PIX:', error);
        res.status(500).json({ error: error.message });
    }
});

// Adicionar chave PIX
app.post('/api/pix-keys', authenticateToken, async (req, res) => {
    try {
        console.log('📥 Backend recebeu req.body:', req.body);
        console.log('📥 Content-Type:', req.headers['content-type']);

        // ✅ CORRIGIDO: Usar snake_case (key_type, key_value) ao invés de camelCase (keyType, keyValue)
        const { key_type, key_value, holder_name, holder_document, bank_name, status } = req.body;

        console.log('📋 Dados extraídos:', {
            key_type,
            key_value,
            holder_name,
            holder_document,
            bank_name,
            status
        });

        // Validação
        if (!key_type || !key_value) {
            console.error('❌ Validação falhou: campos ausentes');
            return res.status(400).json({
                error: 'Campos obrigatórios ausentes',
                details: {
                    key_type: key_type ? 'ok' : 'ausente',
                    key_value: key_value ? 'ok' : 'ausente'
                }
            });
        }

        const result = await pool.query(
            'INSERT INTO pix_keys (user_id, key_type, key_value, holder_name, holder_document, bank_name, status) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
            [
                req.user.userId,
                key_type,
                key_value,
                holder_name || 'Usuario',
                holder_document || '00000000000',
                bank_name || 'PoloPag',
                status || 'active'
            ]
        );

        console.log('✅ Chave PIX criada com sucesso:', result.rows[0]);

        // ✅ CORRIGIDO: Retornar no formato esperado pelo frontend
        res.status(201).json({
            success: true,
            data: result.rows[0]
        });
    } catch (error) {
        console.error('❌ Erro ao adicionar chave PIX:', error);
        console.error('Stack:', error.stack);
        res.status(500).json({ error: error.message });
    }
});

// Deletar chave PIX
app.delete('/api/pix-keys/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;

        console.log(`🗑️ Deletando chave PIX ${id} do usuário ${req.user.userId}`);

        // Verificar se a chave pertence ao usuário
        const checkResult = await pool.query(
            'SELECT * FROM pix_keys WHERE id = $1 AND user_id = $2',
            [id, req.user.userId]
        );

        if (checkResult.rows.length === 0) {
            return res.status(404).json({ error: 'Chave não encontrada ou não pertence ao usuário' });
        }

        await pool.query(
            'DELETE FROM pix_keys WHERE id = $1 AND user_id = $2',
            [id, req.user.userId]
        );

        console.log(`✅ Chave PIX ${id} deletada com sucesso`);

        res.json({ success: true, message: 'Chave PIX removida com sucesso' });
    } catch (error) {
        console.error('❌ Erro ao deletar chave PIX:', error);
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
  console.log(`🚀 Backend PixPay rodando na porta ${PORT}`);
  console.log(`📍 Endpoint: http://localhost:${PORT}`);
  console.log(`✅ Health check: http://localhost:${PORT}/health`);
});
