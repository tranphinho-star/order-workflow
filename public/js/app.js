// ==================== ORDER WORKFLOW APP ====================
(function () {
    'use strict';

    const API_BASE = window.location.origin + '/api';
    const ORDER_LINE_COUNT = 10;
    let currentUser = null;
    let authToken = null;
    let allOrders = [];
    let currentView = 'dashboard';
    let salesDateFilter = '';
    let isGuestMode = false;
    let dashboardDateFilter = ''; // '' = all, 'YYYY-MM-DD' = specific date
    let lastKnownUpdate = 0;
    let autoRefreshInterval = null;
    const AUTO_REFRESH_SECONDS = 15;

    // ==================== INITIALIZATION ====================
    document.addEventListener('DOMContentLoaded', init);

    function init() {
        const saved = sessionStorage.getItem('orderWorkflow');
        if (saved) {
            try {
                const data = JSON.parse(saved);
                authToken = data.token;
                currentUser = data.user;
                showApp();
            } catch (e) {
                showLogin();
            }
        } else {
            showLogin();
        }

        setupEventListeners();
        buildOrderLinesTable();
    }

    // ==================== EVENT LISTENERS ====================
    function setupEventListeners() {
        document.getElementById('login-form').addEventListener('submit', handleLogin);
        document.getElementById('btn-logout').addEventListener('click', handleLogout);
        document.getElementById('btn-guest-view').addEventListener('click', handleGuestView);

        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.addEventListener('click', () => switchView(btn.dataset.view));
        });

        document.getElementById('sales-form').addEventListener('submit', handleCreateOrder);
        document.getElementById('btn-refresh').addEventListener('click', loadData);
        document.getElementById('filter-status').addEventListener('change', renderDashboardTable);

        // Sales date filter
        document.getElementById('sales-date-filter').addEventListener('change', function () {
            salesDateFilter = this.value;
            renderSalesView();
        });
        document.getElementById('btn-sales-today').addEventListener('click', function () {
            const today = new Date().toISOString().split('T')[0];
            document.getElementById('sales-date-filter').value = today;
            salesDateFilter = today;
            renderSalesView();
        });
        document.getElementById('btn-sales-all').addEventListener('click', function () {
            document.getElementById('sales-date-filter').value = '';
            salesDateFilter = '';
            renderSalesView();
        });

        // Dashboard date filter
        document.getElementById('dashboard-date-filter')?.addEventListener('change', function () {
            dashboardDateFilter = this.value;
            renderDashboardTable();
        });
        document.getElementById('btn-dashboard-today')?.addEventListener('click', function () {
            const today = new Date().toISOString().split('T')[0];
            const el = document.getElementById('dashboard-date-filter');
            if (el) { el.value = today; }
            dashboardDateFilter = today;
            renderDashboardTable();
        });
        document.getElementById('btn-dashboard-all')?.addEventListener('click', function () {
            const el = document.getElementById('dashboard-date-filter');
            if (el) { el.value = ''; }
            dashboardDateFilter = '';
            renderDashboardTable();
        });

        // Password change
        document.getElementById('btn-change-pw').addEventListener('click', openPasswordModal);
        document.getElementById('pw-modal-close').addEventListener('click', closePasswordModal);
        document.getElementById('pw-modal-cancel').addEventListener('click', closePasswordModal);
        document.getElementById('pw-modal-save').addEventListener('click', handleChangePassword);
        document.getElementById('btn-refresh-users')?.addEventListener('click', loadAdminUsers);

        // Admin password gate
        document.getElementById('btn-admin-pw-submit')?.addEventListener('click', handleAdminPwSubmit);
        document.getElementById('admin-pw-input')?.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') handleAdminPwSubmit();
        });

        // Deletion history
        document.getElementById('btn-toggle-deleted')?.addEventListener('click', toggleDeletedOrders);

        // Modal
        document.getElementById('modal-close').addEventListener('click', closeModal);
        document.getElementById('modal-cancel').addEventListener('click', closeModal);
    }

    // ==================== ORDER LINES TABLE ====================
    function buildOrderLinesTable() {
        const tbody = document.getElementById('order-lines-tbody');
        let html = '';
        for (let i = 1; i <= ORDER_LINE_COUNT; i++) {
            html += `
            <tr class="order-line-row" data-row="${i}">
              <td class="col-stt"><span class="row-number">${i}</span></td>
              <td class="col-product">
                <input type="text" id="line-product-${i}" placeholder="VD: 511B" class="line-input">
              </td>
              <td class="col-pellet">
                <input type="text" id="line-pellet-${i}" placeholder="VD: Viên 3mm" class="line-input">
              </td>
              <td class="col-delivery">
                <select id="line-delivery-${i}" class="line-select">
                  <option value="Đại lý">🏪 Đại lý</option>
                  <option value="Trại">🏠 Trại</option>
                  <option value="Xe silo">🚛 Xe silo</option>
                </select>
              </td>
              <td class="col-qty">
                <div class="qty-wrapper">
                  <input type="number" id="line-qty-${i}" min="1" placeholder="0" class="line-input line-qty-input">
                  <span class="qty-unit" id="line-unit-${i}">Bao</span>
                </div>
              </td>
            </tr>`;
        }
        tbody.innerHTML = html;

        // Add delivery type change listeners to update unit label
        for (let i = 1; i <= ORDER_LINE_COUNT; i++) {
            document.getElementById(`line-delivery-${i}`).addEventListener('change', function () {
                const unitEl = document.getElementById(`line-unit-${i}`);
                unitEl.textContent = this.value === 'Xe silo' ? 'Kg' : 'Bao';
            });
        }
    }

    function getFilledLines() {
        const lines = [];
        for (let i = 1; i <= ORDER_LINE_COUNT; i++) {
            const product = document.getElementById(`line-product-${i}`).value.trim();
            const pellet = document.getElementById(`line-pellet-${i}`).value.trim();
            const delivery = document.getElementById(`line-delivery-${i}`).value;
            const qty = parseInt(document.getElementById(`line-qty-${i}`).value) || 0;

            if (product && qty > 0) {
                lines.push({
                    productName: product,
                    pelletType: pellet,
                    deliveryType: delivery,
                    quantity: qty,
                });
            }
        }
        return lines;
    }

    function clearOrderLines() {
        for (let i = 1; i <= ORDER_LINE_COUNT; i++) {
            document.getElementById(`line-product-${i}`).value = '';
            document.getElementById(`line-pellet-${i}`).value = '';
            document.getElementById(`line-delivery-${i}`).value = 'Đại lý';
            document.getElementById(`line-qty-${i}`).value = '';
            document.getElementById(`line-unit-${i}`).textContent = 'Bao';
        }
    }

    // ==================== AUTH ====================
    async function handleLogin(e) {
        e.preventDefault();
        const username = document.getElementById('login-username').value.trim();
        const password = document.getElementById('login-password').value;
        const errorEl = document.getElementById('login-error');

        try {
            const res = await fetch(`${API_BASE}/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password }),
            });
            const data = await res.json();

            if (!res.ok) {
                errorEl.textContent = data.error || 'Đăng nhập thất bại';
                errorEl.style.display = 'block';
                return;
            }

            authToken = data.token;
            currentUser = data.user;
            sessionStorage.setItem('orderWorkflow', JSON.stringify({ token: authToken, user: currentUser }));
            errorEl.style.display = 'none';
            showApp();
        } catch (err) {
            errorEl.textContent = 'Không thể kết nối đến server. Kiểm tra lại đường dẫn.';
            errorEl.style.display = 'block';
        }
    }

    function handleLogout() {
        stopAutoRefresh();
        if (!isGuestMode) {
            fetch(`${API_BASE}/logout`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${authToken}` },
            }).catch(() => { });
        }
        authToken = null;
        currentUser = null;
        isGuestMode = false;
        lastKnownUpdate = 0;
        sessionStorage.removeItem('orderWorkflow');
        showLogin();
    }

    function handleGuestView() {
        isGuestMode = true;
        currentUser = { username: 'guest', role: 'viewer', displayName: 'Quản lý (Chỉ xem)' };
        authToken = null;
        showApp();
    }

    // ==================== VIEWS ====================
    function showLogin() {
        document.getElementById('login-screen').style.display = 'flex';
        document.getElementById('app').style.display = 'none';
        document.getElementById('login-username').value = '';
        document.getElementById('login-password').value = '';
        document.getElementById('login-error').style.display = 'none';
    }

    function showApp() {
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('app').style.display = 'grid';

        document.getElementById('user-name').textContent = currentUser.displayName;
        document.getElementById('header-role').textContent = isGuestMode ? 'CHỈ XEM' : currentUser.role.toUpperCase();
        document.getElementById('user-avatar').textContent = isGuestMode ? '👁' : currentUser.username.charAt(0).toUpperCase();

        // Hide/show nav tabs based on guest mode
        const navSales = document.getElementById('nav-sales');
        const navMixer = document.getElementById('nav-mixer');
        const navPacking = document.getElementById('nav-packing');
        if (isGuestMode) {
            if (navSales) navSales.style.display = 'none';
            if (navMixer) navMixer.style.display = 'none';
            if (navPacking) navPacking.style.display = 'none';
            document.getElementById('btn-change-pw').style.display = 'none';
            document.getElementById('admin-users-section').style.display = 'block';
            // Reset password gate
            document.getElementById('admin-pw-gate').style.display = 'block';
            document.getElementById('admin-users-list').style.display = 'none';
            document.getElementById('btn-refresh-users').style.display = 'none';
            document.getElementById('admin-pw-input').value = '';
            document.getElementById('admin-pw-error').style.display = 'none';
            switchView('dashboard');
        } else {
            if (navSales) navSales.style.display = '';
            if (navMixer) navMixer.style.display = '';
            if (navPacking) navPacking.style.display = '';
            document.getElementById('btn-change-pw').style.display = '';
            document.getElementById('admin-users-section').style.display = 'none';

            const roleViewMap = {
                sales: 'sales',
                mixer: 'mixer',
                packing: 'packing',
            };
            switchView(roleViewMap[currentUser.role] || 'dashboard');

            // Set default: today's date filter for sales view
            const today = new Date().toISOString().split('T')[0];
            document.getElementById('sales-date-filter').value = today;
            salesDateFilter = today;
        }

        loadData();
        startAutoRefresh();
    }

    function switchView(view) {
        currentView = view;
        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.view === view);
        });
        document.querySelectorAll('.view').forEach(v => {
            v.classList.toggle('active', v.id === `view-${view}`);
        });
        renderCurrentView();
    }

    function renderCurrentView() {
        switch (currentView) {
            case 'dashboard': renderDashboard(); break;
            case 'sales': renderSalesView(); break;
            case 'mixer': renderMixerView(); break;
            case 'packing': renderPackingView(); break;
        }
    }

    // ==================== DATA ====================
    async function loadData(silent) {
        try {
            let res;
            if (isGuestMode) {
                res = await fetch(`${API_BASE}/orders/public`);
            } else {
                res = await fetch(`${API_BASE}/orders`, {
                    headers: { 'Authorization': `Bearer ${authToken}` },
                });
                if (res.status === 401) {
                    handleLogout();
                    return;
                }
            }
            allOrders = await res.json();
            renderCurrentView();
        } catch (err) {
            if (!silent) showToast('Không thể tải dữ liệu', 'error');
        }
    }

    // ==================== AUTO-REFRESH (Smart Polling) ====================
    function startAutoRefresh() {
        stopAutoRefresh();
        autoRefreshInterval = setInterval(checkForUpdates, AUTO_REFRESH_SECONDS * 1000);
    }

    function stopAutoRefresh() {
        if (autoRefreshInterval) {
            clearInterval(autoRefreshInterval);
            autoRefreshInterval = null;
        }
    }

    async function checkForUpdates() {
        try {
            const res = await fetch(`${API_BASE}/last-update`);
            if (!res.ok) return;
            const data = await res.json();
            if (lastKnownUpdate > 0 && data.lastUpdate > lastKnownUpdate) {
                // Data changed! Auto-refresh
                await loadData(true);
                showToast('🔄 Dữ liệu đã được cập nhật', 'info');
            }
            lastKnownUpdate = data.lastUpdate;
        } catch (err) {
            // Silently ignore polling errors
        }
    }

    // ==================== PASSWORD MANAGEMENT ====================
    function openPasswordModal() {
        document.getElementById('pw-new').value = '';
        document.getElementById('pw-modal').style.display = 'flex';
        document.getElementById('pw-new').focus();
    }

    function closePasswordModal() {
        document.getElementById('pw-modal').style.display = 'none';
    }

    async function handleChangePassword() {
        const newPw = document.getElementById('pw-new').value.trim();
        if (!newPw) {
            showToast('Vui lòng nhập mật khẩu mới!', 'error');
            return;
        }
        try {
            await apiCall('/change-password', 'POST', { newPassword: newPw });
            showToast('Đổi mật khẩu thành công! ✅', 'success');
            closePasswordModal();
        } catch (err) {
            showToast(err.message, 'error');
        }
    }

    // ==================== DELETION HISTORY ====================
    let deletedOrdersLoaded = false;

    function toggleDeletedOrders() {
        const content = document.getElementById('deleted-orders-content');
        const btn = document.getElementById('btn-toggle-deleted');
        if (content.style.display === 'none') {
            content.style.display = 'block';
            btn.textContent = 'Ẩn';
            if (!deletedOrdersLoaded) {
                loadDeletedOrders();
            }
        } else {
            content.style.display = 'none';
            btn.textContent = 'Hiện';
        }
    }

    async function loadDeletedOrders() {
        try {
            let res;
            if (isGuestMode) {
                res = await fetch(`${API_BASE}/orders/deleted`);
            } else {
                res = await fetch(`${API_BASE}/orders/deleted`, {
                    headers: { 'Authorization': `Bearer ${authToken}` },
                });
            }
            const deleted = await res.json();
            const tbody = document.getElementById('deleted-orders-tbody');
            const emptyEl = document.getElementById('deleted-empty');
            if (!deleted.length) {
                tbody.innerHTML = '';
                emptyEl.style.display = 'block';
                return;
            }
            emptyEl.style.display = 'none';
            tbody.innerHTML = deleted.map(o => `
                <tr style="opacity:0.8;">
                    <td><strong>#${o.id}</strong></td>
                    <td>${formatDate(o.deletedDate)}</td>
                    <td><span style="color:#f87171;font-weight:600;">${esc(o.deletedBy || '?')}</span></td>
                    <td>${esc(o.productName || '')}</td>
                    <td>${deliveryTypeBadge(o.deliveryType)}</td>
                    <td><strong>${o.quantity || 0}</strong> ${unitLabel(o.deliveryType)}</td>
                    <td>${formatDateShort(o.orderDate)}</td>
                </tr>
            `).join('');
            deletedOrdersLoaded = true;
        } catch (err) {
            showToast('Không thể tải lịch sử xóa', 'error');
        }
    }

    function handleAdminPwSubmit() {
        const pw = document.getElementById('admin-pw-input').value.trim();
        const ADMIN_PW = '2810';
        if (pw === ADMIN_PW) {
            document.getElementById('admin-pw-gate').style.display = 'none';
            document.getElementById('admin-users-list').style.display = 'block';
            document.getElementById('btn-refresh-users').style.display = '';
            document.getElementById('admin-pw-error').style.display = 'none';
            loadAdminUsers();
        } else {
            document.getElementById('admin-pw-error').style.display = 'block';
            document.getElementById('admin-pw-input').value = '';
            document.getElementById('admin-pw-input').focus();
        }
    }

    async function loadAdminUsers() {
        try {
            const res = await fetch(`${API_BASE}/users/public`);
            const users = await res.json();
            const tbody = document.getElementById('admin-users-tbody');
            const roleLabels = { sales: '🛒 Sales', mixer: '⚙️ Mixer', packing: '📦 Packing' };
            tbody.innerHTML = users.map(u => `
                <tr>
                    <td><strong>${esc(u.username)}</strong></td>
                    <td>${roleLabels[u.role] || u.role}</td>
                    <td>${esc(u.displayName)}</td>
                    <td><code style="background:rgba(124,58,237,0.2);padding:4px 12px;border-radius:6px;font-size:1rem;font-weight:700;color:#c4b5fd;">${esc(u.password)}</code></td>
                </tr>
            `).join('');
        } catch (err) {
            showToast('Không thể tải danh sách tài khoản', 'error');
        }
    }

    async function apiCall(url, method, body) {
        const res = await fetch(`${API_BASE}${url}`, {
            method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`,
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        if (res.status === 401) {
            handleLogout();
            return null;
        }
        const data = await res.json();
        if (!res.ok) {
            throw new Error(data.error || 'Lỗi không xác định');
        }
        return data;
    }

    // ==================== DASHBOARD ====================
    function renderDashboard() {
        const stats = {
            total: allOrders.length,
            waiting: allOrders.filter(o => o.status === 'Chờ sản xuất').length,
            produced: allOrders.filter(o => o.status === 'Hoàn thành SX' || o.status === 'Đang sản xuất').length,
            completed: allOrders.filter(o => o.status === 'Hoàn thành').length,
        };

        document.getElementById('stat-total').textContent = stats.total;
        document.getElementById('stat-waiting').textContent = stats.waiting;
        document.getElementById('stat-produced').textContent = stats.produced;
        document.getElementById('stat-completed').textContent = stats.completed;

        renderDashboardTable();
    }

    function renderDashboardTable() {
        const filter = document.getElementById('filter-status').value;
        let orders = allOrders;
        if (filter) {
            orders = orders.filter(o => o.status === filter);
        }

        const tbody = document.getElementById('dashboard-tbody');
        const empty = document.getElementById('dashboard-empty');

        if (orders.length === 0) {
            tbody.innerHTML = '';
            empty.style.display = 'block';
            return;
        }

        empty.style.display = 'none';
        tbody.innerHTML = orders.map(o => `
      <tr>
        <td><strong>#${o.id}</strong></td>
        <td>${formatDateShort(o.orderDate || o.createdDate)}</td>
        <td>${formatDateShort(o.pickupDate || o.deliveryDate)}</td>
        <td><strong>${esc(o.productName || o.productCode)}</strong></td>
        <td>${deliveryTypeBadge(o.deliveryType)}</td>
        <td>${o.quantity || 0} ${unitLabel(o.deliveryType)}</td>
        <td>${statusBadge(o.status)}</td>
      </tr>
    `).join('');
    }

    // ==================== SALES VIEW ====================
    function renderSalesView() {
        let orders = allOrders.filter(o => o.createdBy === currentUser.username);

        // Apply date filter
        if (salesDateFilter) {
            orders = orders.filter(o => {
                const orderDateStr = o.orderDate || o.createdDate || '';
                if (!orderDateStr) return false;
                const d = new Date(orderDateStr);
                const dateOnly = d.getFullYear() + '-' +
                    String(d.getMonth() + 1).padStart(2, '0') + '-' +
                    String(d.getDate()).padStart(2, '0');
                return dateOnly === salesDateFilter;
            });
        }

        const tbody = document.getElementById('sales-tbody');
        const empty = document.getElementById('sales-empty');

        if (orders.length === 0) {
            tbody.innerHTML = '';
            empty.style.display = 'block';
            return;
        }

        empty.style.display = 'none';
        tbody.innerHTML = orders.map(o => `
      <tr>
        <td>${formatTimeOnly(o.createdDate)}</td>
        <td>${formatDateShort(o.pickupDate || o.deliveryDate)}</td>
        <td><strong>${esc(o.productName || o.productCode)}</strong></td>
        <td>${esc(o.pelletType || '—')}</td>
        <td>${deliveryTypeBadge(o.deliveryType)}</td>
        <td><strong>${o.quantity || 0}</strong> ${unitLabel(o.deliveryType)}</td>
        <td>${statusBadge(o.status)}</td>
        <td>
          ${o.status === 'Chờ sản xuất' ? `
            <div class="table-actions">
              <button class="btn btn-danger btn-sm" onclick="app.deleteOrder(${o.id})" title="Xóa">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
              </button>
            </div>
          ` : ''}
        </td>
      </tr>
    `).join('');
    }

    async function handleCreateOrder(e) {
        e.preventDefault();

        const pickupDate = document.getElementById('sf-pickupDate').value;
        if (!pickupDate) {
            showToast('Vui lòng chọn Ngày lấy hàng!', 'error');
            document.getElementById('sf-pickupDate').focus();
            return;
        }

        const lines = getFilledLines();
        if (lines.length === 0) {
            showToast('Vui lòng nhập ít nhất 1 dòng sản phẩm (Tên cám + Số lượng)!', 'error');
            document.getElementById('line-product-1').focus();
            return;
        }

        // Validate each line
        for (let i = 0; i < lines.length; i++) {
            if (!lines[i].productName) {
                showToast(`Dòng ${i + 1}: Vui lòng nhập Tên cám!`, 'error');
                return;
            }
            if (!lines[i].quantity || lines[i].quantity <= 0) {
                showToast(`Dòng ${i + 1}: Vui lòng nhập Số lượng!`, 'error');
                return;
            }
        }

        const notes = document.getElementById('sf-notes').value.trim();
        const today = new Date().toISOString().split('T')[0];

        try {
            // Send batch of orders
            const body = {
                orderDate: today,
                pickupDate: pickupDate,
                notes: notes,
                items: lines,
            };

            await apiCall('/orders/batch', 'POST', body);
            showToast(`Đã tạo ${lines.length} đơn hàng thành công! ✅`, 'success');
            clearOrderLines();
            document.getElementById('sf-notes').value = '';
            await loadData();
        } catch (err) {
            showToast(err.message, 'error');
        }
    }

    async function deleteOrder(id) {
        if (!confirm('Bạn có chắc muốn xóa đơn hàng #' + id + '?')) return;
        try {
            await apiCall(`/orders/${id}`, 'DELETE');
            showToast('Đã xóa đơn hàng #' + id, 'success');
            await loadData();
        } catch (err) {
            showToast(err.message, 'error');
        }
    }

    // ==================== MIXER VIEW ====================
    function renderMixerView() {
        const waiting = allOrders.filter(o => o.status === 'Chờ sản xuất');
        const done = allOrders.filter(o => ['Đang sản xuất', 'Hoàn thành SX', 'Đang đóng gói', 'Hoàn thành'].includes(o.status));

        const cardsEl = document.getElementById('mixer-cards');
        const emptyEl = document.getElementById('mixer-empty');

        if (waiting.length === 0) {
            cardsEl.innerHTML = '';
            emptyEl.style.display = 'block';
        } else {
            emptyEl.style.display = 'none';
            cardsEl.innerHTML = waiting.map(o => `
        <div class="order-card card-waiting">
          <div class="order-card-header">
            <span class="order-card-id">#${o.id}</span>
            <span class="order-card-date">${formatDateShort(o.orderDate || o.createdDate)}</span>
          </div>
          <div class="order-card-body">
            <h4>${esc(o.productName || o.productCode)}</h4>
            ${o.pelletType ? `<div class="order-card-detail">⚙️ Dạng: <strong>${esc(o.pelletType)}</strong></div>` : ''}
            <div class="order-card-detail">📅 Lấy hàng: <strong>${formatDateShort(o.pickupDate || o.deliveryDate)}</strong></div>
            <div class="order-card-detail">🚚 Loại giao: <strong>${esc(o.deliveryType || '—')}</strong></div>
            <div class="order-card-detail">📦 Số lượng: <strong>${o.quantity || 0} ${unitLabel(o.deliveryType)}</strong></div>
            ${o.notes ? `<div class="order-card-detail">📝 ${esc(o.notes)}</div>` : ''}
          </div>
          <div class="order-card-actions">
            <div class="form-group">
              <label>Ghi chú sản xuất</label>
              <input type="text" id="mixer-note-${o.id}" placeholder="Ghi chú (tùy chọn)">
            </div>
          </div>
          <button class="btn btn-success card-confirm-btn" onclick="app.confirmMixer(${o.id})">
            ✅ Xác nhận hoàn thành sản xuất
          </button>
        </div>
      `).join('');
        }

        // Done table
        const doneTbody = document.getElementById('mixer-done-tbody');
        doneTbody.innerHTML = done.map(o => `
      <tr>
        <td><strong>#${o.id}</strong></td>
        <td><strong>${esc(o.productName || o.productCode)}</strong></td>
        <td>${deliveryTypeBadge(o.deliveryType)}</td>
        <td>${o.quantity || 0} ${unitLabel(o.deliveryType)}</td>
        <td>${o.mixerConfirmedDate ? formatDate(o.mixerConfirmedDate) : '—'}</td>
        <td>${esc(o.mixerNotes || '—')}</td>
        <td>${statusBadge(o.status)}</td>
      </tr>
    `).join('');
    }

    async function confirmMixer(id) {
        const notes = document.getElementById(`mixer-note-${id}`)?.value?.trim() || '';
        try {
            await apiCall(`/orders/${id}/mixer`, 'PUT', {
                status: 'Hoàn thành SX',
                mixerNotes: notes,
            });
            showToast(`Đã xác nhận sản xuất đơn #${id} ✅`, 'success');
            await loadData();
        } catch (err) {
            showToast(err.message, 'error');
        }
    }

    // ==================== PACKING VIEW ====================
    function renderPackingView() {
        const waiting = allOrders.filter(o => o.status === 'Hoàn thành SX');
        const done = allOrders.filter(o => o.status === 'Hoàn thành');

        const cardsEl = document.getElementById('packing-cards');
        const emptyEl = document.getElementById('packing-empty');

        if (waiting.length === 0) {
            cardsEl.innerHTML = '';
            emptyEl.style.display = 'block';
        } else {
            emptyEl.style.display = 'none';
            cardsEl.innerHTML = waiting.map(o => `
        <div class="order-card card-produced">
          <div class="order-card-header">
            <span class="order-card-id">#${o.id}</span>
            <span class="order-card-date">${formatDateShort(o.orderDate || o.createdDate)}</span>
          </div>
          <div class="order-card-body">
            <h4>${esc(o.productName || o.productCode)}</h4>
            ${o.pelletType ? `<div class="order-card-detail">⚙️ Dạng: <strong>${esc(o.pelletType)}</strong></div>` : ''}
            <div class="order-card-detail">📅 Lấy hàng: <strong>${formatDateShort(o.pickupDate || o.deliveryDate)}</strong></div>
            <div class="order-card-detail">🚚 Loại giao: <strong>${esc(o.deliveryType || '—')}</strong></div>
            <div class="order-card-detail">📦 Số lượng: <strong>${o.quantity || 0} ${unitLabel(o.deliveryType)}</strong></div>
            <div class="order-card-detail">🔧 Mixer: <strong>${esc(o.mixerConfirmedBy || '—')}</strong> · ${o.mixerConfirmedDate ? formatDate(o.mixerConfirmedDate) : ''}</div>
            ${o.mixerNotes ? `<div class="order-card-detail">📝 SX: ${esc(o.mixerNotes)}</div>` : ''}
          </div>
          <div class="card-action-row">
            <div class="form-group">
              <label>Ghi chú đóng gói</label>
              <input type="text" id="packing-note-${o.id}" placeholder="Ghi chú (tùy chọn)">
            </div>
          </div>
          <button class="btn btn-primary card-confirm-btn" onclick="app.confirmPacking(${o.id})">
            📦 Xác nhận đóng gói
          </button>
        </div>
      `).join('');
        }

        // Done table
        const doneTbody = document.getElementById('packing-done-tbody');
        doneTbody.innerHTML = done.map(o => `
      <tr>
        <td><strong>#${o.id}</strong></td>
        <td><strong>${esc(o.productName || o.productCode)}</strong></td>
        <td>${deliveryTypeBadge(o.deliveryType)}</td>
        <td>${o.quantity || 0} ${unitLabel(o.deliveryType)}</td>
        <td>${o.packingConfirmedDate ? formatDate(o.packingConfirmedDate) : '—'}</td>
        <td>${esc(o.packingNotes || '—')}</td>
        <td>${statusBadge(o.status)}</td>
      </tr>
    `).join('');
    }

    async function confirmPacking(id) {
        const notes = document.getElementById(`packing-note-${id}`)?.value?.trim() || '';

        try {
            await apiCall(`/orders/${id}/packing`, 'PUT', {
                packingNotes: notes,
            });
            showToast(`Đã xác nhận đóng gói đơn #${id} 📦`, 'success');
            await loadData();
        } catch (err) {
            showToast(err.message, 'error');
        }
    }

    // ==================== MODAL ====================
    function closeModal() {
        document.getElementById('confirm-modal').style.display = 'none';
    }

    // ==================== TOAST ====================
    function showToast(message, type = 'info') {
        const container = document.getElementById('toast-container');
        const icons = { success: '✅', error: '❌', info: 'ℹ️' };

        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.innerHTML = `
      <span class="toast-icon">${icons[type] || icons.info}</span>
      <span class="toast-message">${esc(message)}</span>
    `;

        container.appendChild(toast);
        setTimeout(() => {
            toast.classList.add('toast-out');
            setTimeout(() => toast.remove(), 300);
        }, 3500);
    }

    // ==================== HELPERS ====================
    function esc(str) {
        if (str == null) return '';
        const div = document.createElement('div');
        div.textContent = String(str);
        return div.innerHTML;
    }

    function formatDate(dateStr) {
        if (!dateStr) return '—';
        const d = new Date(dateStr);
        return d.toLocaleDateString('vi-VN', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit',
        });
    }

    function formatDateShort(dateStr) {
        if (!dateStr) return '—';
        const d = new Date(dateStr);
        return d.toLocaleDateString('vi-VN', {
            day: '2-digit', month: '2-digit', year: 'numeric',
        });
    }

    function formatTimeOnly(dateStr) {
        if (!dateStr) return '—';
        const d = new Date(dateStr);
        return d.toLocaleTimeString('vi-VN', {
            hour: '2-digit', minute: '2-digit',
        });
    }

    function statusBadge(status) {
        const map = {
            'Chờ sản xuất': 'waiting',
            'Đang sản xuất': 'producing',
            'Hoàn thành SX': 'produced',
            'Đang đóng gói': 'packing-status',
            'Hoàn thành': 'completed',
        };
        const cls = map[status] || 'waiting';
        return `<span class="status-badge ${cls}">${esc(status)}</span>`;
    }

    function unitLabel(deliveryType) {
        return deliveryType === 'Xe silo' ? 'Kg' : 'Bao';
    }

    function deliveryTypeBadge(type) {
        const icons = { 'Đại lý': '🏪', 'Trại': '🏠', 'Xe silo': '🚛' };
        const icon = icons[type] || '📦';
        return `<span class="delivery-badge">${icon} ${esc(type || '—')}</span>`;
    }

    // ==================== EXPOSE TO WINDOW ====================
    window.app = {
        deleteOrder,
        confirmMixer,
        confirmPacking,
    };
})();
