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
    let adminVerified = false;
    let dashboardWeekOffset = 0; // 0 = current week, -1 = last week, etc.

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

        // Week navigation
        document.getElementById('btn-week-prev')?.addEventListener('click', () => { dashboardWeekOffset--; renderDashboard(); });
        document.getElementById('btn-week-next')?.addEventListener('click', () => { dashboardWeekOffset++; renderDashboard(); });
        document.getElementById('btn-week-today')?.addEventListener('click', () => { dashboardWeekOffset = 0; renderDashboard(); });
        document.getElementById('btn-weekly-report')?.addEventListener('click', sendWeeklyReport);

        // Zalo settings
        document.getElementById('btn-zalo-save')?.addEventListener('click', handleZaloSave);
        document.getElementById('btn-zalo-test')?.addEventListener('click', handleZaloTest);
        document.getElementById('zalo-enabled')?.addEventListener('change', function () {
            document.getElementById('zalo-status-label').textContent = this.checked ? 'Đang bật ✅' : 'Đang tắt';
        });
        document.getElementById('btn-zalo-find-phone')?.addEventListener('click', handleZaloFindPhone);
        document.getElementById('btn-zalo-lookup')?.addEventListener('click', handleZaloLookup);
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
            // Zalo settings will show only after admin password is verified
            document.getElementById('zalo-settings-section').style.display = 'none';
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
            // Show Zalo settings after admin password verified
            document.getElementById('zalo-settings-section').style.display = 'block';
            loadZaloConfig();
            adminVerified = true;
            renderDashboardTable(); // Re-render to show late note inputs
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
    function getWeekRange(offset = 0) {
        const now = new Date();
        const day = now.getDay(); // 0=Sun, 1=Mon...
        const diffToMon = day === 0 ? -6 : 1 - day;
        const monday = new Date(now);
        monday.setDate(now.getDate() + diffToMon + (offset * 7));
        monday.setHours(0, 0, 0, 0);
        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);
        sunday.setHours(23, 59, 59, 999);
        return { monday, sunday };
    }

    function getOrdersInWeek(orders, offset) {
        const { monday, sunday } = getWeekRange(offset);
        return orders.filter(o => {
            const pickup = o.pickupDate || o.deliveryDate || '';
            if (!pickup) return false;
            const d = new Date(pickup);
            return d >= monday && d <= sunday;
        });
    }

    function renderDashboard() {
        const weekOrders = getOrdersInWeek(allOrders, dashboardWeekOffset);
        const stats = {
            total: weekOrders.length,
            waiting: weekOrders.filter(o => o.status === 'Chờ sản xuất').length,
            produced: weekOrders.filter(o => o.status === 'Hoàn thành SX' || o.status === 'Đang sản xuất').length,
            completed: weekOrders.filter(o => o.status === 'Hoàn thành').length,
        };

        document.getElementById('stat-total').textContent = stats.total;
        document.getElementById('stat-waiting').textContent = stats.waiting;
        document.getElementById('stat-produced').textContent = stats.produced;
        document.getElementById('stat-completed').textContent = stats.completed;

        renderWeeklyCalendar();
        renderDashboardTable();
    }

    function renderWeeklyCalendar() {
        const { monday, sunday } = getWeekRange(dashboardWeekOffset);
        const dayNames = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];
        const todayStr = new Date().toISOString().split('T')[0];
        const now = new Date();

        // Update week range label
        const fmtDate = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
        document.getElementById('week-range-label').textContent =
            `${fmtDate(monday)} — ${fmtDate(sunday)}/${sunday.getFullYear()}`;

        const container = document.getElementById('weekly-calendar');
        let html = '';

        for (let i = 0; i < 7; i++) {
            const d = new Date(monday);
            d.setDate(monday.getDate() + i);
            const dateStr = d.toISOString().split('T')[0];
            const isToday = dateStr === todayStr;

            // Orders by pickup date for this day
            const dayOrders = allOrders.filter(o => {
                const p = o.pickupDate || o.deliveryDate || '';
                if (!p) return false;
                return new Date(p).toISOString().split('T')[0] === dateStr;
            });

            const waiting = dayOrders.filter(o => o.status === 'Chờ sản xuất').length;
            const produced = dayOrders.filter(o => o.status === 'Hoàn thành SX' || o.status === 'Đang sản xuất').length;
            const completed = dayOrders.filter(o => o.status === 'Hoàn thành').length;
            const overdue = dayOrders.filter(o => {
                if (o.status === 'Hoàn thành') return false;
                return Math.floor((now - new Date(o.pickupDate || o.deliveryDate)) / 86400000) > 3;
            }).length;

            const classes = ['week-day-card'];
            if (isToday) classes.push('today');
            if (overdue > 0) classes.push('has-overdue');

            html += `<div class="${classes.join(' ')}">
                <div class="week-day-name">${dayNames[i]}</div>
                <div class="week-day-date">${d.getDate()}</div>
                <div class="week-day-orders">
                    ${dayOrders.length > 0 ? `<span class="week-day-badge total-badge">${dayOrders.length} đơn</span>` : '<span style="font-size:0.7rem;color:var(--text-muted);">—</span>'}
                    ${waiting > 0 ? `<span class="week-day-badge waiting">⏳ ${waiting}</span>` : ''}
                    ${produced > 0 ? `<span class="week-day-badge produced">🔧 ${produced}</span>` : ''}
                    ${completed > 0 ? `<span class="week-day-badge completed">✅ ${completed}</span>` : ''}
                    ${overdue > 0 ? `<span class="week-day-badge overdue">⚠️ ${overdue} trễ</span>` : ''}
                </div>
            </div>`;
        }
        container.innerHTML = html;
    }

    function renderDashboardTable() {
        const filter = document.getElementById('filter-status').value;
        let orders = getOrdersInWeek(allOrders, dashboardWeekOffset);
        if (filter) {
            orders = orders.filter(o => o.status === filter);
        }

        orders = sortByPickupDate(orders);
        const dateColorMap = buildDateColorMap(orders);

        const tbody = document.getElementById('dashboard-tbody');
        const empty = document.getElementById('dashboard-empty');

        if (orders.length === 0) {
            tbody.innerHTML = '';
            empty.style.display = 'block';
            return;
        }

        empty.style.display = 'none';
        const now = new Date();
        tbody.innerHTML = orders.map(o => {
            const pickupStr = formatDateShort(o.pickupDate || o.deliveryDate);
            const pickupColor = dateColorMap[pickupStr] || '#e2e8f0';
            const pickupRaw = o.pickupDate || o.deliveryDate || '';
            let overdueDays = 0;
            let isOverdue = false;
            if (pickupRaw && o.status !== 'Hoàn thành') {
                const pickupDate = new Date(pickupRaw);
                overdueDays = Math.floor((now - pickupDate) / (1000 * 60 * 60 * 24));
                isOverdue = overdueDays > 3;
            }
            const rowStyle = isOverdue ? 'background:rgba(239,68,68,0.12);' : '';
            const overdueTag = isOverdue ? `<span style="color:#ef4444;font-size:11px;"> ⚠️ Trễ ${overdueDays} ngày</span>` : '';
            const lateNoteCell = isOverdue
                ? (adminVerified
                    ? `<td><div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;">
                        <select id="late-reason-${o.id}" style="padding:4px 6px;border-radius:6px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.08);color:#fff;font-size:11px;">
                            <option value="" ${!o.lateReason ? 'selected' : ''}>Nguyên nhân...</option>
                            <option value="sales" ${o.lateReason === 'sales' ? 'selected' : ''}>Bán hàng</option>
                            <option value="mixer" ${o.lateReason === 'mixer' ? 'selected' : ''}>Mixer</option>
                            <option value="packing" ${o.lateReason === 'packing' ? 'selected' : ''}>Packing</option>
                        </select>
                        <input type="text" id="late-note-${o.id}" value="${esc(o.lateNote || '')}" placeholder="Chi tiết..." style="flex:1;min-width:80px;padding:4px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.08);color:#fff;font-size:12px;">
                        <button onclick="app.saveLateNote(${o.id})" style="padding:4px 8px;border-radius:6px;background:#a78bfa;color:#fff;border:none;cursor:pointer;font-size:11px;white-space:nowrap;">Lưu</button>
                       </div>${o.lateReason || o.lateNote ? `<div style="margin-top:2px;font-size:11px;color:#fbbf24;">${o.lateReason ? (o.lateReason === 'sales' ? '📝 Bán hàng' : o.lateReason === 'mixer' ? '🔧 Mixer' : '📦 Packing') : ''} ${esc(o.lateNote || '')}</div>` : ''}</td>`
                    : `<td style="font-size:12px;color:#fbbf24;">${o.lateReason || o.lateNote ? `${o.lateReason ? (o.lateReason === 'sales' ? '📝 ' : o.lateReason === 'mixer' ? '🔧 ' : '📦 ') : ''}${esc(o.lateNote || o.lateReason || '')}` : '<span style="color:#666;">Nhập MK QT để ghi chú</span>'}</td>`)
                : '<td></td>';
            return `
      <tr style="${rowStyle}">
        <td><strong>#${o.id}</strong></td>
        <td>${formatDateShort(o.orderDate || o.createdDate)}</td>
        <td style="color:${pickupColor};font-weight:600;">${pickupStr}${overdueTag}</td>
        <td><strong>${esc(o.productName || o.productCode)}</strong></td>
        <td>${deliveryTypeBadge(o.deliveryType)}</td>
        <td>${o.quantity || 0} ${unitLabel(o.deliveryType)}</td>
        <td>${statusBadge(o.status)}</td>
        ${lateNoteCell}
      </tr>`;
        }).join('');
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

        orders = sortByPickupDate(orders);
        const dateColorMap = buildDateColorMap(orders);

        const tbody = document.getElementById('sales-tbody');
        const empty = document.getElementById('sales-empty');

        if (orders.length === 0) {
            tbody.innerHTML = '';
            empty.style.display = 'block';
            return;
        }

        empty.style.display = 'none';
        tbody.innerHTML = orders.map(o => {
            const pickupStr = formatDateShort(o.pickupDate || o.deliveryDate);
            const pickupColor = dateColorMap[pickupStr] || '#e2e8f0';
            return `
      <tr>
        <td>${formatTimeOnly(o.createdDate)}</td>
        <td style="color:${pickupColor};font-weight:600;">${pickupStr}</td>
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
      </tr>`;
        }).join('');
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
        let waiting = allOrders.filter(o => o.status === 'Chờ sản xuất');
        let done = allOrders.filter(o => ['Đang sản xuất', 'Hoàn thành SX', 'Đang đóng gói', 'Hoàn thành'].includes(o.status));

        waiting = sortByPickupDate(waiting);
        done = sortByPickupDate(done);
        const waitingColorMap = buildDateColorMap(waiting);
        const doneColorMap = buildDateColorMap(done);

        const cardsEl = document.getElementById('mixer-cards');
        const emptyEl = document.getElementById('mixer-empty');

        if (waiting.length === 0) {
            cardsEl.innerHTML = '';
            emptyEl.style.display = 'block';
        } else {
            emptyEl.style.display = 'none';
            cardsEl.innerHTML = waiting.map(o => {
                const pickupStr = formatDateShort(o.pickupDate || o.deliveryDate);
                const pickupColor = waitingColorMap[pickupStr] || '#e2e8f0';
                return `
        <div class="order-card card-waiting">
          <div class="order-card-header">
            <span class="order-card-id">#${o.id}</span>
            <span class="order-card-date">${formatDateShort(o.orderDate || o.createdDate)}</span>
          </div>
          <div class="order-card-body">
            <h4>${esc(o.productName || o.productCode)}</h4>
            ${o.pelletType ? `<div class="order-card-detail">⚙️ Dạng: <strong>${esc(o.pelletType)}</strong></div>` : ''}
            <div class="order-card-detail">📅 Lấy hàng: <strong style="color:${pickupColor}">${pickupStr}</strong></div>
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
        </div>`;
            }).join('');
        }

        // Done table
        const doneTbody = document.getElementById('mixer-done-tbody');
        doneTbody.innerHTML = done.map(o => {
            const pickupStr = formatDateShort(o.pickupDate || o.deliveryDate);
            const pickupColor = doneColorMap[pickupStr] || '#e2e8f0';
            return `
      <tr>
        <td><strong>#${o.id}</strong></td>
        <td><strong>${esc(o.productName || o.productCode)}</strong></td>
        <td style="color:${pickupColor};font-weight:600;">${pickupStr}</td>
        <td>${deliveryTypeBadge(o.deliveryType)}</td>
        <td>${o.quantity || 0} ${unitLabel(o.deliveryType)}</td>
        <td>${o.mixerConfirmedDate ? formatDate(o.mixerConfirmedDate) : '—'}</td>
        <td>${esc(o.mixerNotes || '—')}</td>
        <td>${statusBadge(o.status)}</td>
      </tr>`;
        }).join('');
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
        let waiting = allOrders.filter(o => o.status === 'Hoàn thành SX');
        let done = allOrders.filter(o => o.status === 'Hoàn thành');

        waiting = sortByPickupDate(waiting);
        done = sortByPickupDate(done);
        const waitingColorMap = buildDateColorMap(waiting);
        const doneColorMap = buildDateColorMap(done);

        const cardsEl = document.getElementById('packing-cards');
        const emptyEl = document.getElementById('packing-empty');

        if (waiting.length === 0) {
            cardsEl.innerHTML = '';
            emptyEl.style.display = 'block';
        } else {
            emptyEl.style.display = 'none';
            cardsEl.innerHTML = waiting.map(o => {
                const pickupStr = formatDateShort(o.pickupDate || o.deliveryDate);
                const pickupColor = waitingColorMap[pickupStr] || '#e2e8f0';
                return `
        <div class="order-card card-produced">
          <div class="order-card-header">
            <span class="order-card-id">#${o.id}</span>
            <span class="order-card-date">${formatDateShort(o.orderDate || o.createdDate)}</span>
          </div>
          <div class="order-card-body">
            <h4>${esc(o.productName || o.productCode)}</h4>
            ${o.pelletType ? `<div class="order-card-detail">⚙️ Dạng: <strong>${esc(o.pelletType)}</strong></div>` : ''}
            <div class="order-card-detail">📅 Lấy hàng: <strong style="color:${pickupColor}">${pickupStr}</strong></div>
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
        </div>`;
            }).join('');
        }

        // Done table
        const doneTbody = document.getElementById('packing-done-tbody');
        doneTbody.innerHTML = done.map(o => {
            const pickupStr = formatDateShort(o.pickupDate || o.deliveryDate);
            const pickupColor = doneColorMap[pickupStr] || '#e2e8f0';
            return `
      <tr>
        <td><strong>#${o.id}</strong></td>
        <td><strong>${esc(o.productName || o.productCode)}</strong></td>
        <td style="color:${pickupColor};font-weight:600;">${pickupStr}</td>
        <td>${deliveryTypeBadge(o.deliveryType)}</td>
        <td>${o.quantity || 0} ${unitLabel(o.deliveryType)}</td>
        <td>${o.packingConfirmedDate ? formatDate(o.packingConfirmedDate) : '—'}</td>
        <td>${esc(o.packingNotes || '—')}</td>
        <td>${statusBadge(o.status)}</td>
      </tr>`;
        }).join('');
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
    async function saveLateNote(orderId) {
        const input = document.getElementById(`late-note-${orderId}`);
        const reasonSelect = document.getElementById(`late-reason-${orderId}`);
        if (!input) return;
        const lateNote = input.value.trim();
        const lateReason = reasonSelect ? reasonSelect.value : '';
        try {
            await apiCall(`/orders/${orderId}/late-note`, 'PUT', { lateNote, lateReason });
            showToast(`Đã lưu ghi chú trễ hẹn đơn #${orderId} ✅`, 'success');
            await loadData();
        } catch (err) {
            showToast(err.message, 'error');
        }
    }

    async function sendWeeklyReport() {
        const preview = document.getElementById('weekly-report-preview');
        preview.style.display = 'block';
        preview.innerHTML = 'Đang tạo báo cáo...';
        try {
            const res = await apiCall('/weekly-report', 'POST', { weekOffset: dashboardWeekOffset });
            if (res.success) {
                preview.innerHTML = `<div style="margin-bottom:12px;">
                    ${res.sent ? `<span style="color:#10b981;">\u2705 \u0110\u00e3 g\u1eedi qua Zalo (${res.groups} nh\u00f3m)</span>` : `<span style="color:#fbbf24;">⚠\ufe0f ${res.note}</span>`}
                </div><div style="border-top:1px solid var(--border);padding-top:12px;">${esc(res.message)}</div>`;
                showToast(res.sent ? 'Đã gửi tổng kết tuần qua Zalo! 📊' : 'Xem trước báo cáo (Zalo chưa bật)', res.sent ? 'success' : 'info');
            } else {
                preview.innerHTML = `<span style="color:#ef4444;">❌ ${res.error}</span>`;
                showToast(res.error, 'error');
            }
        } catch (err) {
            preview.innerHTML = `<span style="color:#ef4444;">❌ Lỗi: ${err.message}</span>`;
            showToast(err.message, 'error');
        }
    }

    const DATE_COLORS = [
        '#a78bfa', '#34d399', '#fbbf24', '#60a5fa',
        '#f472b6', '#fb923c', '#2dd4bf', '#c084fc',
    ];

    function sortByPickupDate(orders) {
        return [...orders].sort((a, b) => {
            const dateA = new Date(a.pickupDate || a.deliveryDate || '9999');
            const dateB = new Date(b.pickupDate || b.deliveryDate || '9999');
            return dateA - dateB;
        });
    }

    function buildDateColorMap(orders) {
        const uniqueDates = [...new Set(orders.map(o => formatDateShort(o.pickupDate || o.deliveryDate)))];
        const map = {};
        uniqueDates.forEach((d, i) => { map[d] = DATE_COLORS[i % DATE_COLORS.length]; });
        return map;
    }

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

    // ==================== ZALO SETTINGS ====================
    async function loadZaloConfig() {
        try {
            const res = await fetch(`${API_BASE}/zalo/config`);
            const config = await res.json();
            document.getElementById('zalo-enabled').checked = config.enabled || false;
            document.getElementById('zalo-status-label').textContent = config.enabled ? 'Đang bật ✅' : 'Đang tắt';
            document.getElementById('zalo-imei').value = config.imei || '';
            if (!config.cookies_set) {
                document.getElementById('zalo-cookies').value = '';
                document.getElementById('zalo-cookies').placeholder = 'Nhập Cookies từ tài khoản Zalo';
            } else {
                document.getElementById('zalo-cookies').value = '';
                document.getElementById('zalo-cookies').placeholder = '(Cookies đã lưu) Nhập mới để thay đổi';
            }
            document.getElementById('zalo-notify-mode').value = config.notify_mode || 'group';
            document.getElementById('zalo-user-id').value = config.user_id || '';
            document.getElementById('zalo-group-id').value = config.group_id || '';

            // Show cookie expiration warning
            const warningEl = document.getElementById('zalo-cookie-warning');
            if (warningEl && config.cookies_set) {
                const w = config.cookies_warning;
                const age = config.cookies_age_days;
                if (w === 'expired') {
                    warningEl.style.display = 'block';
                    warningEl.style.background = 'rgba(239,68,68,0.15)';
                    warningEl.style.border = '1px solid rgba(239,68,68,0.4)';
                    warningEl.style.color = '#fca5a5';
                    warningEl.innerHTML = `⚠️ <strong>Cookies đã hết hạn!</strong> (${age} ngày trước) — Vui lòng vào chat.zalo.me → extension → copy cookies mới → paste vào đây → Lưu`;
                } else if (w === 'expiring_soon') {
                    warningEl.style.display = 'block';
                    warningEl.style.background = 'rgba(245,158,11,0.15)';
                    warningEl.style.border = '1px solid rgba(245,158,11,0.4)';
                    warningEl.style.color = '#fcd34d';
                    warningEl.innerHTML = `⏳ <strong>Cookies sắp hết hạn</strong> (${age} ngày) — Nên cập nhật cookies mới sớm`;
                } else if (w === 'ok') {
                    warningEl.style.display = 'block';
                    warningEl.style.background = 'rgba(34,197,94,0.1)';
                    warningEl.style.border = '1px solid rgba(34,197,94,0.3)';
                    warningEl.style.color = '#86efac';
                    warningEl.innerHTML = `✅ Cookies còn mới (${age} ngày)`;
                } else {
                    warningEl.style.display = 'block';
                    warningEl.style.background = 'rgba(156,163,175,0.1)';
                    warningEl.style.border = '1px solid rgba(156,163,175,0.3)';
                    warningEl.style.color = '#9ca3af';
                    warningEl.innerHTML = `ℹ️ Chưa biết thời hạn cookies — Cập nhật cookies mới để bắt đầu theo dõi`;
                }
            } else if (warningEl) {
                warningEl.style.display = 'none';
            }
        } catch (err) {
            console.error('Load Zalo config failed:', err);
        }
    }

    async function handleZaloSave() {
        const config = {
            enabled: document.getElementById('zalo-enabled').checked,
            imei: document.getElementById('zalo-imei').value.trim(),
            notify_mode: document.getElementById('zalo-notify-mode').value,
            user_id: document.getElementById('zalo-user-id').value.trim(),
            group_id: document.getElementById('zalo-group-id').value.trim(),
        };
        // Only send cookies if user entered new value
        const cookies = document.getElementById('zalo-cookies').value.trim();
        if (cookies) {
            config.cookies = cookies;
        }
        try {
            const res = await fetch(`${API_BASE}/zalo/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config),
            });
            const data = await res.json();
            showToast('Đã lưu cấu hình Zalo! 💬', 'success');
            loadZaloConfig();
        } catch (err) {
            showToast('Lỗi lưu cấu hình: ' + err.message, 'error');
        }
    }

    async function handleZaloTest() {
        const resultEl = document.getElementById('zalo-result');
        resultEl.style.display = 'block';
        resultEl.style.color = 'var(--text-secondary)';
        resultEl.textContent = '⏳ Đang gửi tin nhắn test...';
        try {
            const res = await fetch(`${API_BASE}/zalo/test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            });
            const data = await res.json();
            if (data.success) {
                resultEl.style.color = '#4ade80';
                resultEl.textContent = '✅ ' + (data.message || 'Gửi thành công!');
            } else {
                resultEl.style.color = '#f87171';
                resultEl.textContent = '❌ ' + (data.error || 'Lỗi không xác định');
            }
        } catch (err) {
            resultEl.style.color = '#f87171';
            resultEl.textContent = '❌ Lỗi kết nối: ' + err.message;
        }
    }

    async function handleZaloFindPhone() {
        const phone = document.getElementById('zalo-phone').value.trim();
        if (!phone) { showToast('Vui lòng nhập số điện thoại', 'error'); return; }
        const resultEl = document.getElementById('zalo-phone-result');
        resultEl.style.display = 'block';
        resultEl.style.color = 'var(--text-secondary)';
        resultEl.textContent = '⏳ Đang tìm kiếm...';
        try {
            const res = await fetch(`${API_BASE}/zalo/find-phone`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone }),
            });
            const data = await res.json();
            if (data.success) {
                resultEl.style.color = '#4ade80';
                resultEl.innerHTML = `✅ <b>${data.name || 'User'}</b> — ID: <code style="background:rgba(255,255,255,0.1);padding:2px 6px;border-radius:4px;cursor:pointer;" onclick="document.getElementById('zalo-user-id').value='${data.user_id}';this.parentElement.innerHTML+=' → Đã điền vào User ID!'">${data.user_id}</code> (click để điền)`;
            } else {
                resultEl.style.color = '#f87171';
                resultEl.textContent = '❌ ' + data.error;
            }
        } catch (err) {
            resultEl.style.color = '#f87171';
            resultEl.textContent = '❌ Lỗi: ' + err.message;
        }
    }

    async function handleZaloLookup() {
        const resultEl = document.getElementById('zalo-lookup-result');
        resultEl.style.display = 'block';
        resultEl.style.color = 'var(--text-secondary)';
        resultEl.textContent = '⏳ Đang tải danh sách...';
        try {
            const res = await fetch(`${API_BASE}/zalo/lookup`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            });
            const data = await res.json();
            if (data.success) {
                let html = '';
                if (data.groups && data.groups.length) {
                    html += '<b>👥 Nhóm:</b><br>';
                    data.groups.forEach(g => {
                        html += `<span style="cursor:pointer;color:#a78bfa;" onclick="document.getElementById('zalo-group-id').value='${g.id}'">  ${g.name || 'Nhóm'} → <code>${g.id}</code></span><br>`;
                    });
                }
                if (data.contacts && data.contacts.length) {
                    html += '<b>👤 Liên hệ:</b><br>';
                    data.contacts.forEach(c => {
                        html += `<span style="cursor:pointer;color:#a78bfa;" onclick="document.getElementById('zalo-user-id').value='${c.id}'">  ${c.name || 'User'} → <code>${c.id}</code></span><br>`;
                    });
                }
                if (!html) html = 'Không tìm thấy nhóm hoặc liên hệ nào.';
                resultEl.style.color = 'var(--text-primary)';
                resultEl.innerHTML = html;
            } else {
                resultEl.style.color = '#f87171';
                resultEl.textContent = '❌ ' + data.error;
            }
        } catch (err) {
            resultEl.style.color = '#f87171';
            resultEl.textContent = '❌ Lỗi: ' + err.message;
        }
    }

    // ==================== EXPOSE TO WINDOW ====================
    window.app = {
        deleteOrder,
        confirmMixer,
        confirmPacking,
        saveLateNote,
    };
})();
