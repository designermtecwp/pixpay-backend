const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Backend PixPay funcionando!' });
});

app.post('/api/create-pix', async (req, res) => {
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
      return res.status(response.status).json({
        error: responseData.message || 'Erro ao criar PIX',
      });
    }

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
    res.status(500).json({ error: 'Erro interno', message: error.message });
  }
});

app.get('/api/check-pix/:txid', async (req, res) => {
  try {
    const { txid } = req.params;
    if (!txid) {
      return res.status(400).json({ error: 'TXID não fornecido' });
    }

    const response = await fetch(`https://api.polopag.com/v1/check-pix/${txid}`, {
      headers: { 'Api-Key': process.env.POLOPAG_API_KEY },
    });

    const statusData = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({
        error: statusData.message || 'Erro ao verificar',
      });
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
    res.status(500).json({ error: 'Erro interno', message: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Backend rodando na porta ${PORT}`);
});
