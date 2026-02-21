const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'orders.json');

// ==================== USERS CONFIG ====================
const USERS = {
  sale: { password: '111', role: 'sales', displayName: 'Phòng Bán Hàng' },
  mixer: { password: '111', role: 'mixer', displayName: 'Mixer' },
  packing: { password: '111', role: 'packing', displayName: 'Packing' },
};

// Simple token store (in-memory)
const tokens = {};

// ==================== MIDDLEWARE ====================
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Ensure data directory exists
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
}

// Initialize data file
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ orders: [], nextId: 1 }, null, 2));
}

// ==================== HELPERS ====================
function readData() {
  const raw = fs.readFileSync(DATA_FILE, 'utf-8');
  return JSON.parse(raw);
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function generateToken() {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

function authMiddleware(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (!token || !tokens[token]) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.user = tokens[token];
  next();
}

// ==================== AUTH ROUTES ====================
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = USERS[username];
  if (!user || user.password !== password) {
    return res.status(401).json({ error: 'Sai tên đăng nhập hoặc mật khẩu' });
  }
  const token = generateToken();
  tokens[token] = { username, role: user.role, displayName: user.displayName };
  res.json({ token, user: { username, role: user.role, displayName: user.displayName } });
});

app.post('/api/logout', authMiddleware, (req, res) => {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  delete tokens[token];
  res.json({ success: true });
});

app.get('/api/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

// ==================== ORDER ROUTES ====================

// GET all orders
app.get('/api/orders', authMiddleware, (req, res) => {
  const data = readData();
  res.json(data.orders);
});

// POST new order (Sales only)
app.post('/api/orders', authMiddleware, (req, res) => {
  if (req.user.role !== 'sales') {
    return res.status(403).json({ error: 'Chỉ Sales mới được tạo đơn hàng' });
  }
  const data = readData();
  const order = {
    id: data.nextId++,
    createdDate: new Date().toISOString(),
    createdBy: req.user.username,
    orderDate: req.body.orderDate || '',
    pickupDate: req.body.pickupDate || '',
    productName: req.body.productName || '',
    pelletType: req.body.pelletType || '',
    bagHigro: req.body.bagHigro || 0,
    bagCp: req.body.bagCp || 0,
    bagStar: req.body.bagStar || 0,
    bagNuvo: req.body.bagNuvo || 0,
    bagNasa: req.body.bagNasa || 0,
    bagFarm: req.body.bagFarm || 0,
    siloTruck: req.body.siloTruck || '',
    notes: req.body.notes || '',
    status: 'Chờ sản xuất',
    mixerConfirmedBy: null,
    mixerConfirmedDate: null,
    mixerNotes: '',
    packingConfirmedBy: null,
    packingConfirmedDate: null,
    packingNotes: '',
  };
  data.orders.unshift(order);
  writeData(data);
  res.json(order);
});

// PUT update order - Mixer confirm
app.put('/api/orders/:id/mixer', authMiddleware, (req, res) => {
  if (req.user.role !== 'mixer') {
    return res.status(403).json({ error: 'Chỉ Mixer mới được xác nhận sản xuất' });
  }
  const data = readData();
  const order = data.orders.find(o => o.id === parseInt(req.params.id));
  if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });

  order.status = req.body.status || 'Hoàn thành SX';
  order.mixerConfirmedBy = req.user.username;
  order.mixerConfirmedDate = new Date().toISOString();
  order.mixerNotes = req.body.mixerNotes || '';
  writeData(data);
  res.json(order);
});

// PUT update order - Packing confirm
app.put('/api/orders/:id/packing', authMiddleware, (req, res) => {
  if (req.user.role !== 'packing') {
    return res.status(403).json({ error: 'Chỉ Packing mới được xác nhận đóng gói' });
  }
  const data = readData();
  const order = data.orders.find(o => o.id === parseInt(req.params.id));
  if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });

  order.status = 'Hoàn thành';
  order.packingBags = req.body.packingBags || 0;
  order.packingConfirmedBy = req.user.username;
  order.packingConfirmedDate = new Date().toISOString();
  order.packingNotes = req.body.packingNotes || '';
  writeData(data);
  res.json(order);
});

// DELETE order (Sales only, only if status is "Chờ sản xuất")
app.delete('/api/orders/:id', authMiddleware, (req, res) => {
  if (req.user.role !== 'sales') {
    return res.status(403).json({ error: 'Chỉ Sales mới được xóa đơn hàng' });
  }
  const data = readData();
  const idx = data.orders.findIndex(o => o.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
  if (data.orders[idx].status !== 'Chờ sản xuất') {
    return res.status(403).json({ error: 'Chỉ xóa được đơn đang Chờ sản xuất' });
  }
  data.orders.splice(idx, 1);
  writeData(data);
  res.json({ success: true });
});

// GET stats
app.get('/api/stats', authMiddleware, (req, res) => {
  const data = readData();
  const orders = data.orders;
  const stats = {
    total: orders.length,
    waiting: orders.filter(o => o.status === 'Chờ sản xuất').length,
    producing: orders.filter(o => o.status === 'Đang sản xuất').length,
    produced: orders.filter(o => o.status === 'Hoàn thành SX').length,
    packing: orders.filter(o => o.status === 'Đang đóng gói').length,
    completed: orders.filter(o => o.status === 'Hoàn thành').length,
    totalBags: orders.reduce((sum, o) => sum + (o.packingBags || 0), 0),
  };
  res.json(stats);
});

// ==================== START SERVER ====================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Order Workflow Server đang chạy tại:`);
  console.log(`   Local:   http://localhost:${PORT}`);
  const os = require('os');
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`   Network: http://${net.address}:${PORT}`);
      }
    }
  }
  console.log(`\n📁 Dữ liệu lưu tại: ${DATA_FILE}`);
  console.log(`\n👤 Users: sale/111, mixer/111, packing/111\n`);
});
