// ==================== ORDER WORKFLOW APP ====================
(function () {
    'use strict';

    const API_BASE = window.location.origin + '/api';
    let currentUser = null;
    let authToken = null;
    let allOrders = [];
    let currentView = 'dashboard';

    // ==================== INITIALIZATION ====================
    document.addEventListener('DOMContentLoaded', init);

    function init() {
        // Check for saved session
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
    }

    // ==================== EVENT LISTENERS ====================
    function setupEventListeners() {
        // Login form
        document.getElementById('login-form').addEventListener('submit', handleLogin);

        // Logout
        document.getElementById('btn-logout').addEventListener('click', handleLogout);

        // Navigation
        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.addEventListener('click', () => switchView(btn.dataset.view));
        });

        // Sales form
        document.getElementById('sales-form').addEventListener('submit', handleCreateOrder);

        // Refresh
        document.getElementById('btn-refresh').addEventListener('click', loadData);

        // Filter
        document.getElementById('filter-status').addEventListener('change', renderDashboardTable);

        // Modal
        document.getElementById('modal-close').addEventListener('click', closeModal);
        document.getElementById('modal-cancel').addEventListener('click', closeModal);
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
        fetch(`${API_BASE}/logout`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${authToken}` },
        }).catch(() => { });
        authToken = null;
        currentUser = null;
        sessionStorage.removeItem('orderWorkflow');
        showLogin();
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

        // Set user info
        document.getElementById('user-name').textContent = currentUser.displayName;
        document.getElementById('header-role').textContent = currentUser.role.toUpperCase();
        document.getElementById('user-avatar').textContent = currentUser.username.charAt(0).toUpperCase();

        // Set default view based on role
        const roleViewMap = {
            sales: 'sales',
            mixer: 'mixer',
            packing: 'packing',
        };
        switchView(roleViewMap[currentUser.role] || 'dashboard');
        loadData();
    }

    function switchView(view) {
        currentView = view;
        // Update nav buttons
        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.view === view);
        });
        // Update views
        document.querySelectorAll('.view').forEach(v => {
            v.classList.toggle('active', v.id === `view-${view}`);
        });
        // Render the active view
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
    async function loadData() {
        try {
            const res = await fetch(`${API_BASE}/orders`, {
                headers: { 'Authorization': `Bearer ${authToken}` },
            });
            if (res.status === 401) {
                handleLogout();
                return;
            }
            allOrders = await res.json();
            renderCurrentView();
        } catch (err) {
            showToast('Không thể tải dữ liệu', 'error');
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
        <td>${totalBags(o)} bao</td>
        <td>${esc(o.siloTruck || '—')}</td>
        <td>${statusBadge(o.status)}</td>
      </tr>
    `).join('');
    }

    // ==================== SALES VIEW ====================
    function renderSalesView() {
        const orders = allOrders.filter(o => o.createdBy === currentUser.username);
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
        <td><strong>#${o.id}</strong></td>
        <td>${formatDateShort(o.orderDate || o.createdDate)}</td>
        <td>${formatDateShort(o.pickupDate || o.deliveryDate)}</td>
        <td><strong>${esc(o.productName || o.productCode)}</strong></td>
        <td>${totalBags(o)} bao</td>
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
        const form = e.target;

        const body = {
            orderDate: document.getElementById('sf-orderDate').value,
            pickupDate: document.getElementById('sf-pickupDate').value,
            productName: document.getElementById('sf-productName').value.trim(),
            pelletType: document.getElementById('sf-pelletType').value.trim(),
            bagHigro: parseInt(document.getElementById('sf-bagHigro').value) || 0,
            bagCp: parseInt(document.getElementById('sf-bagCp').value) || 0,
            bagStar: parseInt(document.getElementById('sf-bagStar').value) || 0,
            bagNuvo: parseInt(document.getElementById('sf-bagNuvo').value) || 0,
            bagNasa: parseInt(document.getElementById('sf-bagNasa').value) || 0,
            bagFarm: parseInt(document.getElementById('sf-bagFarm').value) || 0,
            siloTruck: document.getElementById('sf-siloTruck').value.trim(),
            notes: document.getElementById('sf-notes').value.trim(),
        };

        try {
            await apiCall('/orders', 'POST', body);
            showToast('Đã tạo đơn hàng thành công! ✅', 'success');
            form.reset();
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
            <div class="bag-summary">${bagSummary(o)}</div>
            ${o.siloTruck ? `<div class="order-card-detail">🚚 Xe silo: <strong>${esc(o.siloTruck)}</strong></div>` : ''}
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
        <td>${totalBags(o)} bao</td>
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
            <div class="bag-summary">${bagSummary(o)}</div>
            ${o.siloTruck ? `<div class="order-card-detail">🚚 Xe silo: <strong>${esc(o.siloTruck)}</strong></div>` : ''}
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
        <td>${totalBags(o)} bao</td>
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

    function totalBags(o) {
        return (o.bagHigro || 0) + (o.bagCp || 0) + (o.bagStar || 0) +
            (o.bagNuvo || 0) + (o.bagNasa || 0) + (o.bagFarm || 0);
    }

    function bagSummary(o) {
        const bags = [
            { name: 'Higro', val: o.bagHigro },
            { name: 'CP', val: o.bagCp },
            { name: 'Star', val: o.bagStar },
            { name: 'Nuvo', val: o.bagNuvo },
            { name: 'Nasa', val: o.bagNasa },
            { name: 'Farm', val: o.bagFarm },
        ].filter(b => b.val > 0);

        if (bags.length === 0) return '<div class="order-card-detail">📦 Chưa nhập số bao</div>';

        return bags.map(b =>
            `<div class="order-card-detail">📦 ${b.name}: <strong>${b.val} bao</strong></div>`
        ).join('');
    }

    // ==================== EXPOSE TO WINDOW ====================
    window.app = {
        deleteOrder,
        confirmMixer,
        confirmPacking,
    };
})();
