const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'pixpay-secret-change-this';

// Registrar usuário
async function register(email, password, fullName) {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
        'INSERT INTO users (email, password_hash, full_name) VALUES ($1, $2, $3) RETURNING id, email, full_name',
        [email, hashedPassword, fullName]
    );
    return result.rows[0];
}

// Login
async function login(email, password) {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
        throw new Error('Usuário não encontrado');
    }

    const user = result.rows[0];
    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
        throw new Error('Senha incorreta');
    }

    const token = jwt.sign(
        { userId: user.id, email: user.email }, 
        JWT_SECRET, 
        { expiresIn: '7d' }
    );
    
    return { 
        token, 
        user: { 
            id: user.id, 
            email: user.email, 
            fullName: user.full_name 
        } 
    };
}

// Middleware de autenticação
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Token não fornecido' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Token inválido' });
        }
        req.user = user;
        next();
    });
}

module.exports = { register, login, authenticateToken };
