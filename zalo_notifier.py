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
from datetime import datetime, timezone

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
ZALO_CONFIG_FILE = os.path.join(DATA_DIR, 'zalo_config.json')
ZALO_PENDING_FILE = os.path.join(DATA_DIR, 'zalo_pending.json')

# Flag to avoid sending cookie reminder too often (once per day)
_reminder_sent_date = None

# Will be set by server.py at startup
_database_url = None

def init(database_url=None):
    """Initialize with optional database URL for PostgreSQL storage."""
    global _database_url
    _database_url = database_url
    if _database_url:
        _init_pg_table()


def _init_pg_table():
    """Create zalo_config and pending_notifications tables in PostgreSQL if not exists."""
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
        cur.execute('''
            CREATE TABLE IF NOT EXISTS zalo_pending_notifications (
                id SERIAL PRIMARY KEY,
                message TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT NOW()
            )
        ''')
        conn.commit()
        cur.close()
        conn.close()
        print("[ZALO] PostgreSQL tables ready")
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

    # Calculate cookie age for expiration warning
    updated = config.get('cookies_updated_at', '')
    if updated:
        try:
            updated_dt = datetime.fromisoformat(updated)
            now = datetime.now(timezone.utc)
            age_days = (now - updated_dt).total_seconds() / 86400
            safe['cookies_age_days'] = round(age_days, 1)
            if age_days > 5:
                safe['cookies_warning'] = 'expired'
            elif age_days > 3:
                safe['cookies_warning'] = 'expiring_soon'
            else:
                safe['cookies_warning'] = 'ok'
        except Exception:
            safe['cookies_age_days'] = None
            safe['cookies_warning'] = 'unknown'
    else:
        safe['cookies_age_days'] = None
        safe['cookies_warning'] = 'unknown'

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
    cookies_changed = False
    for key in ['enabled', 'imei', 'cookies', 'notify_mode', 'user_id', 'group_id']:
        if key in new_config:
            if key == 'cookies' and new_config[key] and new_config[key] != config.get('cookies'):
                cookies_changed = True
            config[key] = new_config[key]

    # Track when cookies were last updated
    if cookies_changed:
        config['cookies_updated_at'] = datetime.now(timezone.utc).isoformat()
        config['reminder_sent'] = 'false'
        print(f"[ZALO] Cookies updated at {config['cookies_updated_at']}")

    _save_config(config)

    # Flush pending notifications when new cookies are saved
    if cookies_changed:
        _flush_pending_queue(config)

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


# ==================== PENDING QUEUE ====================

def _add_to_pending(message):
    """Add a failed message to the pending queue."""
    try:
        if _database_url:
            import psycopg2
            url = _database_url
            if url.startswith('postgres://'):
                url = url.replace('postgres://', 'postgresql://', 1)
            conn = psycopg2.connect(url, sslmode='require')
            cur = conn.cursor()
            cur.execute('INSERT INTO zalo_pending_notifications (message) VALUES (%s)', (message,))
            conn.commit()
            cur.close()
            conn.close()
        else:
            pending = []
            if os.path.exists(ZALO_PENDING_FILE):
                with open(ZALO_PENDING_FILE, 'r', encoding='utf-8') as f:
                    pending = json.load(f)
            pending.append({'message': message, 'created_at': datetime.now(timezone.utc).isoformat()})
            os.makedirs(DATA_DIR, exist_ok=True)
            with open(ZALO_PENDING_FILE, 'w', encoding='utf-8') as f:
                json.dump(pending, f, ensure_ascii=False)
        print(f"[ZALO] 📥 Đã lưu tin nhắn vào hàng đợi (cookies hết hạn)")
    except Exception as e:
        print(f"[ZALO] ❌ Lỗi lưu pending: {e}")


def _get_pending_messages():
    """Get all pending messages from queue."""
    messages = []
    try:
        if _database_url:
            import psycopg2
            url = _database_url
            if url.startswith('postgres://'):
                url = url.replace('postgres://', 'postgresql://', 1)
            conn = psycopg2.connect(url, sslmode='require')
            cur = conn.cursor()
            cur.execute('SELECT id, message FROM zalo_pending_notifications ORDER BY created_at')
            messages = cur.fetchall()
            cur.close()
            conn.close()
        else:
            if os.path.exists(ZALO_PENDING_FILE):
                with open(ZALO_PENDING_FILE, 'r', encoding='utf-8') as f:
                    pending = json.load(f)
                messages = [(i, p['message']) for i, p in enumerate(pending)]
    except Exception as e:
        print(f"[ZALO] Warning getting pending: {e}")
    return messages


def _clear_pending_queue():
    """Clear all pending messages after successful send."""
    try:
        if _database_url:
            import psycopg2
            url = _database_url
            if url.startswith('postgres://'):
                url = url.replace('postgres://', 'postgresql://', 1)
            conn = psycopg2.connect(url, sslmode='require')
            cur = conn.cursor()
            cur.execute('DELETE FROM zalo_pending_notifications')
            conn.commit()
            cur.close()
            conn.close()
        else:
            if os.path.exists(ZALO_PENDING_FILE):
                os.remove(ZALO_PENDING_FILE)
        print("[ZALO] 🗑️ Đã xóa hàng đợi")
    except Exception as e:
        print(f"[ZALO] Warning clearing pending: {e}")


def _flush_pending_queue(config):
    """Send all pending messages after cookies are updated."""
    pending = _get_pending_messages()
    if not pending:
        return
    print(f"[ZALO] 📤 Đang gửi {len(pending)} tin nhắn đang chờ...")

    def _do_flush():
        try:
            from zlapi.models import Message, ThreadType
            bot = _create_bot(config)
            mode = config.get('notify_mode', 'group')
            sent_count = 0
            for pid, message in pending:
                try:
                    msg = Message(text=message)
                    if mode in ('user', 'both') and config.get('user_id'):
                        bot.send(msg, thread_id=config['user_id'], thread_type=ThreadType.USER)
                    if mode in ('group', 'both') and config.get('group_id'):
                        bot.send(msg, thread_id=config['group_id'], thread_type=ThreadType.GROUP)
                    sent_count += 1
                except Exception as e:
                    print(f"[ZALO] ⚠️ Lỗi gửi tin pending #{pid}: {e}")
            _clear_pending_queue()
            print(f"[ZALO] ✅ Đã gửi {sent_count}/{len(pending)} tin nhắn đang chờ")
            # Notify user about flushed messages
            try:
                summary = Message(text=f"📬 Đã gửi {sent_count} đơn hàng đang chờ!\n━━━━━━━━━━━━\n✅ Cookies mới đã hoạt động.\n📋 {sent_count} thông báo đơn hàng đã được gửi bù.")
                if config.get('user_id'):
                    bot.send(summary, thread_id=config['user_id'], thread_type=ThreadType.USER)
            except Exception:
                pass
        except Exception as e:
            print(f"[ZALO] ❌ Lỗi flush pending: {e}")
            traceback.print_exc()

    t = threading.Thread(target=_do_flush, daemon=True)
    t.start()


def _check_cookie_expiry_reminder(config):
    """Send a reminder if cookies are about to expire (3+ days old). Max once per day."""
    global _reminder_sent_date
    updated = config.get('cookies_updated_at', '')
    if not updated:
        return

    try:
        updated_dt = datetime.fromisoformat(updated)
        now = datetime.now(timezone.utc)
        age_days = (now - updated_dt).total_seconds() / 86400

        # Only remind when cookies are 3+ days old
        if age_days < 3:
            return

        # Check if reminder already sent today
        today = now.strftime('%Y-%m-%d')
        if config.get('reminder_sent', '') == today:
            return
        if _reminder_sent_date == today:
            return

        # Send reminder
        from zlapi.models import Message, ThreadType
        bot = _create_bot(config)
        days_str = f"{age_days:.1f}"
        reminder = Message(text=f"⚠️ NHẮC CẬP NHẬT COOKIES\n━━━━━━━━━━━━\n⏳ Cookies đã {days_str} ngày tuổi, sắp hết hạn!\n\n📌 Vui lòng:\n1. Mở chat.zalo.me\n2. Click extension → copy cookies\n3. Paste vào Order Workflow → Lưu\n\n⏰ Chỉ mất 30 giây!")

        if config.get('user_id'):
            bot.send(reminder, thread_id=config['user_id'], thread_type=ThreadType.USER)
            print(f"[ZALO] ⏰ Đã gửi nhắc cập nhật cookies ({days_str} ngày)")

        # Mark reminder sent
        _reminder_sent_date = today
        config['reminder_sent'] = today
        _save_config(config)

    except Exception as e:
        print(f"[ZALO] Warning cookie reminder: {e}")


# ==================== COOKIE HEALTH CHECK ====================

# Track last check to avoid checking too frequently
_last_cookie_check = None
_last_cookie_status = None

def check_cookies_status():
    """Check if cookies are still valid. Called by /health endpoint.
    Runs in background to avoid blocking. Max once per 15 minutes."""
    global _last_cookie_check, _last_cookie_status

    config = _load_config()
    if not config or not config.get('enabled') or not config.get('cookies'):
        return 'unconfigured'

    # Don't check more than once per 15 minutes
    now = datetime.now(timezone.utc)
    if _last_cookie_check:
        elapsed = (now - _last_cookie_check).total_seconds()
        if elapsed < 900:  # 15 minutes
            return _last_cookie_status or 'unknown'

    _last_cookie_check = now

    # Run check in background thread
    def _do_check():
        global _last_cookie_status
        try:
            bot = _create_bot(config)
            account = bot.fetchAccountInfo()
            if account and hasattr(account, 'profile'):
                _last_cookie_status = 'alive'
                # Also check age and send reminder
                _check_cookie_expiry_reminder(config)
                print(f"[ZALO] ✅ Cookie check: ALIVE")

                # Update status in config
                config['cookies_status'] = 'alive'
                config['cookies_last_check'] = now.isoformat()
                _save_config(config)
            else:
                _last_cookie_status = 'dead'
                _on_cookies_expired(config, now)
        except Exception as e:
            print(f"[ZALO] ❌ Cookie check: DEAD ({e})")
            _last_cookie_status = 'dead'
            _on_cookies_expired(config, now)

    t = threading.Thread(target=_do_check, daemon=True)
    t.start()

    return _last_cookie_status or 'checking'


def _on_cookies_expired(config, now):
    """Handle cookie expiration: update status and try to send reminder."""
    global _reminder_sent_date

    today = now.strftime('%Y-%m-%d')
    config['cookies_status'] = 'dead'
    config['cookies_last_check'] = now.isoformat()

    # Only notify once per day about expired cookies
    if config.get('expired_notified') == today:
        _save_config(config)
        return

    config['expired_notified'] = today
    _save_config(config)

    print(f"[ZALO] ⚠️ Cookies HẾT HẠN! Đang thử gửi nhắc nhở...")

    # Try sending reminder - might fail if cookies are fully dead
    # But sometimes cookies are partially expired (some APIs work, some don't)
    try:
        from zlapi.models import Message, ThreadType
        bot = _create_bot(config)
        reminder = Message(text="🚨 COOKIES ĐÃ HẾT HẠN!\n━━━━━━━━━━━━\n❌ Hệ thống không thể gửi thông báo đơn hàng!\n\n📌 Cần làm NGAY:\n1. Mở chat.zalo.me\n2. Click extension → copy cookies\n3. Paste vào Order Workflow → Lưu\n\n📥 Các đơn hàng mới sẽ được lưu vào hàng đợi và gửi bù khi có cookies mới.")

        if config.get('user_id'):
            bot.send(reminder, thread_id=config['user_id'], thread_type=ThreadType.USER)
            print(f"[ZALO] ⏰ Đã gửi cảnh báo cookies hết hạn")
    except Exception as e:
        print(f"[ZALO] Không thể gửi nhắc (cookies đã hoàn toàn hết hạn): {e}")


# ==================== SEND LOGIC ====================

def _do_send(message, config):
    """Actually send the Zalo message. Runs in background thread."""
    try:
        from zlapi.models import Message, ThreadType

        # Check if cookies are expiring and send reminder
        _check_cookie_expiry_reminder(config)

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
        # Queue the message for later retry
        _add_to_pending(message)
        print(f"[ZALO] 📥 Tin nhắn đã được lưu vào hàng đợi, sẽ gửi khi cookies được cập nhật")


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


# Group ID for "Packing và mixer"
PACKING_MIXER_GROUP_ID = '1658934462778680543'


def _format_mixer_confirmed_message(order):
    """Format mixer confirmation into a Zalo message for Packing team."""
    order_id = order.get('id', '?')
    product = order.get('productName', '') or order.get('productCode', '') or '—'
    pellet = order.get('pelletType', '') or ''
    pickup = order.get('pickupDate', '') or order.get('deliveryDate', '') or '—'
    delivery_type = order.get('deliveryType', '') or 'Đại lý'
    quantity = order.get('quantity', 0) or 0
    unit = 'Kg' if delivery_type == 'Xe silo' else 'Bao'
    mixer_by = order.get('mixerConfirmedBy', '') or '—'
    mixer_notes = order.get('mixerNotes', '') or ''

    msg = f"✅ ĐÃ HOÀN THÀNH SẢN XUẤT #{order_id}\n"
    msg += "━━━━━━━━━━━━\n"
    msg += f"🏭 Tên cám: {product}\n"
    if pellet:
        msg += f"⚙️ Dạng: {pellet}\n"
    msg += f"📅 Ngày lấy: {pickup}\n"
    msg += f"🚚 Loại giao: {delivery_type}\n"
    msg += f"📦 Số lượng: {quantity} {unit}\n"
    msg += f"👷 Mixer: {mixer_by}\n"
    if mixer_notes:
        msg += f"📝 Ghi chú SX: {mixer_notes}\n"
    msg += "━━━━━━━━━━━━\n"
    msg += "📦 Sẵn sàng đóng gói!"
    return msg


def _do_send_to_group(message, config, group_id):
    """Send Zalo message to a specific group. Runs in background thread."""
    try:
        from zlapi.models import Message, ThreadType

        bot = _create_bot(config)
        msg = Message(text=message)
        bot.send(msg, thread_id=group_id, thread_type=ThreadType.GROUP)
        print(f"[ZALO] ✅ Đã gửi vào nhóm (group_id: {group_id})")

    except ImportError:
        print("[ZALO] ❌ zlapi chưa được cài đặt. Chạy: pip install zlapi")
    except Exception as e:
        print(f"[ZALO] ❌ Lỗi gửi tin nhắn vào nhóm {group_id}: {e}")
        traceback.print_exc()
        _add_to_pending(message)


def notify_mixer_confirmed(order):
    """Send Zalo notification to 'Packing và mixer' group when mixer confirms. Non-blocking."""
    config = _load_config()
    if not config or not config.get('enabled'):
        return
    message = _format_mixer_confirmed_message(order)
    t = threading.Thread(target=_do_send_to_group, args=(message, config, PACKING_MIXER_GROUP_ID), daemon=True)
    t.start()


def generate_and_send_weekly_report(orders, week_offset=-1):
    """Generate weekly performance report and send via Zalo.
    Args:
        orders: list of order dicts (from db.get_orders())
        week_offset: -1 = last week, 0 = this week, etc.
    Returns: dict with success status and report preview.
    """
    from datetime import datetime, timedelta

    # Calculate week range (Monday to Sunday)
    now = datetime.now()
    day_of_week = now.weekday()  # 0=Monday
    monday = now - timedelta(days=day_of_week) + timedelta(weeks=week_offset)
    monday = monday.replace(hour=0, minute=0, second=0, microsecond=0)
    sunday = monday + timedelta(days=6, hours=23, minutes=59, seconds=59)

    # Filter orders by pickup date in this week
    week_orders = []
    for o in orders:
        pickup = o.get('pickupDate') or o.get('deliveryDate') or ''
        if not pickup:
            continue
        try:
            pd = datetime.fromisoformat(pickup.replace('Z', '+00:00')) if 'T' in pickup else datetime.strptime(pickup, '%Y-%m-%d')
            pd = pd.replace(tzinfo=None)
            if monday <= pd <= sunday:
                week_orders.append(o)
        except Exception:
            continue

    if not week_orders:
        return {'success': False, 'error': 'Không có đơn hàng nào trong tuần này.'}

    # Calculate stats
    total = len(week_orders)
    completed = [o for o in week_orders if o.get('status') == 'Hoàn thành']
    completed_count = len(completed)
    in_progress = total - completed_count

    # Late analysis
    late_orders = [o for o in week_orders if o.get('lateNote') or o.get('lateReason')]
    late_sales = len([o for o in late_orders if o.get('lateReason') == 'sales'])
    late_mixer = len([o for o in late_orders if o.get('lateReason') == 'mixer'])
    late_packing = len([o for o in late_orders if o.get('lateReason') == 'packing'])
    on_time = total - len(late_orders)
    on_time_pct = round((on_time / total) * 100) if total > 0 else 0

    # Format week range
    fmt = lambda d: d.strftime('%d/%m')
    week_str = f"{fmt(monday)} - {fmt(sunday)}/{sunday.year}"

    # Build positive message
    msg = f"📊 TỔNG KẾT TUẦN {week_str}\n"
    msg += "━━━━━━━━━━━━━━━━━━\n\n"

    # Overall stats
    msg += f"📋 Tổng đơn hàng: {total}\n"
    msg += f"✅ Hoàn thành: {completed_count}/{total}"
    if completed_count == total:
        msg += " 🎉 TUYỆT VỜI!\n"
    else:
        msg += f"\n⏳ Đang xử lý: {in_progress}\n"
    msg += f"⏱️ Đúng hẹn: {on_time}/{total} ({on_time_pct}%)\n\n"

    # Performance by team - always positive tone
    msg += "👥 ĐÁNH GIÁ TỪNG BỘ PHẬN\n"
    msg += "━━━━━━━━━━━━━━━━━━\n\n"

    # Sales team
    msg += "📝 BỘ PHẬN BÁN HÀNG (Sales)\n"
    if late_sales == 0:
        msg += "   ⭐ Xuất sắc! Tất cả đơn hàng được đặt đúng kế hoạch.\n"
    elif late_sales <= 2:
        msg += f"   ✨ Tốt! Chỉ {late_sales} đơn cần điều chỉnh thời gian.\n"
        msg += "   💪 Tiếp tục phối hợp chặt chẽ với kế hoạch SX!\n"
    else:
        msg += f"   📌 {late_sales} đơn cần cải thiện kế hoạch giao hàng.\n"
        msg += "   💡 Gợi ý: Xác nhận năng lực SX trước khi hẹn khách.\n"
    msg += "\n"

    # Mixer team
    msg += "🔧 BỘ PHẬN MIXER (Sản xuất)\n"
    if late_mixer == 0:
        msg += "   ⭐ Xuất sắc! Sản xuất đúng tiến độ 100%.\n"
    elif late_mixer <= 2:
        msg += f"   ✨ Tốt! {late_mixer} đơn chậm tiến độ nhẹ.\n"
        msg += "   💪 Đội Mixer đã nỗ lực rất tốt!\n"
    else:
        msg += f"   📌 {late_mixer} đơn cần cải thiện tốc độ SX.\n"
        msg += "   💡 Gợi ý: Kiểm tra công suất máy & lịch bảo trì.\n"
    msg += "\n"

    # Packing team
    msg += "📦 BỘ PHẬN PACKING (Đóng gói)\n"
    if late_packing == 0:
        msg += "   ⭐ Xuất sắc! Đóng gói nhanh chóng, chính xác.\n"
    elif late_packing <= 2:
        msg += f"   ✨ Tốt! {late_packing} đơn đóng gói chậm nhẹ.\n"
        msg += "   💪 Team Packing rất cố gắng!\n"
    else:
        msg += f"   📌 {late_packing} đơn cần cải thiện tốc độ đóng gói.\n"
        msg += "   💡 Gợi ý: Chuẩn bị bao bì trước khi SX xong.\n"
    msg += "\n"

    # Closing message
    msg += "━━━━━━━━━━━━━━━━━━\n"
    if on_time_pct >= 90:
        msg += "🏆 KẾT QUẢ: XUẤT SẮC!\n"
        msg += "🎯 Toàn bộ team phối hợp rất tốt tuần này.\n"
    elif on_time_pct >= 70:
        msg += "👍 KẾT QUẢ: TỐT!\n"
        msg += "🎯 Tiếp tục phát huy và cải thiện thêm nhé!\n"
    else:
        msg += "💪 KẾT QUẢ: CẦN CỐ GẮNG THÊM!\n"
        msg += "🎯 Cùng nhau phối hợp tốt hơn tuần tới nhé!\n"
    msg += "━━━━━━━━━━━━━━━━━━\n"
    msg += "🤝 Sales + Mixer + Packing = SỨC MẠNH TỔNG HỢP!\n"
    msg += "💬 Order Workflow - CP Vietnam"

    # Send via Zalo
    config = _load_config()
    if not config or not config.get('enabled'):
        return {'success': True, 'message': msg, 'sent': False, 'note': 'Zalo chưa bật, chỉ xem trước báo cáo.'}

    # Send to all configured destinations
    group_ids = set()
    if config.get('group_id'):
        group_ids.add(config['group_id'])
    group_ids.add(PACKING_MIXER_GROUP_ID)

    def _send_report():
        try:
            from zlapi.models import Message, ThreadType
            bot = _create_bot(config)
            zalo_msg = Message(text=msg)
            for gid in group_ids:
                try:
                    bot.send(zalo_msg, thread_id=gid, thread_type=ThreadType.GROUP)
                    print(f"[ZALO] ✅ Đã gửi báo cáo tuần vào nhóm {gid}")
                except Exception as e:
                    print(f"[ZALO] ⚠️ Lỗi gửi vào nhóm {gid}: {e}")
            # Also send to user (trưởng ca) if configured
            if config.get('user_id'):
                bot.send(zalo_msg, thread_id=config['user_id'], thread_type=ThreadType.USER)
                print(f"[ZALO] ✅ Đã gửi báo cáo cho Trưởng ca")
        except Exception as e:
            print(f"[ZALO] ❌ Lỗi gửi báo cáo tuần: {e}")
            traceback.print_exc()

    t = threading.Thread(target=_send_report, daemon=True)
    t.start()

    return {'success': True, 'message': msg, 'sent': True, 'groups': len(group_ids)}


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
                group_ids = []
                if hasattr(all_groups, 'gridVerMap'):
                    group_ids = list(all_groups.gridVerMap.keys())
                elif isinstance(all_groups, dict):
                    group_ids = list(all_groups.keys())
                elif isinstance(all_groups, list):
                    group_ids = all_groups

                print(f"[ZALO] Found {len(group_ids)} groups total")

                # Fetch group info in batches (fetchGroupInfo may accept single ID)
                for gid in group_ids:
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
            'contacts': contacts,
            'groups': groups,
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
