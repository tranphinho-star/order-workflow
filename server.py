"""
Order Workflow Server - Python HTTP Server
Supports PostgreSQL (Render) and JSON file fallback (local).
"""

import http.server
import json
import os
import socket
import uuid
import datetime
import urllib.parse

PORT = int(os.environ.get('PORT', 8080))
DATABASE_URL = os.environ.get('DATABASE_URL')
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
DATA_FILE = os.path.join(DATA_DIR, 'orders.json')
USERS_FILE = os.path.join(DATA_DIR, 'users.json')
PUBLIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'public')

# ==================== USERS CONFIG ====================
DEFAULT_USERS = {
    'sale':    {'password': '111', 'role': 'sales',   'displayName': 'Phòng Bán Hàng'},
    'mixer':   {'password': '111', 'role': 'mixer',   'displayName': 'Mixer'},
    'packing': {'password': '111', 'role': 'packing', 'displayName': 'Packing'},
}

tokens = {}

def _load_users():
    """Load user passwords from users.json, fallback to defaults."""
    os.makedirs(DATA_DIR, exist_ok=True)
    if os.path.exists(USERS_FILE):
        try:
            with open(USERS_FILE, 'r', encoding='utf-8') as f:
                saved = json.load(f)
            # Merge saved passwords into defaults
            users = {}
            for uname, udata in DEFAULT_USERS.items():
                users[uname] = dict(udata)
                if uname in saved:
                    users[uname]['password'] = saved[uname].get('password', udata['password'])
            return users
        except Exception:
            pass
    return {k: dict(v) for k, v in DEFAULT_USERS.items()}

def _save_users(users):
    """Save user passwords to users.json."""
    os.makedirs(DATA_DIR, exist_ok=True)
    save_data = {}
    for uname, udata in users.items():
        save_data[uname] = {'password': udata['password']}
    with open(USERS_FILE, 'w', encoding='utf-8') as f:
        json.dump(save_data, f, ensure_ascii=False, indent=2)

USERS = _load_users()

# ==================== DATABASE LAYER ====================
db = None

class JsonStore:
    """JSON file-based storage for local development."""
    def __init__(self):
        os.makedirs(DATA_DIR, exist_ok=True)
        if not os.path.exists(DATA_FILE):
            self._write({'orders': [], 'nextId': 1})

    def _read(self):
        with open(DATA_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)

    def _write(self, data):
        with open(DATA_FILE, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    def get_orders(self):
        return self._read()['orders']

    def add_order(self, order_data, username):
        data = self._read()
        order = {
            'id': data['nextId'],
            'createdDate': now_iso(),
            'createdBy': username,
            'orderDate': order_data.get('orderDate', ''),
            'pickupDate': order_data.get('pickupDate', ''),
            'productName': order_data.get('productName', ''),
            'pelletType': order_data.get('pelletType', ''),
            'deliveryType': order_data.get('deliveryType', 'Đại lý'),
            'quantity': order_data.get('quantity', 0) or 0,
            'notes': order_data.get('notes', ''),
            'status': 'Chờ sản xuất',
            'mixerConfirmedBy': None,
            'mixerConfirmedDate': None,
            'mixerNotes': '',
            'packingConfirmedBy': None,
            'packingConfirmedDate': None,
            'packingNotes': '',
        }
        data['nextId'] += 1
        data['orders'].insert(0, order)
        self._write(data)
        return order

    def update_mixer(self, order_id, status, mixer_notes, username):
        data = self._read()
        order = next((o for o in data['orders'] if o['id'] == order_id), None)
        if not order:
            return None
        order['status'] = status
        order['mixerConfirmedBy'] = username
        order['mixerConfirmedDate'] = now_iso()
        order['mixerNotes'] = mixer_notes
        self._write(data)
        return order

    def update_packing(self, order_id, packing_bags, packing_notes, username):
        data = self._read()
        order = next((o for o in data['orders'] if o['id'] == order_id), None)
        if not order:
            return None
        order['status'] = 'Hoàn thành'
        order['packingBags'] = packing_bags
        order['packingConfirmedBy'] = username
        order['packingConfirmedDate'] = now_iso()
        order['packingNotes'] = packing_notes
        self._write(data)
        return order

    def delete_order(self, order_id, deleted_by=''):
        data = self._read()
        idx = next((i for i, o in enumerate(data['orders']) if o['id'] == order_id), -1)
        if idx == -1:
            return None
        order = data['orders'][idx]
        if order['status'] != 'Chờ sản xuất':
            return False
        # Archive to deleted_orders
        deleted_record = dict(order)
        deleted_record['deletedBy'] = deleted_by
        deleted_record['deletedDate'] = now_iso()
        if 'deleted_orders' not in data:
            data['deleted_orders'] = []
        data['deleted_orders'].insert(0, deleted_record)
        data['orders'].pop(idx)
        self._write(data)
        return True

    def get_deleted_orders(self):
        data = self._read()
        return data.get('deleted_orders', [])


class PgStore:
    """PostgreSQL storage for production (Render)."""
    def __init__(self, database_url):
        # Render uses postgres:// but psycopg2 needs postgresql://
        if database_url.startswith('postgres://'):
            database_url = database_url.replace('postgres://', 'postgresql://', 1)
        self.database_url = database_url
        print(f"[DB] Connecting to PostgreSQL...")
        import time
        for attempt in range(3):
            try:
                self._init_db()
                return
            except Exception as e:
                print(f"[DB] Attempt {attempt+1}/3 failed: {e}")
                if attempt < 2:
                    time.sleep(2)
        raise Exception("Could not connect to PostgreSQL after 3 attempts")

    def _conn(self):
        import psycopg2
        return psycopg2.connect(self.database_url, sslmode='require')

    def _init_db(self):
        conn = self._conn()
        cur = conn.cursor()
        cur.execute('''
            CREATE TABLE IF NOT EXISTS orders (
                id SERIAL PRIMARY KEY,
                created_date TIMESTAMP DEFAULT NOW(),
                created_by VARCHAR(50),
                product_code VARCHAR(100),
                quantity REAL DEFAULT 0,
                unit VARCHAR(20) DEFAULT 'tấn',
                delivery_date VARCHAR(20),
                notes TEXT DEFAULT '',
                status VARCHAR(50) DEFAULT 'Chờ sản xuất',
                mixer_confirmed_by VARCHAR(50),
                mixer_confirmed_date TIMESTAMP,
                mixer_notes TEXT DEFAULT '',
                packing_bags INTEGER,
                packing_confirmed_by VARCHAR(50),
                packing_confirmed_date TIMESTAMP,
                packing_notes TEXT DEFAULT ''
            )
        ''')
        # Migration: add new Google Form columns
        new_columns = [
            ("order_date", "VARCHAR(20) DEFAULT ''"),
            ("pickup_date", "VARCHAR(20) DEFAULT ''"),
            ("product_name", "VARCHAR(200) DEFAULT ''"),
            ("pellet_type", "VARCHAR(100) DEFAULT ''"),
            ("bag_higro", "INTEGER DEFAULT 0"),
            ("bag_cp", "INTEGER DEFAULT 0"),
            ("bag_star", "INTEGER DEFAULT 0"),
            ("bag_nuvo", "INTEGER DEFAULT 0"),
            ("bag_nasa", "INTEGER DEFAULT 0"),
            ("bag_farm", "INTEGER DEFAULT 0"),
            ("silo_truck", "VARCHAR(200) DEFAULT ''"),
            ("delivery_type", "VARCHAR(50) DEFAULT 'Đại lý'"),
        ]
        for col_name, col_type in new_columns:
            try:
                cur.execute(f'ALTER TABLE orders ADD COLUMN {col_name} {col_type}')
            except Exception:
                conn.rollback()
        conn.commit()
        cur.close()
        conn.close()
        print("[DB] PostgreSQL table 'orders' ready")

        # deleted_orders table
        conn = self._conn()
        cur = conn.cursor()
        cur.execute('''
            CREATE TABLE IF NOT EXISTS deleted_orders (
                id INTEGER,
                created_date TIMESTAMP,
                created_by VARCHAR(50),
                order_date VARCHAR(20) DEFAULT '',
                pickup_date VARCHAR(20) DEFAULT '',
                product_name VARCHAR(200) DEFAULT '',
                pellet_type VARCHAR(100) DEFAULT '',
                delivery_type VARCHAR(50) DEFAULT '',
                quantity REAL DEFAULT 0,
                notes TEXT DEFAULT '',
                deleted_by VARCHAR(50),
                deleted_date TIMESTAMP DEFAULT NOW()
            )
        ''')
        conn.commit()
        cur.close()
        conn.close()
        print("[DB] PostgreSQL table 'deleted_orders' ready")

        # user_passwords table
        conn = self._conn()
        cur = conn.cursor()
        cur.execute('''
            CREATE TABLE IF NOT EXISTS user_passwords (
                username VARCHAR(50) PRIMARY KEY,
                password VARCHAR(100)
            )
        ''')
        conn.commit()
        cur.close()
        conn.close()
        print("[DB] PostgreSQL table 'user_passwords' ready")

    def _row_to_dict(self, row):
        d = {
            'id': row[0],
            'createdDate': row[1].isoformat() if row[1] else None,
            'createdBy': row[2],
            'productCode': row[3],
            'quantity': row[4],
            'unit': row[5],
            'deliveryDate': row[6],
            'notes': row[7],
            'status': row[8],
            'mixerConfirmedBy': row[9],
            'mixerConfirmedDate': row[10].isoformat() if row[10] else None,
            'mixerNotes': row[11],
            'packingBags': row[12],
            'packingConfirmedBy': row[13],
            'packingConfirmedDate': row[14].isoformat() if row[14] else None,
            'packingNotes': row[15],
        }
        # New columns (indices 16+)
        if len(row) > 16:
            d['orderDate'] = row[16] or ''
            d['pickupDate'] = row[17] or ''
            d['productName'] = row[18] or ''
            d['pelletType'] = row[19] or ''
            d['bagHigro'] = row[20] or 0
            d['bagCp'] = row[21] or 0
            d['bagStar'] = row[22] or 0
            d['bagNuvo'] = row[23] or 0
            d['bagNasa'] = row[24] or 0
            d['bagFarm'] = row[25] or 0
            d['siloTruck'] = row[26] or ''
        if len(row) > 27:
            d['deliveryType'] = row[27] or 'Đại lý'
        return d

    def get_orders(self):
        conn = self._conn()
        cur = conn.cursor()
        cur.execute('SELECT * FROM orders ORDER BY id DESC')
        rows = cur.fetchall()
        cur.close()
        conn.close()
        return [self._row_to_dict(r) for r in rows]

    def add_order(self, order_data, username):
        conn = self._conn()
        cur = conn.cursor()
        cur.execute('''
            INSERT INTO orders (
                created_by, product_code, quantity, unit, delivery_date, notes,
                order_date, pickup_date, product_name, pellet_type,
                bag_higro, bag_cp, bag_star, bag_nuvo, bag_nasa, bag_farm, silo_truck,
                delivery_type
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING *
        ''', (
            username,
            order_data.get('productName', ''),
            order_data.get('quantity', 0),
            'Kg' if order_data.get('deliveryType') == 'Xe silo' else 'Bao',
            order_data.get('pickupDate', ''),
            order_data.get('notes', ''),
            order_data.get('orderDate', ''),
            order_data.get('pickupDate', ''),
            order_data.get('productName', ''),
            order_data.get('pelletType', ''),
            0, 0, 0, 0, 0, 0,  # legacy bag columns
            '',  # legacy silo_truck
            order_data.get('deliveryType', 'Đại lý'),
        ))
        row = cur.fetchone()
        conn.commit()
        cur.close()
        conn.close()
        return self._row_to_dict(row)

    def update_mixer(self, order_id, status, mixer_notes, username):
        conn = self._conn()
        cur = conn.cursor()
        cur.execute('''
            UPDATE orders SET status=%s, mixer_confirmed_by=%s,
            mixer_confirmed_date=NOW(), mixer_notes=%s
            WHERE id=%s RETURNING *
        ''', (status, username, mixer_notes, order_id))
        row = cur.fetchone()
        conn.commit()
        cur.close()
        conn.close()
        return self._row_to_dict(row) if row else None

    def update_packing(self, order_id, packing_bags, packing_notes, username):
        conn = self._conn()
        cur = conn.cursor()
        cur.execute('''
            UPDATE orders SET status='Hoàn thành', packing_bags=%s,
            packing_confirmed_by=%s, packing_confirmed_date=NOW(),
            packing_notes=%s WHERE id=%s RETURNING *
        ''', (packing_bags, username, packing_notes, order_id))
        row = cur.fetchone()
        conn.commit()
        cur.close()
        conn.close()
        return self._row_to_dict(row) if row else None

    def delete_order(self, order_id, deleted_by=''):
        conn = self._conn()
        cur = conn.cursor()
        cur.execute('SELECT * FROM orders WHERE id=%s', (order_id,))
        row = cur.fetchone()
        if not row:
            cur.close()
            conn.close()
            return None
        order = self._row_to_dict(row)
        if order['status'] != 'Chờ sản xuất':
            cur.close()
            conn.close()
            return False
        # Archive to deleted_orders
        cur.execute('''
            INSERT INTO deleted_orders (id, created_date, created_by, order_date, pickup_date,
                product_name, pellet_type, delivery_type, quantity, notes, deleted_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ''', (
            order['id'], order.get('createdDate'), order.get('createdBy'),
            order.get('orderDate', ''), order.get('pickupDate', ''),
            order.get('productName', ''), order.get('pelletType', ''),
            order.get('deliveryType', ''), order.get('quantity', 0),
            order.get('notes', ''), deleted_by
        ))
        cur.execute('DELETE FROM orders WHERE id=%s', (order_id,))
        conn.commit()
        cur.close()
        conn.close()
        return True

    def get_deleted_orders(self):
        conn = self._conn()
        cur = conn.cursor()
        cur.execute('SELECT id, created_date, created_by, order_date, pickup_date, product_name, pellet_type, delivery_type, quantity, notes, deleted_by, deleted_date FROM deleted_orders ORDER BY deleted_date DESC')
        rows = cur.fetchall()
        cur.close()
        conn.close()
        result = []
        for r in rows:
            result.append({
                'id': r[0],
                'createdDate': r[1].isoformat() if r[1] else None,
                'createdBy': r[2],
                'orderDate': r[3] or '',
                'pickupDate': r[4] or '',
                'productName': r[5] or '',
                'pelletType': r[6] or '',
                'deliveryType': r[7] or '',
                'quantity': r[8] or 0,
                'notes': r[9] or '',
                'deletedBy': r[10] or '',
                'deletedDate': r[11].isoformat() if r[11] else None,
            })
        return result

    def load_user_passwords(self):
        """Load saved passwords from PostgreSQL."""
        try:
            conn = self._conn()
            cur = conn.cursor()
            cur.execute('SELECT username, password FROM user_passwords')
            rows = cur.fetchall()
            cur.close()
            conn.close()
            return {r[0]: r[1] for r in rows}
        except Exception:
            return {}

    def save_user_password(self, username, password):
        """Save a user password to PostgreSQL."""
        conn = self._conn()
        cur = conn.cursor()
        cur.execute('''
            INSERT INTO user_passwords (username, password) VALUES (%s, %s)
            ON CONFLICT (username) DO UPDATE SET password = EXCLUDED.password
        ''', (username, password))
        conn.commit()
        cur.close()
        conn.close()


def now_iso():
    return datetime.datetime.now().isoformat()

def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

# ==================== HTTP HANDLER ====================
class OrderHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PUBLIC_DIR, **kwargs)

    def log_message(self, format, *args):
        pass

    def send_json(self, data, status=200):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))

    def read_body(self):
        length = int(self.headers.get('Content-Length', 0))
        if length == 0:
            return {}
        body = self.rfile.read(length)
        return json.loads(body.decode('utf-8'))

    def get_user(self):
        auth = self.headers.get('Authorization', '')
        token = auth.replace('Bearer ', '') if auth.startswith('Bearer ') else ''
        return tokens.get(token)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.end_headers()

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path

        if path == '/api/me':
            user = self.get_user()
            if not user:
                return self.send_json({'error': 'Unauthorized'}, 401)
            return self.send_json({'user': user})

        elif path == '/api/orders':
            user = self.get_user()
            if not user:
                return self.send_json({'error': 'Unauthorized'}, 401)
            orders = db.get_orders()
            return self.send_json(orders)

        elif path == '/api/stats':
            user = self.get_user()
            if not user:
                return self.send_json({'error': 'Unauthorized'}, 401)
            orders = db.get_orders()
            stats = {
                'total': len(orders),
                'waiting': sum(1 for o in orders if o['status'] == 'Chờ sản xuất'),
                'produced': sum(1 for o in orders if o['status'] in ('Hoàn thành SX', 'Đang sản xuất')),
                'completed': sum(1 for o in orders if o['status'] == 'Hoàn thành'),
                'totalBags': sum(o.get('packingBags', 0) or 0 for o in orders),
            }
            return self.send_json(stats)

        elif path == '/api/orders/public':
            # Public read-only endpoint for guest viewers
            orders = db.get_orders()
            return self.send_json(orders)

        elif path == '/api/users/public':
            # Public endpoint for admin to view passwords
            users_info = []
            for uname, udata in USERS.items():
                users_info.append({
                    'username': uname,
                    'role': udata['role'],
                    'displayName': udata['displayName'],
                    'password': udata['password'],
                })
            return self.send_json(users_info)

        elif path == '/api/orders/deleted':
            # Public endpoint for viewing deletion history
            deleted = db.get_deleted_orders()
            return self.send_json(deleted)

        else:
            return super().do_GET()

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path

        if path == '/api/login':
            body = self.read_body()
            username = body.get('username', '')
            password = body.get('password', '')
            user_config = USERS.get(username)
            if not user_config or user_config['password'] != password:
                return self.send_json({'error': 'Sai tên đăng nhập hoặc mật khẩu'}, 401)
            token = str(uuid.uuid4())
            user_info = {'username': username, 'role': user_config['role'], 'displayName': user_config['displayName']}
            tokens[token] = user_info
            return self.send_json({'token': token, 'user': user_info})

        elif path == '/api/logout':
            auth = self.headers.get('Authorization', '')
            token = auth.replace('Bearer ', '') if auth.startswith('Bearer ') else ''
            tokens.pop(token, None)
            return self.send_json({'success': True})

        elif path == '/api/change-password':
            user = self.get_user()
            if not user:
                return self.send_json({'error': 'Unauthorized'}, 401)
            body = self.read_body()
            new_password = body.get('newPassword', '').strip()
            if not new_password or len(new_password) < 1:
                return self.send_json({'error': 'Mật khẩu mới không được để trống'}, 400)
            username = user['username']
            if username in USERS:
                USERS[username]['password'] = new_password
                # Save to appropriate backend
                if hasattr(db, 'save_user_password'):
                    db.save_user_password(username, new_password)
                else:
                    _save_users(USERS)
                return self.send_json({'success': True, 'message': f'Đã đổi mật khẩu cho {username}'})
            return self.send_json({'error': 'User not found'}, 404)

        elif path == '/api/orders':
            user = self.get_user()
            if not user:
                return self.send_json({'error': 'Unauthorized'}, 401)
            if user['role'] != 'sales':
                return self.send_json({'error': 'Chỉ Sales mới được tạo đơn hàng'}, 403)
            body = self.read_body()
            order = db.add_order(body, user['username'])
            return self.send_json(order)

        elif path == '/api/orders/batch':
            user = self.get_user()
            if not user:
                return self.send_json({'error': 'Unauthorized'}, 401)
            if user['role'] != 'sales':
                return self.send_json({'error': 'Chỉ Sales mới được tạo đơn hàng'}, 403)
            body = self.read_body()
            items = body.get('items', [])
            if not items:
                return self.send_json({'error': 'Không có sản phẩm nào'}, 400)

            created_orders = []
            for item in items:
                order_data = {
                    'orderDate': body.get('orderDate', ''),
                    'pickupDate': body.get('pickupDate', ''),
                    'productName': item.get('productName', ''),
                    'pelletType': item.get('pelletType', ''),
                    'deliveryType': item.get('deliveryType', 'Đại lý'),
                    'quantity': item.get('quantity', 0),
                    'notes': body.get('notes', ''),
                }
                order = db.add_order(order_data, user['username'])
                created_orders.append(order)

            return self.send_json({'created': len(created_orders), 'orders': created_orders})

        else:
            self.send_json({'error': 'Not found'}, 404)

    def do_PUT(self):
        path = urllib.parse.urlparse(self.path).path
        user = self.get_user()
        if not user:
            return self.send_json({'error': 'Unauthorized'}, 401)

        if '/api/orders/' in path and path.endswith('/mixer'):
            if user['role'] != 'mixer':
                return self.send_json({'error': 'Chỉ Mixer mới được xác nhận sản xuất'}, 403)
            order_id = int(path.split('/')[3])
            body = self.read_body()
            order = db.update_mixer(order_id, body.get('status', 'Hoàn thành SX'), body.get('mixerNotes', ''), user['username'])
            if not order:
                return self.send_json({'error': 'Không tìm thấy đơn hàng'}, 404)
            return self.send_json(order)

        elif '/api/orders/' in path and path.endswith('/packing'):
            if user['role'] != 'packing':
                return self.send_json({'error': 'Chỉ Packing mới được xác nhận đóng gói'}, 403)
            order_id = int(path.split('/')[3])
            body = self.read_body()
            order = db.update_packing(order_id, body.get('packingBags', 0), body.get('packingNotes', ''), user['username'])
            if not order:
                return self.send_json({'error': 'Không tìm thấy đơn hàng'}, 404)
            return self.send_json(order)

        else:
            self.send_json({'error': 'Not found'}, 404)

    def do_DELETE(self):
        path = urllib.parse.urlparse(self.path).path
        user = self.get_user()
        if not user:
            return self.send_json({'error': 'Unauthorized'}, 401)

        if path.startswith('/api/orders/'):
            if user['role'] != 'sales':
                return self.send_json({'error': 'Chỉ Sales mới được xóa đơn hàng'}, 403)
            order_id = int(path.split('/')[3])
            result = db.delete_order(order_id, user['username'])
            if result is None:
                return self.send_json({'error': 'Không tìm thấy đơn hàng'}, 404)
            if result is False:
                return self.send_json({'error': 'Chỉ xóa được đơn đang Chờ sản xuất'}, 403)
            return self.send_json({'success': True})

        else:
            self.send_json({'error': 'Not found'}, 404)


# ==================== MAIN ====================
if __name__ == '__main__':
    # Choose storage backend
    if DATABASE_URL:
        print("🗄️  Sử dụng PostgreSQL database")
        db = PgStore(DATABASE_URL)
        # Load saved passwords from PostgreSQL
        saved_pws = db.load_user_passwords()
        for uname, pw in saved_pws.items():
            if uname in USERS:
                USERS[uname]['password'] = pw
    else:
        print("📁 Sử dụng JSON file (local mode)")
        db = JsonStore()

    local_ip = get_local_ip()
    server = http.server.HTTPServer(('0.0.0.0', PORT), OrderHandler)
    print(f"\n🚀 Order Workflow Server đang chạy!")
    print(f"   Local:   http://localhost:{PORT}")
    if not DATABASE_URL:
        print(f"   Network: http://{local_ip}:{PORT}")
    print(f"\n👤 Users: sale/111, mixer/111, packing/111")
    print(f"\n   Nhấn Ctrl+C để dừng server\n")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n\n🛑 Server đã dừng.")
        server.server_close()
