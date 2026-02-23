# Order Workflow - Hệ thống Đặt hàng & Sản xuất

## 🚀 Chạy ứng dụng

### Cách 1: Double-click
- Double-click file `start.bat` (xem bên dưới cách tạo)

### Cách 2: Command line
```bash
cd "d:\Github\Google form"
python server.py
```

### Truy cập
- **Máy mình**: http://localhost:3000
- **Máy khác (cùng mạng)**: http://[IP-máy-bạn]:3000
  - IP sẽ hiển thị khi chạy server

> ⚠️ **Firewall**: Nếu máy khác không truy cập được, mở port 3000 trong Windows Firewall:
> ```
> netsh advfirewall firewall add rule name="OrderWorkflow" dir=in action=allow protocol=tcp localport=3000
> ```

---

## 👤 Tài khoản

| User | Password | Quyền |
|------|----------|-------|
| sale | *** | Tạo đơn hàng, xóa đơn chờ |
| mixer | *** | Xác nhận sản xuất |
| packing | *** | Xác nhận đóng gói, nhập số bao |

---

## 📋 Workflow

```
Sales tạo đơn  →  Mixer xác nhận SX  →  Packing xác nhận đóng gói
 [Chờ SX]         [Hoàn thành SX]          [Hoàn thành]
```

---

## 📁 Dữ liệu
- Lưu tại: `data/orders.json`
- Có thể đặt thư mục `data/` trong OneDrive sync folder để tự backup
- Để đổi đường dẫn lưu: sửa biến `DATA_DIR` trong `server.py`
