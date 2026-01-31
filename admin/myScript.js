import { initializeApp } from "firebase/app";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "firebase/auth";
import { getDatabase, ref, get, set } from "firebase/database";
import { getFunctions, httpsCallable } from "firebase/functions";

const firebaseConfig = {
	apiKey: "AIzaSyBM7oB0EkTjGJiOHdo67ByXA6qxVcvPS8Y",
	authDomain: "engrar3d.firebaseapp.com",
	databaseURL: "https://engrar3d-default-rtdb.europe-west1.firebasedatabase.app",
	projectId: "engrar3d",
	storageBucket: "engrar3d.firebasestorage.app",
	messagingSenderId: "68298863793",
	appId: "1:68298863793:web:ba7ec7ded3424b4c779e90",
	measurementId: "G-NLSV32JMM2"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);
const functions = getFunctions(app, 'europe-west1');

// Default Data Structure provided by the user (Fallback)
const DEFAULT_ADMIN_DATA = {
    // ... (Your existing default data structure, kept for fallback)
    "dashboard": { "stats": { "dailyRevenue": 0, "monthlyRevenue": 0 }, "live_status": { "message": "Sistem aktif." } },
    "orders": {},
    "inventory": { "filaments": {} },
    "finance": { "tax_tracking": { "limit": 2200000, "current_total": 0 } }
};

$(document).ready(function() {
    
    // --- AUTHENTICATION LOGIC ---

    // 1. Trigger Login Modal
    $('#admin-login-trigger').click(function() {
        const currentUser = auth.currentUser;
        if (!currentUser) {
             $('#login-modal').addClass('open');
        }
    });

    // 2. Handle Login Form Submit
    $('#admin-login-form').submit(async function(e) {
        e.preventDefault();
        
        const email = $('#login-email').val();
        const password = $('#login-password').val();
        const $btn = $(this).find('button[type="submit"]');
        const originalText = $btn.text();

        $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Giriş Yapılıyor...');

        try {
            await signInWithEmailAndPassword(auth, email, password);
            
            // Attempt READ to verify Admin Access
            const adminRef = ref(db, 'admin');
            const snapshot = await get(adminRef);
            
            showToast("Yönetici girişi başarılı.", "success");
            $('#login-modal').removeClass('open');

            let adminData = snapshot.val();

            if (!adminData) {
                console.log("Admin node empty. Seeding defaults...");
                await set(adminRef, DEFAULT_ADMIN_DATA);
                adminData = DEFAULT_ADMIN_DATA;
            }

            renderDashboard(adminData);
            
            // Trigger Fleet Refresh on Login
            refreshFleetStatus();

        } catch (error) {
            console.error("Login Error:", error);
            if (auth.currentUser) await signOut(auth);

            if (error.code === 'PERMISSION_DENIED' || error.message.includes('permission_denied')) {
                showToast("Hata: Lütfen admin hesabıyla giriş yapın.", "error");
            } else {
                showToast(error.message, "error");
            }
        } finally {
            $btn.prop('disabled', false).text(originalText);
        }
    });

    // 3. Logout Logic
    $('#admin-logout-btn').click(function(e) {
        e.stopPropagation();
        if(confirm('Çıkış yapmak istediğinize emin misiniz?')) {
            signOut(auth).then(() => {
                localStorage.removeItem('bambu_token'); // Clear stored token
                showToast("Başarıyla çıkış yapıldı.", "success");
                setTimeout(() => location.reload(), 1000); 
            }).catch((error) => {
                showToast("Çıkış hatası: " + error.message, "error");
            });
        }
    });

    // 4. Close Modal
    $('.modal-close, .modal-overlay').click(function(e) {
        if (e.target === this) {
            $('#login-modal').removeClass('open');
        }
    });

    // 5. Auth Observer
    onAuthStateChanged(auth, (user) => {
        if (user) {
            $('#admin-name').text(user.displayName || "Yönetici");
            $('#admin-role').text("Süper Admin");
            $('#admin-avatar').attr('src', user.photoURL || "../content/default_user.png");
            $('#admin-logout-btn').show();
            
            // Auto-load if session active
            loadDataIfAdmin();
        } else {
            $('#admin-name').text("Giriş Yap");
            $('#admin-role').text("Misafir");
            $('#admin-avatar').attr('src', "../content/default_user.png");
            $('#admin-logout-btn').hide();
        }
    });

    async function loadDataIfAdmin() {
        if (!auth.currentUser) return;
        try {
            const snapshot = await get(ref(db, 'admin'));
            if (snapshot.exists()) {
                renderDashboard(snapshot.val());
                refreshFleetStatus(); // Refresh devices on reload
            }
        } catch (error) {
            // Silent fail
        }
    }

    // --- NAVIGATION ---
    $('.nav-item').click(function() {
        $('.nav-item').removeClass('active');
        $(this).addClass('active');
        $('.content-section').hide().removeClass('active');
        const target = $(this).data('target');
        $(target).fadeIn(300).addClass('active');
    });

    // --- NEW: FLEET MANAGEMENT ---
    
    $('#btn-refresh-fleet').click(function() {
        refreshFleetStatus();
    });

    // --- 2FA MODAL HANDLER ---
    function promptFor2FA() {
        return new Promise((resolve) => {
            const $modal = $('#bambu-2fa-modal');
            const $form = $('#bambu-2fa-form');
            const $input = $('#bambu-2fa-code');
            const $close = $('#close-2fa-modal');
            const $resendBtn = $('#resend-2fa-code');
            const $timerSpan = $('#resend-timer');
            
            // 1. Remove ANY existing listeners to prevent stacking
            $form.off();
            $close.off();
            $resendBtn.off();

            let countdownInterval;

            // Timer Logic
            const startCountdown = () => {
                let timeLeft = 60;
                $resendBtn.css({ 'pointer-events': 'none', 'opacity': '0.5' });
                $timerSpan.text(`(${timeLeft}s)`);
                
                clearInterval(countdownInterval);
                countdownInterval = setInterval(() => {
                    timeLeft--;
                    if (timeLeft > 0) {
                        $timerSpan.text(`(${timeLeft}s)`);
                    } else {
                        clearInterval(countdownInterval);
                        $resendBtn.css({ 'pointer-events': 'auto', 'opacity': '1' });
                        $timerSpan.text('');
                    }
                }, 1000);
            };

            // Reset UI
            $input.val('');
            $modal.addClass('open');
            $input.focus();
            startCountdown();

            // Handle Submit
            const onSubmit = (e) => {
                e.preventDefault();
                const code = $input.val().trim();
                if (code) {
                    cleanup();
                    resolve(code);
                }
            };

            // Handle Resend (Direct Call)
            const onResend = async (e) => {
                e.preventDefault();
                $resendBtn.css({ 'pointer-events': 'none', 'opacity': '0.5' }); 
                showToast("Yeni kod talep ediliyor...", "info");

                try {
                    const getAllPrintersStatus = httpsCallable(functions, 'getAllPrintersStatus');
                    const result = await getAllPrintersStatus({}); 
                    
                    if (result.data && result.data.status === "NEEDS_CODE") {
                        showToast("Yeni doğrulama kodu gönderildi!", "success");
                        startCountdown(); 
                    } else {
                        // Success - We are logged in!
                        showToast("Bağlantı sağlandı!", "success");
                        cleanup();
                        resolve("RETRY"); // Signal to main loop to just retry fetch
                    }
                } catch (err) {
                    console.error("Resend Failed", err);
                    showToast("Kod gönderme başarısız: " + err.message, "error");
                    $resendBtn.css({ 'pointer-events': 'auto', 'opacity': '1' }); 
                }
            };

            // Handle Close/Cancel
            const onClose = () => {
                cleanup();
                resolve(null); 
            };

            const cleanup = () => {
                clearInterval(countdownInterval);
                $modal.removeClass('open');
                $form.off();
                $close.off();
                $resendBtn.off();
            };

            $form.on('submit', onSubmit);
            $close.on('click', onClose);
            $resendBtn.on('click', onResend);
        });
    }

    async function refreshFleetStatus(emailCode = null) {
        const $btn = $('#btn-refresh-fleet');
        const $icon = $btn.find('i');
        
        $btn.prop('disabled', true);
        $icon.addClass('fa-spin'); 

        try {
            const getAllPrintersStatus = httpsCallable(functions, 'getAllPrintersStatus');
            const cachedToken = localStorage.getItem('bambu_token');

            const result = await getAllPrintersStatus({ 
                emailCode: emailCode,
                authToken: cachedToken
            });
            
            // 1. Handle Verification Code Requirement
            if (result.data && result.data.status === "NEEDS_CODE") {
                $icon.removeClass('fa-spin');
                
                const code = await promptFor2FA();
                
                if (code === "RETRY") {
                    // Resend button successfully logged us in, just refresh data now
                    return refreshFleetStatus();
                } else if (code) {
                    // User entered a code manually
                    return refreshFleetStatus(code);
                } else {
                    // User cancelled
                    showToast("İşlem iptal edildi.", "error");
                    $btn.prop('disabled', false);
                    return; 
                }
            }

            // 2. Handle Success & Token Persistence
            const responseData = result.data || {};
            
            if (responseData.authToken) {
                localStorage.setItem('bambu_token', responseData.authToken);
                console.log("Bambu Token Updated/Cached");
            }

            const printers = responseData.printers || [];
            console.log("Printers Data:", printers);

            const $grid = $('#device-grid');
            $grid.empty();

            if (printers.length === 0) {
                $grid.html('<div style="grid-column:1/-1; text-align:center; padding:20px; color:#94A3B8;">Aktif yazıcı bulunamadı.</div>');
                return;
            }

            printers.forEach(p => {
                const isOnline = p.online;
                const statusClass = isOnline ? 'online' : 'offline';
                const progress = p.progress || 0;
                
                // Safety checks for temps
                const nozzleTemp = (p.temps && p.temps.nozzle) ? p.temps.nozzle : 0;
                const bedTemp = (p.temps && p.temps.bed) ? p.temps.bed : 0;

                const cardHtml = `
                    <div class="card device-card ${statusClass}">
                        <div class="device-header">
                            <div class="device-name">
                                <i class="fa-solid fa-print"></i> 
                                <span title="${p.serial || 'Unknown'}">${p.serial ? p.serial.substring(0, 10) + '...' : 'Unknown Device'}</span>
                            </div>
                            <span class="dot ${statusClass}"></span>
                        </div>
                        
                        <div class="device-stats">
                            <div class="stat">
                                <span class="label">Nozzle</span>
                                <span class="val">${nozzleTemp}°C</span>
                            </div>
                            <div class="stat">
                                <span class="label">Bed</span>
                                <span class="val">${bedTemp}°C</span>
                            </div>
                        </div>

                        <div style="margin-top: 15px;">
                            <div style="display:flex; justify-content:space-between; font-size:0.8rem; margin-bottom:5px;">
                                <strong style="color:var(--text-main);">${p.state || 'UNKNOWN'}</strong>
                                <span style="color:var(--text-muted);">${progress}%</span>
                            </div>
                            <div class="device-progress-bg">
                                <div class="device-progress-fill" style="width: ${progress}%;"></div>
                            </div>
                        </div>
                    </div>
                `;
                $grid.append(cardHtml);
            });

        } catch (error) {
            console.error("Fleet Refresh Error:", error);
            showToast("Filo durumu alınamadı: " + error.message, "error");
        } finally {
            // Stop loading ONLY if we are not recursing (i.e. we are done or failed)
            // But checking recursion depth is hard here.
            // Simplified: If we prompted for code, that block handles the return.
            // If we are here, we are either done success or done error.
            // Wait... if we recurse, the `await refreshFleetStatus(code)` happens inside the `if`.
            // The `finally` block of the OUTER call will execute after the inner call finishes.
            // So this is safe.
            $btn.prop('disabled', false);
            $icon.removeClass('fa-spin'); 
        }
    }

    // --- RENDER FUNCTION ---
    function renderDashboard(data) {
        // 1. Live Status & Revenue
        if (data.dashboard) {
             if(data.dashboard.live_status) $('#live-status-msg').text(data.dashboard.live_status.message);
             if(data.dashboard.stats) {
                 $('#rev-daily').text('₺' + (data.dashboard.stats.dailyRevenue || 0).toFixed(2));
                 $('#rev-monthly').text('₺' + (data.dashboard.stats.monthlyRevenue || 0).toFixed(2));
             }
        }

        // 3. Devices -> DISABLED (Handled by Cloud Function now)
        /* 
        const $deviceGrid = $('#device-grid');
        $deviceGrid.empty();
        if (data.devices) { ... }
        */

        // 4. Production Queue
        const $queue = $('#production-queue');
        $queue.empty();
        if (data.production_queue) {
            Object.values(data.production_queue).forEach(job => {
                $queue.append(`
                    <div class="queue-item" draggable="true">
                        <div class="drag-handle"><i class="fa-solid fa-grip-vertical"></i></div>
                        <div class="queue-info">
                            <strong>Job: ${job.job_id}</strong>
                            <span>${job.filename} • Priority: ${job.priority}</span>
                        </div>
                        <div class="queue-status">
                            <span class="badge badge-info">${job.status}</span>
                        </div>
                    </div>
                `);
            });
        }

        // 5. Stock
        const $stock = $('#stock-list-container');
        $stock.empty();
        if (data.inventory && data.inventory.filaments) {
            Object.values(data.inventory.filaments).forEach(fil => {
                $stock.append(`
                    <div class="stock-item">
                        <div class="stock-info">
                            <div class="color-indicator" style="background: ${fil.color.toLowerCase()};"></div>
                            <div class="stock-text">
                                <strong>${fil.type} ${fil.color}</strong>
                                <span>${fil.brand}</span>
                            </div>
                        </div>
                        <div class="stock-progress">
                             <div class="progress-bar-container">
                                <div class="progress-bar" style="width: ${(fil.remaining_g / 1000) * 100}%; background: ${fil.color.toLowerCase()};"></div>
                            </div>
                            <span class="stock-val">${fil.remaining_g}g / 1000g</span>
                        </div>
                    </div>
                `);
            });
        }

        // 6. Orders
        const $orderTable = $('#orders-table-body');
        $orderTable.empty();
        if (data.orders) {
            Object.entries(data.orders).forEach(([key, order]) => {
                $orderTable.append(`
                    <tr>
                        <td>${key}</td>
                        <td><span class="badge badge-warning">${order.status}</span></td>
                        <td>₺${order.total}</td>
                        <td>${order.user_id}</td>
                        <td><button class="btn-icon"><i class="fa-solid fa-ellipsis-vertical"></i></button></td>
                    </tr>
                `);
            });
        }

        // 7. Finance
        if (data.finance && data.finance.tax_tracking) {
            const tax = data.finance.tax_tracking;
            $('#tax-current').text(`Mevcut Satış: ₺${tax.current_total}`);
            $('#tax-limit').text(`Limit: ₺${tax.limit}`);
            const percent = (tax.current_total / tax.limit) * 100;
            $('#tax-bar').css('width', percent + '%');
            $('#tax-desc').html(`<i class="fa-solid fa-check-circle"></i> Muafiyet Kapsamındasınız (%${percent.toFixed(1)} Doldu)`);
        }
        
        // 8. Files
        const $files = $('#file-grid');
        $files.empty();
        if (data.files_library) {
             Object.values(data.files_library).forEach(file => {
                $files.append(`
                    <div class="file-card">
                        <div class="file-icon"><i class="fa-solid fa-cube"></i></div>
                        <div class="file-details">
                            <strong>${file.name}</strong>
                            <span>Ready</span>
                        </div>
                         <div class="file-actions">
                            <button class="btn-icon-sm"><i class="fa-solid fa-download"></i></button>
                        </div>
                    </div>
                `);
            });
        }
    }

    // --- DRAG DROP ---
    $('.queue-item').on('dragstart', function(e) { /* ... */ });
});

// Helper
function showToast(message, type = "info") {
    const $container = $('#toast-container');
    const id = Date.now();
    const icon = type === 'error' ? 'fa-circle-exclamation' : 'fa-circle-check';
    const toastHtml = `<div id="toast-${id}" class="toast ${type}"><i class="fa-solid ${icon} toast-icon"></i><span class="toast-message">${message}</span></div>`;
    $container.append(toastHtml);
    setTimeout(() => { $(`#toast-${id}`).addClass('hiding').remove(); }, 4000);
}
