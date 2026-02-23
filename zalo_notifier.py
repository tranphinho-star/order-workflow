"""
Zalo Notification Module
Gửi tin nhắn Zalo khi có đơn hàng mới.
Sử dụng zlapi (unofficial) để gửi tin nhắn cá nhân hoặc nhóm.

Supports:
  - JSON file storage (local dev)
  - PostgreSQL storage (Render production)
"""

import json
import os
import threading
import traceback

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
ZALO_CONFIG_FILE = os.path.join(DATA_DIR, 'zalo_config.json')

# Will be set by server.py at startup
_database_url = None

def init(database_url=None):
    """Initialize with optional database URL for PostgreSQL storage."""
    global _database_url
    _database_url = database_url
    if _database_url:
        _init_pg_table()


def _init_pg_table():
    """Create zalo_config table in PostgreSQL if not exists."""
    try:
        import psycopg2
        url = _database_url
        if url.startswith('postgres://'):
            url = url.replace('postgres://', 'postgresql://', 1)
        conn = psycopg2.connect(url, sslmode='require')
        cur = conn.cursor()
        cur.execute('''
            CREATE TABLE IF NOT EXISTS zalo_config (
                key VARCHAR(50) PRIMARY KEY,
                value TEXT
            )
        ''')
        conn.commit()
        cur.close()
        conn.close()
        print("[ZALO] PostgreSQL table 'zalo_config' ready")
    except Exception as e:
        print(f"[ZALO] Warning: Could not init PG table: {e}")


# ==================== CONFIG STORAGE ====================

def _load_config_pg():
    """Load Zalo config from PostgreSQL."""
    try:
        import psycopg2
        url = _database_url
        if url.startswith('postgres://'):
            url = url.replace('postgres://', 'postgresql://', 1)
        conn = psycopg2.connect(url, sslmode='require')
        cur = conn.cursor()
        cur.execute('SELECT key, value FROM zalo_config')
        rows = cur.fetchall()
        cur.close()
        conn.close()
        config = {}
        for k, v in rows:
            # Parse booleans
            if v == 'true':
                config[k] = True
            elif v == 'false':
                config[k] = False
            else:
                config[k] = v
        return config if config else None
    except Exception as e:
        print(f"[ZALO] Error loading PG config: {e}")
        return None


def _save_config_pg(config):
    """Save Zalo config to PostgreSQL."""
    try:
        import psycopg2
        url = _database_url
        if url.startswith('postgres://'):
            url = url.replace('postgres://', 'postgresql://', 1)
        conn = psycopg2.connect(url, sslmode='require')
        cur = conn.cursor()
        for key, value in config.items():
            str_val = str(value).lower() if isinstance(value, bool) else str(value)
            cur.execute('''
                INSERT INTO zalo_config (key, value) VALUES (%s, %s)
                ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
            ''', (key, str_val))
        conn.commit()
        cur.close()
        conn.close()
    except Exception as e:
        print(f"[ZALO] Error saving PG config: {e}")


def _load_config_json():
    """Load Zalo config from JSON file."""
    if not os.path.exists(ZALO_CONFIG_FILE):
        return None
    try:
        with open(ZALO_CONFIG_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return None


def _save_config_json(config):
    """Save Zalo config to JSON file."""
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(ZALO_CONFIG_FILE, 'w', encoding='utf-8') as f:
        json.dump(config, f, ensure_ascii=False, indent=2)


def _load_config():
    """Load config from appropriate backend."""
    if _database_url:
        return _load_config_pg()
    return _load_config_json()


def _save_config(config):
    """Save config to appropriate backend."""
    if _database_url:
        _save_config_pg(config)
    else:
        _save_config_json(config)


# ==================== PUBLIC API ====================

def get_config():
    """Get current Zalo config (safe version without cookies)."""
    config = _load_config()
    if not config:
        return {
            'enabled': False,
            'imei': '',
            'cookies': '',
            'notify_mode': 'group',
            'user_id': '',
            'group_id': '',
        }
    safe = dict(config)
    if safe.get('cookies'):
        safe['cookies_set'] = True
        c = safe['cookies']
        safe['cookies'] = '***' + c[-10:] if len(c) > 10 else '***'
    else:
        safe['cookies_set'] = False
    return safe


def update_config(new_config):
    """Update Zalo config. Only updates provided fields."""
    config = _load_config() or {
        'enabled': False,
        'imei': '',
        'cookies': '',
        'notify_mode': 'group',
        'user_id': '',
        'group_id': '',
    }
    for key in ['enabled', 'imei', 'cookies', 'notify_mode', 'user_id', 'group_id']:
        if key in new_config:
            config[key] = new_config[key]
    _save_config(config)
    return config


# ==================== MESSAGE FORMATTING ====================

def _format_order_message(order):
    """Format order info into a Zalo message."""
    order_id = order.get('id', '?')
    product = order.get('productName', '') or order.get('productCode', '') or '—'
    pellet = order.get('pelletType', '') or ''
    pickup = order.get('pickupDate', '') or order.get('deliveryDate', '') or '—'
    delivery_type = order.get('deliveryType', '') or 'Đại lý'
    quantity = order.get('quantity', 0) or 0
    unit = 'Kg' if delivery_type == 'Xe silo' else 'Bao'
    created_by = order.get('createdBy', '') or '—'
    created_date = order.get('createdDate', '') or ''

    time_str = ''
    if created_date:
        try:
            from datetime import datetime
            if 'T' in created_date:
                dt = datetime.fromisoformat(created_date.replace('Z', '+00:00'))
                time_str = dt.strftime('%H:%M %d/%m/%Y')
            else:
                time_str = created_date
        except Exception:
            time_str = created_date

    msg = f"📋 ĐƠN HÀNG MỚI #{order_id}\n"
    msg += "━━━━━━━━━━━━\n"
    msg += f"🏭 Tên cám: {product}\n"
    if pellet:
        msg += f"⚙️ Dạng: {pellet}\n"
    msg += f"📅 Ngày lấy: {pickup}\n"
    msg += f"🚚 Loại giao: {delivery_type}\n"
    msg += f"📦 Số lượng: {quantity} {unit}\n"
    msg += f"👤 Tạo bởi: {created_by}\n"
    if time_str:
        msg += f"🕐 Lúc: {time_str}\n"
    msg += "━━━━━━━━━━━━\n"
    msg += "💡 Vui lòng kiểm tra trên hệ thống Order Workflow"
    return msg


def _format_batch_message(orders):
    """Format multiple orders into a single Zalo message."""
    if len(orders) == 1:
        return _format_order_message(orders[0])

    msg = f"📋 {len(orders)} ĐƠN HÀNG MỚI\n"
    msg += "━━━━━━━━━━━━\n"
    for order in orders:
        order_id = order.get('id', '?')
        product = order.get('productName', '') or '—'
        quantity = order.get('quantity', 0) or 0
        delivery_type = order.get('deliveryType', '') or 'Đại lý'
        unit = 'Kg' if delivery_type == 'Xe silo' else 'Bao'
        msg += f"  #{order_id} | {product} | {quantity} {unit}\n"

    pickup = orders[0].get('pickupDate', '') or '—'
    created_by = orders[0].get('createdBy', '') or '—'
    msg += "━━━━━━━━━━━━\n"
    msg += f"📅 Ngày lấy: {pickup}\n"
    msg += f"👤 Tạo bởi: {created_by}\n"
    msg += "━━━━━━━━━━━━\n"
    msg += "💡 Vui lòng kiểm tra trên hệ thống Order Workflow"
    return msg


# ==================== ZLAPI HELPERS ====================

def _parse_cookies(cookie_str):
    """Parse cookies into a dict for zlapi. Supports JSON dict and raw string."""
    if isinstance(cookie_str, dict):
        return cookie_str
    if not cookie_str:
        return {}
    # Try JSON format first (from zlapi extension)
    try:
        parsed = json.loads(cookie_str)
        if isinstance(parsed, dict):
            return parsed
    except (json.JSONDecodeError, TypeError):
        pass
    # Fall back to raw cookie string format (key=val; key=val)
    cookies = {}
    for item in cookie_str.split(';'):
        item = item.strip()
        if '=' in item:
            key, val = item.split('=', 1)
            cookies[key.strip()] = val.strip()
    return cookies


def _create_bot(config):
    """Create ZaloAPI bot instance with cookie-based authentication."""
    from zlapi import ZaloAPI

    imei = config.get('imei', '')
    cookies_raw = config.get('cookies', '')
    cookies_dict = _parse_cookies(cookies_raw)

    print(f"[ZALO] Creating bot with imei={imei[:20]}..., cookies keys={list(cookies_dict.keys())}")

    # Create bot without auto_login
    bot = ZaloAPI(
        "", "",
        imei,
        session_cookies=cookies_dict,
        auto_login=False
    )
    # Set cookies and manually call _state.login() to get secret_key
    # This bypasses _client.login() which unnecessarily requires phone/password
    bot._state.set_cookies(cookies_dict)
    bot._state.login("", "", imei)
    bot._imei = imei
    bot.uid = bot._state.user_id
    return bot


# ==================== SEND LOGIC ====================

def _do_send(message, config):
    """Actually send the Zalo message. Runs in background thread."""
    try:
        from zlapi.models import Message, ThreadType

        bot = _create_bot(config)
        msg = Message(text=message)
        mode = config.get('notify_mode', 'group')

        if mode == 'user' and config.get('user_id'):
            bot.send(msg, thread_id=config['user_id'], thread_type=ThreadType.USER)
            print(f"[ZALO] ✅ Đã gửi tin nhắn cho Trưởng ca (user_id: {config['user_id']})")
        elif mode == 'group' and config.get('group_id'):
            bot.send(msg, thread_id=config['group_id'], thread_type=ThreadType.GROUP)
            print(f"[ZALO] ✅ Đã gửi tin nhắn vào nhóm (group_id: {config['group_id']})")
        elif mode == 'both':
            if config.get('user_id'):
                bot.send(msg, thread_id=config['user_id'], thread_type=ThreadType.USER)
                print(f"[ZALO] ✅ Đã gửi cho Trưởng ca")
            if config.get('group_id'):
                bot.send(msg, thread_id=config['group_id'], thread_type=ThreadType.GROUP)
                print(f"[ZALO] ✅ Đã gửi vào nhóm")
        else:
            print(f"[ZALO] ⚠️ Chưa cấu hình đúng notify_mode hoặc thiếu ID")

    except ImportError:
        print("[ZALO] ❌ zlapi chưa được cài đặt. Chạy: pip install zlapi")
    except Exception as e:
        print(f"[ZALO] ❌ Lỗi gửi tin nhắn: {e}")
        traceback.print_exc()


def notify_new_order(order):
    """Send Zalo notification for a single new order. Non-blocking."""
    config = _load_config()
    if not config or not config.get('enabled'):
        return
    message = _format_order_message(order)
    t = threading.Thread(target=_do_send, args=(message, config), daemon=True)
    t.start()


def notify_new_orders_batch(orders):
    """Send Zalo notification for a batch of new orders. Non-blocking."""
    if not orders:
        return
    config = _load_config()
    if not config or not config.get('enabled'):
        return
    message = _format_batch_message(orders)
    t = threading.Thread(target=_do_send, args=(message, config), daemon=True)
    t.start()


def test_send():
    """Send a test message to verify Zalo configuration."""
    config = _load_config()
    if not config:
        return {'success': False, 'error': 'Chưa cấu hình Zalo. Vui lòng cập nhật cấu hình trước.'}
    if not config.get('imei') or not config.get('cookies'):
        return {'success': False, 'error': 'Thiếu IMEI hoặc Cookies. Vui lòng cập nhật cấu hình.'}

    message = "🔔 Test thông báo từ Order Workflow\n━━━━━━━━━━━━\n✅ Kết nối Zalo thành công!\n💡 Hệ thống sẽ gửi thông báo tự động khi có đơn hàng mới."
    try:
        from zlapi.models import Message, ThreadType

        bot = _create_bot(config)
        msg = Message(text=message)
        mode = config.get('notify_mode', 'group')

        sent = False
        if mode in ('user', 'both') and config.get('user_id'):
            bot.send(msg, thread_id=config['user_id'], thread_type=ThreadType.USER)
            sent = True
        if mode in ('group', 'both') and config.get('group_id'):
            bot.send(msg, thread_id=config['group_id'], thread_type=ThreadType.GROUP)
            sent = True

        if not sent:
            return {'success': False, 'error': 'Chưa có User ID hoặc Group ID phù hợp với chế độ gửi hiện tại.'}
        return {'success': True, 'message': 'Đã gửi tin nhắn test thành công!'}

    except ImportError:
        return {'success': False, 'error': 'zlapi chưa được cài đặt.'}
    except Exception as e:
        print(f"[ZALO] Test send error: {e}")
        traceback.print_exc()
        return {'success': False, 'error': f'Lỗi gửi Zalo: {str(e)}'}


def lookup_contacts():
    """Use zlapi to list recent friends and groups with their IDs."""
    config = _load_config()
    if not config:
        return {'success': False, 'error': 'Chưa cấu hình Zalo. Vui lòng nhập IMEI và Cookies trước.'}
    if not config.get('imei') or not config.get('cookies'):
        return {'success': False, 'error': 'Thiếu IMEI hoặc Cookies.'}

    try:
        from zlapi import ZaloAPI
        from zlapi.models import ThreadType

        bot = _create_bot(config)

        contacts = []
        groups = []

        # Get all groups using fetchAllGroups
        try:
            all_groups = bot.fetchAllGroups()
            if all_groups:
                # all_groups returns group IDs, fetch info for each
                group_ids = []
                if hasattr(all_groups, 'gridVerMap'):
                    group_ids = list(all_groups.gridVerMap.keys())
                elif isinstance(all_groups, dict):
                    group_ids = list(all_groups.keys())
                elif isinstance(all_groups, list):
                    group_ids = all_groups

                # Fetch group info to get names
                for gid in group_ids[:30]:
                    try:
                        ginfo = bot.fetchGroupInfo(gid)
                        if ginfo and hasattr(ginfo, 'gridInfoMap'):
                            info = ginfo.gridInfoMap.get(str(gid)) or ginfo.gridInfoMap.get(gid)
                            if info:
                                name = getattr(info, 'name', '') or getattr(info, 'displayName', '') or str(gid)
                                groups.append({'id': str(gid), 'name': str(name), 'type': 'group'})
                            else:
                                groups.append({'id': str(gid), 'name': str(gid), 'type': 'group'})
                        else:
                            groups.append({'id': str(gid), 'name': str(gid), 'type': 'group'})
                    except Exception as e:
                        groups.append({'id': str(gid), 'name': str(gid), 'type': 'group'})
                        print(f"[ZALO] Warning fetching group {gid}: {e}")
        except Exception as e:
            print(f"[ZALO] Warning getting groups: {e}")

        # Get current account info
        try:
            account = bot.fetchAccountInfo()
            if account and hasattr(account, 'profile'):
                uid = account.profile.get('userId', '')
                name = account.profile.get('displayName', 'Tài khoản hiện tại')
                contacts.append({'id': str(uid), 'name': str(name), 'type': 'self'})
        except Exception as e:
            print(f"[ZALO] Warning getting account: {e}")

        return {
            'success': True,
            'contacts': contacts[:20],
            'groups': groups[:30],
        }

    except ImportError:
        return {'success': False, 'error': 'zlapi chưa được cài đặt.'}
    except Exception as e:
        print(f"[ZALO] Lookup error: {e}")
        traceback.print_exc()
        return {'success': False, 'error': f'Lỗi kết nối Zalo: {str(e)}'}


def find_user_by_phone(phone):
    """Find Zalo user ID by phone number."""
    config = _load_config()
    if not config or not config.get('imei') or not config.get('cookies'):
        return {'success': False, 'error': 'Thiếu IMEI hoặc Cookies. Lưu cấu hình trước.'}

    # Normalize phone number
    phone = phone.strip().replace(' ', '').replace('-', '')
    if phone.startswith('+84'):
        phone = '0' + phone[3:]
    elif phone.startswith('84') and len(phone) > 9:
        phone = '0' + phone[2:]

    try:
        bot = _create_bot(config)
        user_info = bot.fetchPhoneNumber(phone)

        if user_info and hasattr(user_info, 'uid'):
            uid = str(user_info.uid)
            name = getattr(user_info, 'zalo_name', '') or getattr(user_info, 'display_name', '') or ''
            return {
                'success': True,
                'user_id': uid,
                'name': str(name),
                'phone': phone,
            }
        else:
            return {'success': False, 'error': f'Không tìm thấy tài khoản Zalo với SĐT: {phone}'}

    except ImportError:
        return {'success': False, 'error': 'zlapi chưa được cài đặt.'}
    except Exception as e:
        print(f"[ZALO] Phone lookup error: {e}")
        traceback.print_exc()
        return {'success': False, 'error': f'Lỗi tìm kiếm: {str(e)}'}
