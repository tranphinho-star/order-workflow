"""
Order Workflow Server - Python HTTP Server
No external dependencies required!
"""

import http.server
import json
import os
import socket
import uuid
import datetime
import urllib.parse

PORT = int(os.environ.get('PORT', 8080))
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
DATA_FILE = os.path.join(DATA_DIR, 'orders.json')
PUBLIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'public')

# ==================== USERS CONFIG ====================
USERS = {
    'sale':    {'password': '111', 'role': 'sales',   'displayName': 'Phòng Bán Hàng'},
    'mixer':   {'password': '111', 'role': 'mixer',   'displayName': 'Mixer'},
    'packing': {'password': '111', 'role': 'packing', 'displayName': 'Packing'},
}

# In-memory token store
tokens = {}

# ==================== DATA HELPERS ====================
def ensure_data():
    os.makedirs(DATA_DIR, exist_ok=True)
    if not os.path.exists(DATA_FILE):
        write_data({'orders': [], 'nextId': 1})

def read_data():
    with open(DATA_FILE, 'r', encoding='utf-8') as f:
        return json.load(f)

def write_data(data):
    with open(DATA_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def get_local_ip():
    """Get the local IP address for network access."""
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
        """Suppress default logging, use custom."""
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
        """Extract user from auth token."""
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
            data = read_data()
            return self.send_json(data['orders'])

        elif path == '/api/stats':
            user = self.get_user()
            if not user:
                return self.send_json({'error': 'Unauthorized'}, 401)
            data = read_data()
            orders = data['orders']
            stats = {
                'total': len(orders),
                'waiting': sum(1 for o in orders if o['status'] == 'Chờ sản xuất'),
                'producing': sum(1 for o in orders if o['status'] == 'Đang sản xuất'),
                'produced': sum(1 for o in orders if o['status'] == 'Hoàn thành SX'),
                'packing': sum(1 for o in orders if o['status'] == 'Đang đóng gói'),
                'completed': sum(1 for o in orders if o['status'] == 'Hoàn thành'),
                'totalBags': sum(o.get('packingBags', 0) or 0 for o in orders),
            }
            return self.send_json(stats)

        else:
            # Serve static files from public/
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

        elif path == '/api/orders':
            user = self.get_user()
            if not user:
                return self.send_json({'error': 'Unauthorized'}, 401)
            if user['role'] != 'sales':
                return self.send_json({'error': 'Chỉ Sales mới được tạo đơn hàng'}, 403)

            body = self.read_body()
            data = read_data()
            now = datetime.datetime.now().isoformat()
            order = {
                'id': data['nextId'],
                'createdDate': now,
                'createdBy': user['username'],
                'productCode': body.get('productCode', ''),
                'productName': body.get('productName', ''),
                'quantity': body.get('quantity', 0),
                'unit': body.get('unit', 'tấn'),
                'customer': body.get('customer', ''),
                'deliveryDate': body.get('deliveryDate', ''),
                'notes': body.get('notes', ''),
                'status': 'Chờ sản xuất',
                'mixerConfirmedBy': None,
                'mixerConfirmedDate': None,
                'mixerNotes': '',
                'packingBags': None,
                'packingConfirmedBy': None,
                'packingConfirmedDate': None,
                'packingNotes': '',
            }
            data['nextId'] += 1
            data['orders'].insert(0, order)
            write_data(data)
            return self.send_json(order)

        else:
            self.send_json({'error': 'Not found'}, 404)

    def do_PUT(self):
        path = urllib.parse.urlparse(self.path).path
        user = self.get_user()
        if not user:
            return self.send_json({'error': 'Unauthorized'}, 401)

        # /api/orders/{id}/mixer
        if '/api/orders/' in path and path.endswith('/mixer'):
            if user['role'] != 'mixer':
                return self.send_json({'error': 'Chỉ Mixer mới được xác nhận sản xuất'}, 403)
            order_id = int(path.split('/')[3])
            body = self.read_body()
            data = read_data()
            order = next((o for o in data['orders'] if o['id'] == order_id), None)
            if not order:
                return self.send_json({'error': 'Không tìm thấy đơn hàng'}, 404)
            order['status'] = body.get('status', 'Hoàn thành SX')
            order['mixerConfirmedBy'] = user['username']
            order['mixerConfirmedDate'] = datetime.datetime.now().isoformat()
            order['mixerNotes'] = body.get('mixerNotes', '')
            write_data(data)
            return self.send_json(order)

        # /api/orders/{id}/packing
        elif '/api/orders/' in path and path.endswith('/packing'):
            if user['role'] != 'packing':
                return self.send_json({'error': 'Chỉ Packing mới được xác nhận đóng gói'}, 403)
            order_id = int(path.split('/')[3])
            body = self.read_body()
            data = read_data()
            order = next((o for o in data['orders'] if o['id'] == order_id), None)
            if not order:
                return self.send_json({'error': 'Không tìm thấy đơn hàng'}, 404)
            order['status'] = 'Hoàn thành'
            order['packingBags'] = body.get('packingBags', 0)
            order['packingConfirmedBy'] = user['username']
            order['packingConfirmedDate'] = datetime.datetime.now().isoformat()
            order['packingNotes'] = body.get('packingNotes', '')
            write_data(data)
            return self.send_json(order)

        else:
            self.send_json({'error': 'Not found'}, 404)

    def do_DELETE(self):
        path = urllib.parse.urlparse(self.path).path
        user = self.get_user()
        if not user:
            return self.send_json({'error': 'Unauthorized'}, 401)

        # /api/orders/{id}
        if path.startswith('/api/orders/'):
            if user['role'] != 'sales':
                return self.send_json({'error': 'Chỉ Sales mới được xóa đơn hàng'}, 403)
            order_id = int(path.split('/')[3])
            data = read_data()
            idx = next((i for i, o in enumerate(data['orders']) if o['id'] == order_id), -1)
            if idx == -1:
                return self.send_json({'error': 'Không tìm thấy đơn hàng'}, 404)
            if data['orders'][idx]['status'] != 'Chờ sản xuất':
                return self.send_json({'error': 'Chỉ xóa được đơn đang Chờ sản xuất'}, 403)
            data['orders'].pop(idx)
            write_data(data)
            return self.send_json({'success': True})

        else:
            self.send_json({'error': 'Not found'}, 404)


# ==================== MAIN ====================
if __name__ == '__main__':
    ensure_data()
    local_ip = get_local_ip()

    server = http.server.HTTPServer(('0.0.0.0', PORT), OrderHandler)
    print(f"\n🚀 Order Workflow Server đang chạy!")
    print(f"   Local:   http://localhost:{PORT}")
    print(f"   Network: http://{local_ip}:{PORT}")
    print(f"\n📁 Dữ liệu: {DATA_FILE}")
    print(f"\n👤 Users: sale/111, mixer/111, packing/111")
    print(f"\n   Nhấn Ctrl+C để dừng server\n")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n\n🛑 Server đã dừng.")
        server.server_close()
