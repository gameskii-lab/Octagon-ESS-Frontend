// Global state
let currentStatus = 'OUT';
let currentLocation = null;
let currentEmployee = null;
let userEmail = '';
let hasCheckedInToday = false;
let config = {
    middlewareUrl: 'https://octagon-ess-production.up.railway.app',
    employeeId: '',
    employmentType: '',
    siteLat: null,
    siteLng: null,
    siteRadius: 100,
    shiftLocationName: '',
    todaysShift: null
};

// Safe DOM helper
const $ = id => document.getElementById(id);

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    // Force initial state
    if($('loginScreen')) $('loginScreen').style.display = 'block';
    ['dashboardScreen','leaveScreen','scheduleScreen','payslipsScreen','profileScreen'].forEach(id => {
        if($(id)) $(id).style.display = 'none';
    });
    if($('appHeader')) $('appHeader').style.display = 'none';

    getLocation();

    // Attach check-in listener safely
    const checkBtn = $('checkBtn');
    if (checkBtn) {
        checkBtn.addEventListener('click', async () => {
            if (!currentLocation) {
                showStatus('Location not available. Enable GPS.', 'error');
                getLocation();
                return;
            }
            
            // Check if inside geofence
            let isOffsite = false;
            let offsiteReason = '';
            let offsiteNotes = '';
            
            if (config.siteLat && config.siteLng) {
                const dist = calculateDistance(currentLocation.latitude, currentLocation.longitude, config.siteLat, config.siteLng);
                
                if (dist > config.siteRadius) {
                    // Outside geofence - show offsite popup
                    isOffsite = true;
                    const reason = await showOffsitePopup(dist);
                    if (!reason) {
                        showStatus('Check-in cancelled', 'info');
                        return; // User cancelled
                    }
                    offsiteReason = reason.reason;
                    offsiteNotes = reason.notes || '';
                }
            }
            
            checkBtn.disabled = true;
            checkBtn.textContent = 'Processing...';
            const logType = currentStatus === 'IN' ? 'OUT' : 'IN';
            
            try {
                const now = new Date();
                const timestamp = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
                
                const res = await fetch(`${config.middlewareUrl}/api/checkin`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        employeeId: config.employeeId, 
                        logType, 
                        timestamp, 
                        latitude: currentLocation.latitude, 
                        longitude: currentLocation.longitude,
                        isOffsite: isOffsite,
                        offsiteReason: offsiteReason,
                        offsiteNotes: offsiteNotes
                    })
                });
                const data = await res.json();
                if (data.success) {
                    currentStatus = logType;
                    hasCheckedInToday = true;
                    updateButtonState();
                    const msg = isOffsite ? `✅ Offsite check-${logType.toLowerCase()} recorded` : `✅ Checked ${logType.toLowerCase()} at ${now.toLocaleTimeString()}`;
                    showStatus(msg, 'success');
                } else {
                    throw new Error(data.error || 'Failed');
                }
            } catch (err) {
                showStatus(`❌ ${err.message}`, 'error');
            } finally {
                checkBtn.disabled = false;
                checkBtn.textContent = currentStatus === 'IN' ? 'CHECK OUT' : 'CHECK IN';
            }
        });
    }

    // Auto-login check
    const savedConfig = localStorage.getItem('erpnext_config');
    const savedEmp = localStorage.getItem('currentEmployee');
    const savedEmail = localStorage.getItem('userEmail');
    if (savedConfig && savedEmp && savedEmail) {
        config = JSON.parse(savedConfig);
        currentEmployee = JSON.parse(savedEmp);
        userEmail = savedEmail;
        config.customEmployeeBase = currentEmployee.custom_employee_base || '';
        updateGreetingName();
        updateDrawerInfo();
        showAppSection();
        await fetchTodaysShiftAssignment();
    }
});

function updateGreetingName() {
    const name = currentEmployee?.name || currentEmployee?.employee_name || 'Employee';
    const el = $('greetingText');
    if (el) el.textContent = `Hi, ${name}`;
}

function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function getLocation() {
    const el = $('locationDisplay');
    if (!navigator.geolocation) { if(el) el.textContent = '❌ GPS not supported'; return; }
    if(el) el.textContent = '📍 Requesting location...';
    navigator.geolocation.getCurrentPosition(pos => {
        currentLocation = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
        if(el) el.innerHTML = `📍 Lat: ${currentLocation.latitude.toFixed(6)}, Lng: ${currentLocation.longitude.toFixed(6)}`;
    }, err => {
        if(el) el.innerHTML = `❌ Location unavailable <button onclick="getLocation()" style="padding:4px 8px; margin-left:8px; font-size:12px; background:#2196F3; color:white; border:none; border-radius:4px;">Retry</button>`;
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
}

function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

async function handleLogin() {
    const email = $('loginEmail').value.trim();
    const password = $('loginPassword').value;
    if (!email || !password) return showStatus('Enter email and password', 'error');
    const btn = $('loginScreen').querySelector('button.submit-btn');
    if(btn) { btn.disabled = true; btn.textContent = 'Signing in...'; }
    try {
        const loginRes = await fetch(`${config.middlewareUrl}/api/login`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email, password}) });
        const loginData = await loginRes.json();
        if (!loginData.success) throw new Error(loginData.error || 'Invalid credentials');
        
        // Use the working debug endpoint as workaround
        const empRes = await fetch(`${config.middlewareUrl}/api/debug/employee-by-email/${encodeURIComponent(email)}`);
        const empData = await empRes.json();
        if (!empData.success) throw new Error(empData.error || 'Employee not found');
        
        currentEmployee = empData.employee;
        config.employeeId = currentEmployee.id;
        config.employmentType = currentEmployee.employment_type || 'Daily Wage';
        config.customEmployeeBase = currentEmployee.custom_employee_base || '';
        userEmail = email;
        
        localStorage.setItem('erpnext_config', JSON.stringify(config));
        localStorage.setItem('currentEmployee', JSON.stringify(currentEmployee));
        localStorage.setItem('userEmail', userEmail);
        
        updateGreetingName();
        updateDrawerInfo();
        showAppSection();
        await fetchTodaysShiftAssignment();
        showStatus(`Welcome, ${currentEmployee.name}!`, 'success');
    } catch (err) {
        showStatus(`Login error: ${err.message}`, 'error');
    } finally {
        if(btn) { btn.disabled = false; btn.textContent = 'Sign In'; }
    }
}

async function fetchTodaysShiftAssignment() {
    try {
        const res = await fetch(`${config.middlewareUrl}/api/shift-assignment/${config.employeeId}`);
        const data = await res.json();
        const ws = $('worksiteDisplay');
        const cb = $('checkBtn');
        
        if (data.success && data.assignment) {
            // Set shift type ALWAYS (even without location)
            config.todaysShift = data.assignment.shift_type;
            
            if (data.assignment.location) {
                const loc = data.assignment.location;
                config.siteLat = loc.latitude; config.siteLng = loc.longitude;
                config.siteRadius = loc.radius || 100; config.shiftLocationName = loc.name;
                if(ws) ws.innerHTML = `✅ ${loc.name} • 📏 ${config.siteRadius}m • 🕒 ${data.assignment.shift_type}`;
            } else {
                if(ws) ws.innerHTML = `🕒 ${data.assignment.shift_type} (No location set)`;
            }
            if(cb) cb.disabled = false;
            await checkCurrentStatus();
            await loadAttendanceStats();
        } else {
            config.todaysShift = null;
            if(ws) ws.innerHTML = '⚠️ No shift assigned';
            if(cb) cb.disabled = true;
        }
    } catch(e) {
        config.todaysShift = null;
        const ws = $('worksiteDisplay'); const cb = $('checkBtn');
        if(ws) ws.textContent = '❌ Error loading assignment';
        if(cb) cb.disabled = true;
    }
}

function showAppSection() {
    if($('loginScreen')) { $('loginScreen').classList.remove('active'); $('loginScreen').style.display = 'none'; }
    if($('dashboardScreen')) { $('dashboardScreen').classList.add('active'); $('dashboardScreen').style.display = 'block'; }
    if($('appHeader')) { $('appHeader').style.display = 'block'; }
    if($('screenTitle')) $('screenTitle').textContent = 'Dashboard';
    updateDrawerInfo();
    if (currentLocation) {
        const el = $('locationDisplay');
        if (el) el.innerHTML = `📍 Lat: ${currentLocation.latitude.toFixed(6)}, Lng: ${currentLocation.longitude.toFixed(6)}`;
    }
    const checkBtn = document.getElementById('checkBtn');
    const worksiteEl = document.getElementById('worksiteDisplay');
    
    if (config.customEmployeeBase === 'Office Based' && config.todaysShift === 'Office Shift') {
        
        // If already checked OUT today, hide button completely
        if (currentStatus === 'OUT' && isCheckinCompleted()) {
            if (checkBtn) checkBtn.style.display = 'none';
            if (worksiteEl) worksiteEl.textContent = '✅ You have completed your check-in for today.';
            return;
        }
        
        // If already checked IN today, show check-out button
        if (currentStatus === 'IN') {
            if (checkBtn) checkBtn.style.display = 'block';
            if (worksiteEl) worksiteEl.textContent = '📍 You are currently checked in. Tap to check out.';
            return;
        }
        
        // First check-in: validate time window
        const now = new Date();
        const currentTimeMinutes = now.getHours() * 60 + now.getMinutes();
        const shiftStartMinutes = 8 * 60;   // 8:00 AM
        const shiftEndMinutes = 17 * 60;    // 5:00 PM
        const bufferMinutes = 60;
        
        const checkinWindowStart = shiftStartMinutes - bufferMinutes;  // 7:00 AM
        const checkinWindowEnd = shiftEndMinutes + bufferMinutes;      // 6:00 PM
        
        const isWithinWindow = currentTimeMinutes >= checkinWindowStart && currentTimeMinutes <= checkinWindowEnd;
        
        if (isWithinWindow) {
            if (checkBtn) checkBtn.style.display = 'block';
            if (worksiteEl) worksiteEl.textContent = '📍 Ready to check in for today.';
        } else if (currentTimeMinutes > checkinWindowEnd) {
            if (checkBtn) checkBtn.style.display = 'none';
            if (worksiteEl) worksiteEl.textContent = '⚠️ Check-in window has closed for today. Your attendance will be processed based on your shift. Contact HR if you had extenuating circumstances.';
        } else {
            if (checkBtn) checkBtn.style.display = 'none';
            if (worksiteEl) worksiteEl.textContent = '⏰ Check-in opens at 7:00 AM.';
        }
    } else {
        if (checkBtn) checkBtn.style.display = 'none';
        if (worksiteEl) worksiteEl.textContent = '📍 Site staff - check-in not required';
    }
}

// Helper: Check if employee has completed check-in for today
function isCheckinCompleted() {
    // If status is OUT and there are already check-ins today, they've finished
    return currentStatus === 'OUT' && hasCheckedInToday === true;
}

async function checkCurrentStatus() {
    try {
        const res = await fetch(`${config.middlewareUrl}/api/today-checkins/${config.employeeId}`);
        const data = await res.json();
        if (data.success && data.checkins?.length) {
            currentStatus = data.checkins[data.checkins.length-1].log_type;
            updateButtonState();
        }
    } catch(e) {}
}

async function loadAttendanceStats() {
    try {
        const today = new Date().toISOString().split('T')[0];
        const res = await fetch(`${config.middlewareUrl}/api/today-checkins/${config.employeeId}`);
        const data = await res.json();
        
        if (data.success) {
            const checkins = data.checkins || [];
            const hasCheckedIn = checkins.length > 0;
            const lastLog = checkins.length > 0 ? checkins[checkins.length - 1].log_type : null;
            
            // Update present count
            const presentEl = document.getElementById('presentCount');
            if (presentEl) presentEl.textContent = hasCheckedIn && lastLog === 'OUT' ? 1 : 0;
            
            // Update late count (simplified - adjust based on your logic)
            const lateEl = document.getElementById('lateCount');
            if (lateEl) lateEl.textContent = 0; // You can add late detection later
            
            // Update absent count (simplified)
            const absentEl = document.getElementById('absentCount');
            if (absentEl) absentEl.textContent = hasCheckedIn ? 0 : 1;
        }
    } catch(e) {
        console.error('Error loading attendance stats:', e);
    }
}

function updateButtonState() {
    const btn = $('checkBtn');
    if(btn) {
        btn.textContent = currentStatus === 'IN' ? 'CHECK OUT' : 'CHECK IN';
        btn.className = `checkin-btn ${currentStatus === 'IN' ? 'check-out' : ''}`;
    }
}

function logout() {
    closeDrawer();
    localStorage.removeItem('erpnext_config');
    localStorage.removeItem('currentEmployee');
    localStorage.removeItem('userEmail');
    currentEmployee = null; userEmail = ''; config.employeeId = '';
    if($('appHeader')) $('appHeader').style.display = 'none';
    ['dashboardScreen','leaveScreen','payslipsScreen','scheduleScreen','profileScreen'].forEach(id => {
        if($(id)) { $(id).classList.remove('active'); $(id).style.display = 'none'; }
    });
    if($('loginScreen')) { $('loginScreen').classList.add('active'); $('loginScreen').style.display = 'block'; }
    if($('screenTitle')) $('screenTitle').textContent = 'Sign In';
    if($('loginEmail')) $('loginEmail').value = '';
    if($('loginPassword')) $('loginPassword').value = '';
    showStatus('Signed out', 'info');
}

// Show offsite check-in popup - returns {reason, notes} or null if cancelled
function showOffsitePopup(distance) {
    return new Promise((resolve) => {
        // Create overlay
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:2000;display:flex;align-items:flex-end;justify-content:center;';
        
        // Create popup
        const popup = document.createElement('div');
        popup.style.cssText = 'background:white;border-radius:20px 20px 0 0;padding:24px;max-width:450px;width:100%;max-height:80vh;overflow-y:auto;animation:slideUp 0.3s ease;';
        popup.innerHTML = `
            <style>
                @keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
            </style>
            <h3 style="margin:0 0 8px 0;">📍 Offsite Check-in</h3>
            <p style="color:#666;margin:0 0 16px 0;">You are ${Math.round(distance)}m from your base location. Please select a reason for checking in offsite.</p>
            
            <div style="margin-bottom:16px;">
                <label style="font-weight:600;display:block;margin-bottom:8px;">Reason *</label>
                <select id="offsiteReason" style="width:100%;padding:12px;border:1px solid #ddd;border-radius:8px;font-size:14px;">
                    <option value="">Select reason...</option>
                    <option value="Client Visit">🏢 Client Visit</option>
                    <option value="Offsite Meeting">📋 Offsite Meeting</option>
                    <option value="Field Work">🚗 Field Work</option>
                    <option value="Working from Home">🏠 Working from Home</option>
                    <option value="Other">✏️ Other</option>
                </select>
            </div>
            
            <div style="margin-bottom:16px;">
                <label style="font-weight:600;display:block;margin-bottom:8px;">Notes (optional)</label>
                <textarea id="offsiteNotes" rows="2" placeholder="Add any additional details..." style="width:100%;padding:12px;border:1px solid #ddd;border-radius:8px;font-size:14px;resize:none;"></textarea>
            </div>
            
            <p id="offsiteError" style="color:#f44336;text-align:center;display:none;margin-bottom:12px;">Please select a reason</p>
            
            <div style="display:flex;gap:10px;">
                <button id="offsiteCancel" style="flex:1;padding:14px;background:#f1f5f9;color:#475569;border:none;border-radius:12px;font-weight:600;cursor:pointer;">Cancel</button>
                <button id="offsiteConfirm" style="flex:1;padding:14px;background:#3b82f6;color:white;border:none;border-radius:12px;font-weight:600;cursor:pointer;">Continue Check-In</button>
            </div>
        `;
        
        overlay.appendChild(popup);
        document.body.appendChild(overlay);
        
        // Handle cancel
        document.getElementById('offsiteCancel').onclick = () => {
            document.body.removeChild(overlay);
            resolve(null);
        };
        
        // Handle confirm
        document.getElementById('offsiteConfirm').onclick = () => {
            const reason = document.getElementById('offsiteReason').value;
            const notes = document.getElementById('offsiteNotes').value;
            
            if (!reason) {
                document.getElementById('offsiteError').style.display = 'block';
                return;
            }
            
            document.body.removeChild(overlay);
            resolve({ reason, notes });
        };
        
        // Close on overlay click
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                document.body.removeChild(overlay);
                resolve(null);
            }
        });
    });
}

function showStatus(msg, type) {
    const el = $('statusMessage');
    if(!el) return console.log(`[${type}] ${msg}`);
    el.className = `status ${type}`; el.textContent = msg;
    setTimeout(() => { el.textContent = ''; el.className = ''; }, 4000);
}

function openDrawer() {
    if($('sideDrawer')) $('sideDrawer').classList.add('open');
    if($('drawerOverlay')) $('drawerOverlay').classList.add('open');
}
function closeDrawer() {
    if($('sideDrawer')) $('sideDrawer').classList.remove('open');
    if($('drawerOverlay')) $('drawerOverlay').classList.remove('open');
}

function navigateTo(screen) {
    closeDrawer();
    
    // 1. Hide all screens (Added approvalsScreen & onboardingScreen)
    ['loginScreen','dashboardScreen','leaveScreen','payslipsScreen','scheduleScreen','profileScreen','approvalsScreen','onboardingScreen'].forEach(id => {
        if($(id)) { $(id).classList.remove('active'); $(id).style.display = 'none'; }
    });

    // 2. Show target screen
    const target = $(screen + 'Screen');
    if(target) { target.classList.add('active'); target.style.display = 'block'; }

    // 3. Update Header Title (Added approvals & onboarding)
    const titles = {
        dashboard:'Dashboard',
        leave:'Leave',
        payslips:'Payslips',
        schedule:'Schedule',
        profile:'Profile',
        approvals:'Approvals',
        onboarding:'Onboarding'
    };
    if($('screenTitle')) $('screenTitle').textContent = titles[screen] || 'Octagon ESS';

    // 4. Load Data for specific screens (Added approvals & onboarding)
    if(screen==='leave' && typeof loadLeaveScreen==='function') loadLeaveScreen();
    if(screen==='schedule' && typeof loadScheduleScreen==='function') loadScheduleScreen();
    if(screen==='payslips' && typeof loadPayslipsScreen==='function') loadPayslipsScreen();
    if(screen==='profile' && typeof loadProfileScreen==='function') loadProfileScreen();
    
    // 🔥 ADDED: Approvals & Onboarding loaders
    if(screen==='approvals' && typeof loadApprovalsScreen==='function') loadApprovalsScreen();
    if(screen==='onboarding' && typeof loadOnboardingScreen==='function') loadOnboardingScreen();
}

function updateDrawerInfo() {
    const name = currentEmployee?.name || currentEmployee?.employee_name || 'Employee';
    const dept = currentEmployee?.department || 'N/A';
    if($('drawerEmployeeName')) $('drawerEmployeeName').textContent = name;
    if($('drawerEmployeeDept')) $('drawerEmployeeDept').textContent = dept;
}

// LEAVE
let currentLeaveTab = 'balance';
function switchLeaveTab(tab) {
    currentLeaveTab = tab;
    const tb = $('tabBalance'), tr = $('tabRequests'), bb = $('leaveBalanceTab'), rb = $('leaveRequestsTab');
    if(tab==='balance') {
        if(tb) tb.classList.add('active'); if(tr) tr.classList.remove('active');
        if(bb) bb.style.display='block'; if(rb) rb.style.display='none';
        loadLeaveBalance();
    } else {
        if(tr) tr.classList.add('active'); if(tb) tb.classList.remove('active');
        if(rb) rb.style.display='block'; if(bb) bb.style.display='none';
        loadLeaveRequests();
    }
}
function openLeaveApplyModal() { if($('leaveModalOverlay')) $('leaveModalOverlay').classList.add('active'); }
function closeLeaveApplyModal() { if($('leaveModalOverlay')) $('leaveModalOverlay').classList.remove('active'); }

async function loadLeaveScreen() { if(!config.employeeId) return; switchLeaveTab('balance'); }
async function loadLeaveBalance() {
    try {
        const response = await fetch(`${config.middlewareUrl}/api/leave-balance/${config.employeeId}`);
        const result = await response.json();
        
        const summaryEl = document.getElementById('leaveBalanceSummary');
        const leaveTypeSelect = document.getElementById('leaveType');
        if (!summaryEl) return;

        if (result.success && result.balances && result.balances.length > 0) {
            let html = '';
            
            result.balances.forEach((b, index) => {
                const allocated = b.leaves_allocated || 0;
                const taken = b.leaves_taken || 0;
                const available = allocated - taken;
                const usagePercent = allocated > 0 ? Math.round((taken / allocated) * 100) : 0;
                
                const gradients = [
                    ['#667eea', '#764ba2'],
                    ['#f093fb', '#f5576c'],
                    ['#4facfe', '#00f2fe'],
                    ['#43e97b', '#38f9d7'],
                    ['#fa709a', '#fee140'],
                    ['#a18cd1', '#fbc2eb']
                ];
                const [from, to] = gradients[index % gradients.length];
                
                html += `
                    <div class="leave-card" style="background:linear-gradient(135deg,${from},${to});">
                        <div class="leave-card-watermark">🏖️</div>
                        <div class="leave-card-content">
                            <div class="leave-card-type">${b.leave_type}</div>
                            <div class="leave-card-count">${available}</div>
                            <div class="leave-card-label">days available</div>
                            <div class="leave-card-bar"><div class="leave-card-fill" style="width:${usagePercent}%;"></div></div>
                            <div class="leave-card-used">${taken} of ${allocated} days used</div>
                        </div>
                    </div>
                `;
            });
            
            summaryEl.innerHTML = html;

            if (leaveTypeSelect) {
                leaveTypeSelect.innerHTML = '<option value="">Select Leave Type</option>';
                result.balances.forEach(b => {
                    const available = (b.leaves_allocated || 0) - (b.leaves_taken || 0);
                    if (available > 0) {
                        leaveTypeSelect.innerHTML += `<option value="${b.leave_type}">${b.leave_type} (${available} days)</option>`;
                    }
                });
            }
            loadUpcomingLeave();
        } else {
            summaryEl.innerHTML = `
                <div class="leave-empty">
                    <div class="leave-empty-icon">🏖️</div>
                    <p>No leave allocations found</p>
                    <span>Contact HR for leave entitlements</span>
                </div>`;
            if (leaveTypeSelect) leaveTypeSelect.innerHTML = '<option value="">No leave available</option>';
        }
    } catch (error) {
        console.error('Error loading leave balance:', error);
        const summaryEl = document.getElementById('leaveBalanceSummary');
        if (summaryEl) summaryEl.innerHTML = '<div class="leave-empty" style="color:var(--danger);">Error loading balance</div>';
    }
}

async function loadUpcomingLeave() {
    try {
        const response = await fetch(`${config.middlewareUrl}/api/leave-requests/${config.employeeId}`);
        const result = await response.json();
        const upcomingList = document.getElementById('upcomingLeaveList');
        if (!upcomingList) return;
        
        if (result.success && result.requests && result.requests.length > 0) {
            const approved = result.requests.filter(r => r.status === 'Approved');
            if (approved.length > 0) {
                upcomingList.innerHTML = '';
                approved.slice(0, 3).forEach(req => {
                    const div = document.createElement('div');
                    div.className = 'leave-request-item';
                    div.innerHTML = `<div style="display:flex;justify-content:space-between;"><strong>${req.leave_type}</strong><span>${req.from_date} → ${req.to_date}</span></div>`;
                    upcomingList.appendChild(div);
                });
            } else {
                upcomingList.innerHTML = '<p style="color:var(--text-secondary);text-align:center;padding:20px;">No upcoming leave</p>';
            }
        } else {
            upcomingList.innerHTML = '<p style="color:var(--text-secondary);text-align:center;padding:20px;">No upcoming leave</p>';
        }
    } catch (error) {
        console.error('Error loading upcoming leave:', error);
        const upcomingList = document.getElementById('upcomingLeaveList');
        if (upcomingList) upcomingList.innerHTML = '<p style="color:var(--text-secondary);text-align:center;padding:20px;">Error loading</p>';
    }
}

async function loadLeaveRequests() {
    try {
        const res = await fetch(`${config.middlewareUrl}/api/leave-requests/${config.employeeId}`);
        const data = await res.json();
        const el = document.getElementById('leaveRequestsList');
        if (!el) return;

        if (data.success && data.requests && data.requests.length > 0) {
            let html = '';
            data.requests.forEach(req => {
                const statusClass = req.status === 'Approved' ? 'status-approved' : 
                                   req.status === 'Rejected' ? 'status-rejected' : 'status-pending';
                html += `
                    <div class="leave-request-item" onclick="viewLeaveDetail('${req.name}')" style="cursor:pointer;">
                        <div style="display:flex;justify-content:space-between;align-items:center;">
                            <div>
                                <strong>${req.leave_type}</strong>
                                <div style="font-size:12px;color:var(--text-secondary);">${req.from_date} → ${req.to_date}</div>
                            </div>
                            <span class="leave-status ${statusClass}">${req.status}</span>
                        </div>
                    </div>
                `;
            });
            el.innerHTML = html;
        } else {
            el.innerHTML = '<p style="text-align:center;padding:20px;color:var(--text-secondary);">No leave requests found</p>';
        }
    } catch(e) {
        const el = document.getElementById('leaveRequestsList');
        if (el) el.innerHTML = '<p style="text-align:center;padding:20px;color:var(--text-secondary);">Error loading requests</p>';
    }
}

async function viewLeaveDetail(docname) {
    try {
        const response = await fetch(`${config.middlewareUrl}/api/leave-requests/${config.employeeId}`);
        const result = await response.json();
        
        const request = (result.requests || []).find(r => r.name === docname);
        if (!request) {
            showStatus('Request not found', 'error');
            return;
        }
        
        // Hide tabs and show detail
        const balanceTab = document.getElementById('leaveBalanceTab');
        const requestsTab = document.getElementById('leaveRequestsTab');
        const detailView = document.getElementById('leaveDetailView');
        const applyBtn = document.querySelector('#leaveScreen .fab');
        
        if (balanceTab) balanceTab.style.display = 'none';
        if (requestsTab) requestsTab.style.display = 'none';
        if (detailView) detailView.style.display = 'block';
        if (applyBtn) applyBtn.style.display = 'none';
        
        const statusClass = request.status === 'Approved' ? 'status-approved' : 
                           request.status === 'Rejected' ? 'status-rejected' : 'status-pending';
        
        document.getElementById('leaveDetailContent').innerHTML = `
            <div style="text-align:center;margin-bottom:20px;">
                <span class="leave-status ${statusClass}" style="font-size:16px;padding:8px 20px;">${request.status}</span>
            </div>
            <h3 style="text-align:center;margin-bottom:16px;">${request.leave_type}</h3>
            <div class="hours-row"><span>From:</span><span>${request.from_date}</span></div>
            <div class="hours-row"><span>To:</span><span>${request.to_date}</span></div>
            <div class="hours-row"><span>Days:</span><span>${request.total_leave_days || 'N/A'}</span></div>
            <div class="hours-row"><span>Status:</span><span class="leave-status ${statusClass}">${request.status}</span></div>
            ${request.description ? `<div class="hours-row"><span>Reason:</span><span>${request.description}</span></div>` : ''}
        `;
    } catch (error) {
        console.error('Error viewing leave detail:', error);
        showStatus('Error loading details', 'error');
    }
}

function closeLeaveDetail() {
    const balanceTab = document.getElementById('leaveBalanceTab');
    const requestsTab = document.getElementById('leaveRequestsTab');
    const detailView = document.getElementById('leaveDetailView');
    const applyBtn = document.querySelector('#leaveScreen .fab');
    
    if (detailView) detailView.style.display = 'none';
    if (applyBtn) applyBtn.style.display = 'block';
    
    // Restore current tab
    if (currentLeaveTab === 'balance') {
        if (balanceTab) balanceTab.style.display = 'block';
        if (requestsTab) requestsTab.style.display = 'none';
    } else {
        if (balanceTab) balanceTab.style.display = 'none';
        if (requestsTab) requestsTab.style.display = 'block';
    }
}

async function submitLeaveApplication() {
    // Safe element retrieval
    const leaveTypeSelect = document.getElementById('leaveType');
    const leaveType = leaveTypeSelect?.options[leaveTypeSelect.selectedIndex]?.value || '';
    const fromDate = document.getElementById('leaveFromDate')?.value;
    const toDate = document.getElementById('leaveToDate')?.value;
    const reason = document.getElementById('leaveReason')?.value;
    const errorEl = document.getElementById('leaveModalError');
    
    if (errorEl) errorEl.style.display = 'none';

    if (!leaveType || !fromDate || !toDate || !reason) {
        if (errorEl) {
            errorEl.textContent = 'Please fill all fields';
            errorEl.style.display = 'block';
        }
        return;
    }

    // 🔥 FIX: Robust selector that works even if ID is missing
    // Looks for button inside .modal-content first, then falls back to #leaveApplyModal
    const submitBtn = document.querySelector('.modal-content button.submit-btn') || 
                      document.querySelector('#leaveApplyModal button');
    
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Submitting...';
    }

    try {
        const response = await fetch(`${config.middlewareUrl}/api/leave-application`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                employeeId: config.employeeId,
                leaveType: leaveType,
                fromDate: fromDate,
                toDate: toDate,
                reason: reason
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            closeLeaveApplyModal();
            showStatus('✅ Leave request submitted!', 'success');
            
            // Clear form safely
            if (leaveTypeSelect) leaveTypeSelect.value = '';
            const fromDateEl = document.getElementById('leaveFromDate');
            const toDateEl = document.getElementById('leaveToDate');
            const reasonEl = document.getElementById('leaveReason');
            if (fromDateEl) fromDateEl.value = '';
            if (toDateEl) toDateEl.value = '';
            if (reasonEl) reasonEl.value = '';
            
            // Refresh leave data
            if (typeof loadLeaveBalance === 'function') loadLeaveBalance();
        } else {
            throw new Error(result.error || 'Failed to submit');
        }
    } catch (error) {
        console.error('Leave submission error:', error);
        if (errorEl) {
            errorEl.textContent = error.message;
            errorEl.style.display = 'block';
        }
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Submit Request';
        }
    }
}

// ============================================
// SCHEDULE FUNCTIONS
// ============================================
let currentMonth = new Date().getMonth();
let currentYear = new Date().getFullYear();
let scheduleData = { shifts: [], leaves: [], holidays: [] };

function changeMonth(delta) {
    currentMonth += delta;
    if (currentMonth > 11) { currentMonth = 0; currentYear++; }
    else if (currentMonth < 0) { currentMonth = 11; currentYear--; }
    renderCalendar();
}

async function loadScheduleScreen() {
    if (!config.employeeId) return;
    const listEl = document.getElementById('scheduleList');
    if (listEl) listEl.innerHTML = '<p style="text-align:center;padding:20px;color:var(--text-secondary);">Loading...</p>';

    try {
        const response = await fetch(`${config.middlewareUrl}/api/schedule/${config.employeeId}`);
        const result = await response.json();
        if (result.success) {
            scheduleData = result;
            currentMonth = new Date().getMonth();
            currentYear = new Date().getFullYear();
            renderCalendar();
            renderUpcomingShifts();
        } else {
            if (listEl) listEl.innerHTML = '<p style="text-align:center;padding:20px;color:var(--text-secondary);">No schedule data</p>';
        }
    } catch (error) {
        console.error('Schedule error:', error);
        if (listEl) listEl.innerHTML = '<p style="text-align:center;padding:20px;color:var(--text-secondary);">Error loading schedule</p>';
    }
}

function renderCalendar() {
    const monthEl = document.getElementById('calendarMonth');
    const gridEl = document.getElementById('calendarGrid');
    if (!monthEl || !gridEl) return;

    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    monthEl.textContent = `${monthNames[currentMonth]} ${currentYear}`;

    const firstDay = (new Date(currentYear, currentMonth, 1).getDay() + 6) % 7;
    const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
    const today = new Date().toISOString().split('T')[0];

    let gridHTML = '';
    // Day headers (Mon-Sun)
    const dayHeaders = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    gridHTML += '<div style="display:contents;">';
    dayHeaders.forEach(d => {
        gridHTML += `<div style="font-weight:bold;font-size:11px;color:var(--text-secondary);text-align:center;padding:4px 0;">${d}</div>`;
    });
    gridHTML += '</div>';
    for (let i = 0; i < firstDay; i++) gridHTML += '<div></div>';

    for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        let status = 'off', label = '';

        if (scheduleData.shifts?.some(s => dateStr >= s.start_date && dateStr <= s.end_date)) {
            status = 'work'; label = 'Shift';
        }
        if (scheduleData.leaves?.some(l => dateStr >= l.from_date && dateStr <= l.to_date)) {
            status = 'leave'; label = 'Leave';
        }
        if (scheduleData.holidays?.some(h => h.holiday_date === dateStr)) {
            status = 'holiday'; label = 'Holiday';
        }

        const isToday = dateStr === today;
        const colors = { work: '#d1fae5', leave: '#fef3c7', holiday: '#fee2e2', off: '#f1f5f9' };
        const textColors = { work: '#065f46', leave: '#92400e', holiday: '#991b1b', off: '#64748b' };

        gridHTML += `
            <div onclick="showDayDetail('${dateStr}')" style="padding:8px 4px;border-radius:8px;background:${colors[status]};cursor:pointer;text-align:center;${isToday ? 'border:2px solid var(--primary);' : ''}">
                <div style="font-size:13px;font-weight:${isToday ? '700' : '500'};color:${textColors[status]};">${day}</div>
                ${label ? `<div style="font-size:9px;color:${textColors[status]};margin-top:2px;">${label}</div>` : ''}
            </div>
        `;
    }
    gridEl.innerHTML = gridHTML;
}

function showDayDetail(dateStr) {
    const detail = document.getElementById('dayDetail');
    const title = document.getElementById('dayDetailTitle');
    const content = document.getElementById('dayDetailContent');
    if (!detail || !title || !content) return;

    title.textContent = `📅 ${dateStr}`;
    let html = '', found = false;

    scheduleData.shifts?.forEach(s => {
        if (dateStr >= s.start_date && dateStr <= s.end_date) {
            found = true;
            html += `<div class="leave-request-item" style="border-left:4px solid var(--success);margin-bottom:8px;"><strong>🟢 Work</strong><div>${s.shift_type || 'Assigned Shift'}</div></div>`;
        }
    });
    scheduleData.leaves?.forEach(l => {
        if (dateStr >= l.from_date && dateStr <= l.to_date) {
            found = true;
            html += `<div class="leave-request-item" style="border-left:4px solid var(--warning);margin-bottom:8px;"><strong>🟡 Leave</strong><div>${l.leave_type}</div></div>`;
        }
    });
    scheduleData.holidays?.forEach(h => {
        if (h.holiday_date === dateStr) {
            found = true;
            html += `<div class="leave-request-item" style="border-left:4px solid var(--danger);margin-bottom:8px;"><strong>🔴 Holiday</strong><div>${h.description || 'Holiday'}</div></div>`;
        }
    });

    content.innerHTML = found ? html : '<p style="text-align:center;color:var(--text-secondary);">No events</p>';
    detail.classList.remove('hidden');
}

function hideDayDetail() {
    const detail = document.getElementById('dayDetail');
    if (detail) detail.classList.add('hidden');
}

function renderUpcomingShifts() {
    const listEl = document.getElementById('scheduleList');
    if (!listEl) return;

    if (!scheduleData.shifts || scheduleData.shifts.length === 0) {
        listEl.innerHTML = '<p style="text-align:center;padding:20px;color:var(--text-secondary);">No upcoming shifts</p>';
        return;
    }

    let html = '';
    scheduleData.shifts.slice(0, 5).forEach(s => {
        html += `
            <div class="leave-request-item">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <strong>${s.shift_type || 'Shift'}</strong>
                    <span class="leave-status status-approved">Confirmed</span>
                </div>
                <div style="font-size:13px;color:var(--text-secondary);margin-top:4px;">📅 ${s.start_date} to ${s.end_date}</div>
                ${s.shift_location ? `<div style="font-size:13px;color:var(--text-secondary);">📍 ${s.shift_location}</div>` : ''}
            </div>
        `;
    });
    listEl.innerHTML = html;
}

// PAYSLIPS
async function loadPayslipsScreen() {
    if(!config.employeeId) return;
    try {
        const res = await fetch(`${config.middlewareUrl}/api/payslips/${config.employeeId}`);
        const data = await res.json();
        const el = $('payslipsList');
        if(data.success && data.payslips?.length) {
            el.innerHTML = '';
            data.payslips.forEach(s => {
                el.innerHTML += `<div class="leave-request-item"><div style="display:flex;justify-content:space-between;"><strong>${s.period}</strong><span style="font-weight:700;color:var(--success);">${new Intl.NumberFormat('en-US',{style:'currency',currency:'BND'}).format(s.net_pay)}</span></div><div style="font-size:12px;color:var(--text-secondary);">Gross: ${new Intl.NumberFormat('en-US',{style:'currency',currency:'BND'}).format(s.gross_pay)} • Ded: ${new Intl.NumberFormat('en-US',{style:'currency',currency:'BND'}).format(s.total_deduction)}</div></div>`;
            });
        } else { if(el) el.innerHTML = '<p style="text-align:center;padding:20px;color:var(--text-secondary);">No payslips</p>'; }
    } catch(e) { if($('payslipsList')) $('payslipsList').innerHTML = '<p style="text-align:center;padding:20px;">Error</p>'; }
}

// ============================================
// APPROVAL FUNCTIONS
// ============================================
let currentApprovalDoc = null;

async function loadApprovalsScreen() {
    const listEl = document.getElementById('approvalsList');
    const detailEl = document.getElementById('approvalDetail');
    
    // Reset view
    if (listEl) listEl.innerHTML = '<p style="color:var(--text-secondary);text-align:center;padding:20px;">Loading approvals...</p>';
    if (detailEl) { detailEl.classList.add('hidden'); detailEl.style.display = 'none'; }

    try {
        if (!userEmail) {
            console.error('User email not set');
            return;
        }
        
        const response = await fetch(`${config.middlewareUrl}/api/approvals/${encodeURIComponent(userEmail)}`);
        const result = await response.json();

        if (result.success && result.approvals && result.approvals.length > 0) {
            let html = '';
            result.approvals.forEach(approval => {
                html += `
                    <div class="leave-request-item" style="cursor:pointer;margin-bottom:10px;" onclick="viewApproval('${approval.doctype}', '${approval.docname}', '${approval.next_action || 'Approve'}')">
                        <div style="display:flex;justify-content:space-between;align-items:center;">
                            <div>
                                <strong style="font-size:15px;">${approval.title}</strong>
                                <div style="font-size:12px;color:var(--text-secondary);margin-top:2px;">${approval.doctype} • ${approval.state || 'Pending'}</div>
                            </div>
                            <span class="leave-status status-pending">View →</span>
                        </div>
                    </div>
                `;
            });
            if (listEl) listEl.innerHTML = html;
        } else {
            if (listEl) listEl.innerHTML = '<p style="color:var(--text-secondary);text-align:center;padding:20px;">No pending approvals</p>';
        }
    } catch (error) {
        console.error('Approval load error:', error);
        if (listEl) listEl.innerHTML = '<p style="color:var(--text-secondary);text-align:center;padding:20px;">Error loading approvals</p>';
    }
}

async function viewApproval(doctype, docname, nextAction) {
    currentApprovalDoc = { doctype, docname, nextAction };
    const detailEl = document.getElementById('approvalDetail');
    const titleEl = document.getElementById('approvalDetailTitle');
    const printViewEl = document.getElementById('approvalPrintView');
    const approveBtn = document.getElementById('approveBtn');
    const rejectBtn = document.getElementById('rejectBtn');

    if (detailEl) { 
        detailEl.classList.remove('hidden'); 
        detailEl.style.display = 'block'; 
    }
    
    if (titleEl) titleEl.textContent = `${doctype}: ${docname}`;
    if (printViewEl) printViewEl.innerHTML = '<p style="text-align:center;padding:20px;color:var(--text-secondary);">Loading document...</p>';
    if (approveBtn) { approveBtn.style.display = 'block'; approveBtn.textContent = `✅ ${nextAction || 'Approve'}`; }
    if (rejectBtn) rejectBtn.style.display = 'block';

    // Fetch Document Print Format
    try {
        const response = await fetch(`${config.middlewareUrl}/api/print-format/${doctype}/${docname}`);
        const result = await response.json();
        if (result.success && result.html) {
            if (printViewEl) printViewEl.innerHTML = result.html;
        } else {
            if (printViewEl) printViewEl.innerHTML = '<p style="text-align:center;padding:20px;color:var(--text-secondary);">Could not load document</p>';
        }
    } catch (error) {
        console.error('Print format error:', error);
        if (printViewEl) printViewEl.innerHTML = '<p style="text-align:center;padding:20px;color:var(--text-secondary);">Error loading document</p>';
    }

    // Bind Buttons
    if (approveBtn) approveBtn.onclick = () => submitWorkflowAction('Approve');
    if (rejectBtn) rejectBtn.onclick = () => submitWorkflowAction('Reject');
}

function showApprovalsList() {
    const detailEl = document.getElementById('approvalDetail');
    if (detailEl) { 
        detailEl.classList.add('hidden'); 
        detailEl.style.display = 'none'; 
    }
    currentApprovalDoc = null;
}

async function submitWorkflowAction(action) {
    if (!currentApprovalDoc) return;
    const remark = document.getElementById('approvalRemark')?.value || '';
    const btn = action === 'Approve' ? document.getElementById('approveBtn') : document.getElementById('rejectBtn');

    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Processing...';
    }

    try {
        const response = await fetch(`${config.middlewareUrl}/api/workflow-action`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                doctype: currentApprovalDoc.doctype,
                docname: currentApprovalDoc.docname,
                action: action,
                remark: remark
            })
        });
        const result = await response.json();

        if (result.success) {
            showStatus(`✅ ${action}d successfully!`, 'success');
            const remarkEl = document.getElementById('approvalRemark');
            if (remarkEl) remarkEl.value = '';
            showApprovalsList();
            setTimeout(() => loadApprovalsScreen(), 500); // Refresh list
        } else {
            throw new Error(result.error || 'Action failed');
        }
    } catch (error) {
        console.error('Workflow action error:', error);
        showStatus(`❌ ${error.message}`, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = action === 'Approve' ? '✅ Approve' : '❌ Reject';
        }
    }
}

// PROFILE
function loadProfileScreen() {
    if(!currentEmployee) return;
    const name = currentEmployee.name || currentEmployee.employee_name || 'Employee';
    if($('profileName')) $('profileName').textContent = name;
    if($('profileDesignation')) $('profileDesignation').textContent = currentEmployee.designation || 'N/A';
    if($('profileEmployeeId')) $('profileEmployeeId').textContent = config.employeeId;
    if($('profileDepartment')) $('profileDepartment').textContent = currentEmployee.department || 'N/A';
    if($('profileEmploymentType')) $('profileEmploymentType').textContent = config.employmentType;
    if($('profileEmail')) $('profileEmail').textContent = userEmail;
}