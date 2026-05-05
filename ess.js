// Global state
let currentStatus = 'OUT';
let currentLocation = null;
let currentEmployee = null;
let userEmail = '';
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
            if (config.siteLat && config.siteLng) {
                const dist = calculateDistance(currentLocation.latitude, currentLocation.longitude, config.siteLat, config.siteLng);
                if (dist > config.siteRadius) {
                    showStatus(`📍 Too far (${Math.round(dist)}m). Max: ${config.siteRadius}m`, 'error');
                    return;
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
                    body: JSON.stringify({ employeeId: config.employeeId, logType, timestamp, latitude: currentLocation.latitude, longitude: currentLocation.longitude })
                });
                const data = await res.json();
                if (data.success) {
                    currentStatus = logType;
                    updateButtonState();
                    showStatus(`✅ Checked ${logType.toLowerCase()} at ${now.toLocaleTimeString()}`, 'success');
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
        
        const empRes = await fetch(`${config.middlewareUrl}/api/employee/${encodeURIComponent(email)}`);
        const empData = await empRes.json();
        if (!empData.success) throw new Error(empData.error || 'Employee not found');
        
        currentEmployee = empData.employee;
        config.employeeId = currentEmployee.id;
        config.employmentType = currentEmployee.employment_type || 'Daily Wage';
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
        if (data.success && data.assignment?.location) {
            const loc = data.assignment.location;
            config.siteLat = loc.latitude; config.siteLng = loc.longitude;
            config.siteRadius = loc.radius || 100; config.shiftLocationName = loc.name;
            if(ws) ws.innerHTML = `✅ ${loc.name} • 📏 ${config.siteRadius}m • 🕒 ${data.assignment.shift_type}`;
            if(cb) cb.disabled = false;
            await checkCurrentStatus();
        } else {
            if(ws) ws.innerHTML = '⚠️ No shift assigned';
            if(cb) cb.disabled = true;
        }
    } catch(e) {
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
    if(config.employmentType === 'Daily Wage') {
        if($('checkBtn')) $('checkBtn').style.display = 'block';
    } else {
        if($('checkBtn')) $('checkBtn').style.display = 'none';
        if($('worksiteDisplay')) $('worksiteDisplay').textContent = '🏢 Office-based';
    }
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
    ['loginScreen','dashboardScreen','leaveScreen','payslipsScreen','scheduleScreen','profileScreen'].forEach(id => {
        if($(id)) { $(id).classList.remove('active'); $(id).style.display = 'none'; }
    });
    const target = $(screen + 'Screen');
    if(target) { target.classList.add('active'); target.style.display = 'block'; }
    const titles = {dashboard:'Dashboard',leave:'Leave',payslips:'Payslips',schedule:'Schedule',profile:'Profile'};
    if($('screenTitle')) $('screenTitle').textContent = titles[screen] || 'Octagon ESS';
    
    if(screen==='leave' && typeof loadLeaveScreen==='function') loadLeaveScreen();
    if(screen==='schedule' && typeof loadScheduleScreen==='function') loadScheduleScreen();
    if(screen==='payslips' && typeof loadPayslipsScreen==='function') loadPayslipsScreen();
    if(screen==='profile' && typeof loadProfileScreen==='function') loadProfileScreen();
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
        const res = await fetch(`${config.middlewareUrl}/api/leave-balance/${config.employeeId}`);
        const data = await res.json();
        const el = $('leaveBalanceSummary'); const sel = $('leaveType');
        if(data.success && data.balances?.length) {
            let html = '';
            data.balances.forEach(b => {
                const rem = (b.leaves_allocated||0) - (b.leaves_taken||0);
                html += `<div style="background:white;padding:16px;border-radius:12px;text-align:center;box-shadow:var(--shadow);"><div style="font-size:28px;font-weight:700;color:var(--primary);">${rem}</div><div style="font-size:13px;color:var(--text-secondary);">${b.leave_type}</div></div>`;
            });
            if(el) el.innerHTML = html;
            if(sel) {
                sel.innerHTML = '<option value="">Select</option>';
                data.balances.forEach(b => {
                    const rem = (b.leaves_allocated||0) - (b.leaves_taken||0);
                    if(rem>0) sel.add(new Option(`${b.leave_type} (${rem})`, b.leave_type));
                });
            }
        } else {
            if(el) el.innerHTML = '<p style="text-align:center;padding:20px;color:var(--text-secondary);">No allocations found</p>';
            if(sel) sel.innerHTML = '<option value="">No leave available</option>';
        }
    } catch(e) { if($('leaveBalanceSummary')) $('leaveBalanceSummary').innerHTML = '<p style="text-align:center;padding:20px;">Error</p>'; }
}
async function loadLeaveRequests() {
    try {
        const res = await fetch(`${config.middlewareUrl}/api/leave-requests/${config.employeeId}`);
        const data = await res.json();
        const el = $('leaveRequestsList');
        if(data.success && data.requests?.length) {
            el.innerHTML = '';
            data.requests.forEach(req => {
                const cls = req.status==='Approved'?'status-approved':req.status==='Rejected'?'status-rejected':'status-pending';
                el.innerHTML += `<div class="leave-request-item"><div style="display:flex;justify-content:space-between;"><div><strong>${req.leave_type}</strong><div style="font-size:12px;color:var(--text-secondary);">${req.from_date} → ${req.to_date}</div></div><span class="leave-status ${cls}">${req.status}</span></div></div>`;
            });
        } else { if(el) el.innerHTML = '<p style="text-align:center;padding:20px;color:var(--text-secondary);">No requests</p>'; }
    } catch(e) { if($('leaveRequestsList')) $('leaveRequestsList').innerHTML = '<p style="text-align:center;padding:20px;">Error</p>'; }
}
async function submitLeaveApplication() {
    const type = $('leaveType').value; const from = $('leaveFromDate').value; const to = $('leaveToDate').value; const reason = $('leaveReason').value;
    if(!type||!from||!to||!reason) return showStatus('Fill all fields', 'error');
    const btn = $('leaveApplyModal').querySelector('button.submit-btn');
    btn.disabled=true; btn.textContent='Submitting...';
    try {
        const res = await fetch(`${config.middlewareUrl}/api/leave-application`, {
            method:'POST', headers:{'Content-Type':'application/json'},
            body:JSON.stringify({employeeId:config.employeeId, leaveType:type, fromDate:from, toDate:to, reason})
        });
        const data = await res.json();
        if(data.success) {
            closeLeaveApplyModal(); showStatus('Submitted!', 'success');
            $('leaveType').value=''; $('leaveFromDate').value=''; $('leaveToDate').value=''; $('leaveReason').value='';
            loadLeaveBalance();
        } else { showStatus(data.error, 'error'); }
    } catch(e) { showStatus(e.message, 'error'); } finally { btn.disabled=false; btn.textContent='Submit Request'; }
}

// SCHEDULE
async function loadScheduleScreen() {
    if(!config.employeeId) return;
    try {
        const res = await fetch(`${config.middlewareUrl}/api/schedule/${config.employeeId}`);
        const data = await res.json();
        const el = $('scheduleList');
        if(data.success && data.shifts?.length) {
            el.innerHTML = '';
            data.shifts.forEach(s => {
                el.innerHTML += `<div class="leave-request-item"><strong>${s.shift_type||'Shift'}</strong><div style="font-size:12px;color:var(--text-secondary);">${s.start_date} → ${s.end_date}</div></div>`;
            });
        } else { if(el) el.innerHTML = '<p style="text-align:center;padding:20px;color:var(--text-secondary);">No shifts</p>'; }
    } catch(e) { if($('scheduleList')) $('scheduleList').innerHTML = '<p style="text-align:center;padding:20px;">Error</p>'; }
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