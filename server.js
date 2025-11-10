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

// Criar cobrança PIX (RECEBER)
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
    if (statusData.status === 'APROVADO' || statusData.status === 'CONCLUIDA') {
        console.log('💰 PIX foi pago! Atualizando status no banco...');

        const updateResult = await pool.query(
            'UPDATE transactions SET status = $1 WHERE transaction_id = $2 RETURNING *',
            ['completed', txid]
        );

        if (updateResult.rowCount > 0) {
            console.log('✅ Status atualizado no banco:', updateResult.rows[0]);
        } else {
            console.warn('⚠️ Nenhuma transação foi atualizada. TXID pode não existir:', txid);
        }
    }

    res.json({
      success: true,
      data: {
        status: statusData.status,
        isPaid: statusData.status === 'APROVADO' || statusData.status === 'CONCLUIDA',
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

        res.json(result.rows);
    } catch (error) {
        console.error('❌ Erro ao listar transações:', error);
        res.status(500).json({ error: error.message });
    }
});

// ✅ CORRIGIDO: Obter saldo com taxa R$ 0,20 POR TRANSAÇÃO
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
        const pendingTransactions = parseInt(result.rows[0].pending_count || 0);

        // ✅ Calcular taxa PoloPag: R$ 0,20 FIXO por transação RECEBIDA
        const transactionsResult = await pool.query(
            `SELECT COUNT(*) as count FROM transactions
             WHERE user_id = $1 AND type = 'received' AND status = 'completed'`,
            [req.user.userId]
        );

        const TAXA_POLOPAG_POR_TRANSACAO = 0.20; // R$ 0,20 fixo
        const quantidadeTransacoesRecebidas = parseInt(transactionsResult.rows[0].count || 0);
        const totalTaxas = quantidadeTransacoesRecebidas * TAXA_POLOPAG_POR_TRANSACAO;

        const balance = received - sent - totalTaxas;

        const balanceData = {
            balance: parseFloat(balance.toFixed(2)),
            totalReceived: parseFloat(received.toFixed(2)),
            totalSent: parseFloat(sent.toFixed(2)),
            pendingTransactions: pendingTransactions,
            taxaPoloPag: parseFloat(totalTaxas.toFixed(2))
        };

        console.log('✅ Saldo calculado:', balanceData);
        console.log(`📊 ${quantidadeTransacoesRecebidas} transações recebidas × R$ 0,20 = R$ ${totalTaxas.toFixed(2)} em taxas`);

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

        const { key_type, key_value, holder_name, holder_document, bank_name, status } = req.body;

        if (!key_type || !key_value) {
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

        console.log('✅ Chave PIX criada:', result.rows[0]);

        res.status(201).json({
            success: true,
            data: result.rows[0]
        });
    } catch (error) {
        console.error('❌ Erro ao adicionar chave PIX:', error);
        res.status(500).json({ error: error.message });
    }
});

// Deletar chave PIX
app.delete('/api/pix-keys/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;

        const checkResult = await pool.query(
            'SELECT * FROM pix_keys WHERE id = $1 AND user_id = $2',
            [id, req.user.userId]
        );

        if (checkResult.rows.length === 0) {
            return res.status(404).json({ error: 'Chave não encontrada' });
        }

        await pool.query(
            'DELETE FROM pix_keys WHERE id = $1 AND user_id = $2',
            [id, req.user.userId]
        );

        console.log(`✅ Chave PIX ${id} deletada`);

        res.json({ success: true });
    } catch (error) {
        console.error('❌ Erro ao deletar chave PIX:', error);
        res.status(500).json({ error: error.message });
    }
});

// ✅ NOVA FUNCIONALIDADE: Enviar PIX (SAQUE)
app.post('/api/send-pix', authenticateToken, async (req, res) => {
    try {
        const { valor, chave_pix, tipo_chave, descricao } = req.body;

        console.log('💸 Solicitação de saque PIX:', { valor, chave_pix, tipo_chave });

        // Validações
        if (!valor || valor <= 0) {
            return res.status(400).json({ error: 'Valor inválido' });
        }

        if (!chave_pix || !tipo_chave) {
            return res.status(400).json({ error: 'Chave PIX não fornecida' });
        }

        // Verificar saldo do usuário
        const balanceResult = await pool.query(
            `SELECT
                SUM(CASE WHEN type = 'received' AND status = 'completed' THEN amount ELSE 0 END) as received,
                SUM(CASE WHEN type = 'sent' AND status = 'completed' THEN amount ELSE 0 END) as sent
            FROM transactions
            WHERE user_id = $1`,
            [req.user.userId]
        );

        const received = parseFloat(balanceResult.rows[0].received || 0);
        const sent = parseFloat(balanceResult.rows[0].sent || 0);

        // Calcular taxas sobre transações recebidas
        const taxResult = await pool.query(
            `SELECT COUNT(*) as count FROM transactions
             WHERE user_id = $1 AND type = 'received' AND status = 'completed'`,
            [req.user.userId]
        );
        const totalTaxas = parseInt(taxResult.rows[0].count || 0) * 0.20;
        const saldoDisponivel = received - sent - totalTaxas;

        console.log(`💰 Saldo disponível: R$ ${saldoDisponivel.toFixed(2)}`);

        if (saldoDisponivel < parseFloat(valor)) {
            return res.status(400).json({
                error: 'Saldo insuficiente',
                saldoDisponivel: parseFloat(saldoDisponivel.toFixed(2)),
                valorSolicitado: parseFloat(valor)
            });
        }

        // Registrar transação de saída como COMPLETED (já que é instantâneo)
        const insertResult = await pool.query(
            `INSERT INTO transactions
            (user_id, type, amount, receiver_name, description, status)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *`,
            [
                req.user.userId,
                'sent',
                parseFloat(valor),
                chave_pix,
                descricao || `Saque PIX para ${tipo_chave}: ${chave_pix}`,
                'completed'  // Saque é imediato
            ]
        );

        console.log('✅ Saque PIX registrado:', insertResult.rows[0]);

        res.json({
            success: true,
            message: 'Saque realizado com sucesso!',
            data: {
                transactionId: insertResult.rows[0].id,
                valor: parseFloat(valor),
                chavePix: chave_pix,
                novoSaldo: parseFloat((saldoDisponivel - parseFloat(valor)).toFixed(2))
            }
        });

    } catch (error) {
        console.error('❌ Erro ao realizar saque:', error);
        res.status(500).json({
            error: 'Erro ao realizar saque',
            message: error.message
        });
    }
});

app.listen(PORT, () => {
  console.log(`🚀 Backend PixPay rodando na porta ${PORT}`);
  console.log(`📍 Endpoint: http://localhost:${PORT}`);
  console.log(`✅ Health check: http://localhost:${PORT}/health`);
});
