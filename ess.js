// Global state
let currentStatus = 'OUT';
let currentLocation = null;
let currentEmployee = null;
let userEmail = '';
let hasCheckedInToday = false;
let config = {
    middlewareUrl: 'https://octagon-ess-production-e300.up.railway.app',
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

function getMiddlewareBase() {
    return config.middlewareUrl.replace(/\/$/, '');
}

function clearSessionStorage() {
    localStorage.removeItem('authToken');
    localStorage.removeItem('erpnext_config');
    localStorage.removeItem('currentEmployee');
    localStorage.removeItem('userEmail');
}

let _sessionExpiredHandled = false;
function handleSessionExpired() {
    if (_sessionExpiredHandled) return;
    _sessionExpiredHandled = true;
    clearSessionStorage();
    alert('Session expired. Please sign in again.');
    location.reload();
}

async function apiFetch(path, options = {}) {
    const token = localStorage.getItem('authToken');
    const headers = { ...(options.headers || {}) };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const response = await fetch(`${getMiddlewareBase()}${path}`, { ...options, headers });
    if (response.status === 401) {
        handleSessionExpired();
        throw new Error('Session expired');
    }
    return response;
}

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    // Force initial state
    if($('loginScreen')) $('loginScreen').style.display = 'block';
    ['dashboardScreen','leaveScreen','scheduleScreen','payslipsScreen','profileScreen'].forEach(id => {
        if($(id)) $(id).style.display = 'none';
    });
    if($('appHeader')) $('appHeader').style.display = 'none';

    if (!localStorage.getItem('authToken')) {
        clearSessionStorage();
    }

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
                
                const res = await apiFetch(`/api/checkin`, {
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
                    _todayCheckinsCache.push({ log_type: logType, time: timestamp });
                    renderHoursLogged();
                    loadAttendanceStats();
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
    const fullName = currentEmployee?.name || currentEmployee?.employee_name || 'there';
    const firstName = String(fullName).trim().split(/\s+/)[0] || fullName;
    const el = $('greetingText');
    if (el) el.textContent = `${firstName}.`;
}

function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function formatCoords(lat, lng, accuracy) {
    const ns = lat >= 0 ? 'N' : 'S';
    const ew = lng >= 0 ? 'E' : 'W';
    const acc = accuracy ? ` · ±${Math.round(accuracy)}m` : '';
    return `${Math.abs(lat).toFixed(6)}° ${ns} · ${Math.abs(lng).toFixed(6)}° ${ew}${acc}`;
}

function setAtlasPlace(line1, accentLine) {
    const el = $('atlasPlace');
    if (!el) return;
    const safe = s => String(s).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
    el.innerHTML = `${safe(line1)}<br><span class="atlas-accent">${safe(accentLine)}.</span>`;
}

async function reverseGeocode(lat, lng) {
    try {
        const res = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`);
        if (!res.ok) return null;
        const d = await res.json();
        const locality = d.city || d.locality || d.principalSubdivision || '';
        const region = d.countryName || d.principalSubdivision || '';
        if (!locality) return null;
        return { locality, region };
    } catch { return null; }
}

function setCoordsText(text, html) {
    ['loginCoords', 'locationDisplay'].forEach(id => {
        const el = $(id);
        if (!el) return;
        if (html) el.innerHTML = html; else el.textContent = text;
    });
}

function getLocation() {
    if (!navigator.geolocation) {
        setCoordsText('GPS not supported on this device');
        setAtlasPlace('Location', 'unavailable');
        return;
    }
    setCoordsText('Acquiring GPS lock…');
    setAtlasPlace('Locating', 'you');
    navigator.geolocation.getCurrentPosition(async pos => {
        currentLocation = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
        setCoordsText(formatCoords(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy));
        const place = await reverseGeocode(pos.coords.latitude, pos.coords.longitude);
        if (place) {
            setAtlasPlace(place.locality, place.region || 'now');
        } else {
            setAtlasPlace('You’re', 'here');
        }
    }, err => {
        setCoordsText(null, `Location unavailable · <a onclick="getLocation();return false;">retry</a>`);
        setAtlasPlace('Location', 'unavailable');
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
        const loginRes = await fetch(`${getMiddlewareBase()}/api/login`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email, password}) });
        const loginData = await loginRes.json();
        if (!loginData.success || !loginData.token || !loginData.employee) throw new Error(loginData.error || 'Invalid credentials');

        _sessionExpiredHandled = false;
        localStorage.setItem('authToken', loginData.token);

        currentEmployee = loginData.employee;
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
        const res = await apiFetch(`/api/shift-assignment/${config.employeeId}`);
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
    document.body.classList.add('app-ready');
    syncActiveNav('dashboard');
    updateButtonState();
    updateDrawerInfo();
    if (currentLocation) {
        const el = $('locationDisplay');
        if (el) el.textContent = formatCoords(currentLocation.latitude, currentLocation.longitude);
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
        const res = await apiFetch(`/api/today-checkins/${config.employeeId}`);
        const data = await res.json();
        if (data.success && data.checkins?.length) {
            currentStatus = data.checkins[data.checkins.length-1].log_type;
            updateButtonState();
        }
    } catch(e) {}
}

let _todayCheckinsCache = [];

function computeHoursLoggedMs(checkins, now = Date.now()) {
    if (!Array.isArray(checkins) || !checkins.length) return 0;
    const sorted = [...checkins]
        .filter(c => c && c.time && c.log_type)
        .sort((a, b) => new Date(a.time) - new Date(b.time));
    let totalMs = 0;
    let inAt = null;
    for (const c of sorted) {
        const t = new Date(c.time).getTime();
        if (Number.isNaN(t)) continue;
        if (c.log_type === 'IN' && inAt === null) {
            inAt = t;
        } else if (c.log_type === 'OUT' && inAt !== null) {
            totalMs += Math.max(0, t - inAt);
            inAt = null;
        }
    }
    if (inAt !== null) totalMs += Math.max(0, now - inAt);
    return totalMs;
}

function formatHoursLogged(ms) {
    const totalMin = Math.max(0, Math.floor(ms / 60000));
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return `${h}h ${String(m).padStart(2, '0')}m`;
}

function renderHoursLogged() {
    const el = $('dashAttendStat');
    if (!el) return;
    const ms = computeHoursLoggedMs(_todayCheckinsCache);
    el.textContent = formatHoursLogged(ms);
}

setInterval(() => {
    if (currentStatus === 'IN') renderHoursLogged();
}, 60000);

async function loadAttendanceStats() {
    try {
        const res = await apiFetch(`/api/today-checkins/${config.employeeId}`);
        const data = await res.json();

        if (data.success) {
            const checkins = data.checkins || [];
            _todayCheckinsCache = checkins;
            renderHoursLogged();

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
        btn.textContent = currentStatus === 'IN' ? 'Clock out' : 'Clock in';
        btn.className = `checkin-btn ${currentStatus === 'IN' ? 'check-out' : ''}`;
    }
    const chip = $('dashStatusText');
    const drawerChip = $('drawerStatusText');
    const text = currentStatus === 'IN' ? 'On the clock' : 'Off the clock';
    if (chip) chip.textContent = text;
    if (drawerChip) drawerChip.textContent = text;
}

function logout() {
    closeDrawer();

    const token = localStorage.getItem('authToken');
    if (token) {
        fetch(`${getMiddlewareBase()}/api/logout`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        }).catch(() => {});
    }

    clearSessionStorage();
    document.body.classList.remove('app-ready');
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

function syncActiveNav(screen) {
    document.querySelectorAll('.dash-tab, .draw-row').forEach(b => {
        const m = (b.getAttribute('onclick') || '').match(/navigateTo\(['"](\w+)['"]\)/);
        b.classList.toggle('is-active', !!m && m[1] === screen);
    });
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

    syncActiveNav(screen);

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

function getInitials(fullName) {
    const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '·';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function updateDrawerInfo() {
    const name = currentEmployee?.name || currentEmployee?.employee_name || 'Employee';
    const dept = currentEmployee?.department || 'N/A';
    if($('drawerEmployeeName')) $('drawerEmployeeName').textContent = name;
    if($('drawerEmployeeDept')) $('drawerEmployeeDept').textContent = dept;
    if($('drawerAvatar')) $('drawerAvatar').textContent = getInitials(name);
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
        const response = await apiFetch(`/api/leave-balance/${config.employeeId}`);
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
        const response = await apiFetch(`/api/leave-requests/${config.employeeId}`);
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

function statusToClass(status) {
    if (status === 'Approved') return 'status-approved';
    if (status === 'Rejected') return 'status-rejected';
    return 'status-pending';
}

async function loadLeaveRequests() {
    try {
        const res = await apiFetch(`/api/leave-requests/${config.employeeId}`);
        const data = await res.json();
        const el = document.getElementById('leaveRequestsList');
        if (!el) return;

        if (data.success && data.requests && data.requests.length > 0) {
            let html = '';
            data.requests.forEach(req => {
                const cls = statusToClass(req.status);
                const days = req.total_leave_days ? `${req.total_leave_days}d` : '';
                html += `
                    <div class="atlas-row" onclick="viewLeaveDetail('${req.name}')">
                        <div class="atlas-row-head">
                            <div style="min-width:0;flex:1;">
                                <div class="atlas-row-title">${req.leave_type}</div>
                                <div class="atlas-row-meta">${req.from_date} → ${req.to_date}${days ? ' · ' + days : ''}</div>
                            </div>
                            <span class="leave-status ${cls}">${req.status}</span>
                        </div>
                    </div>
                `;
            });
            el.innerHTML = html;
        } else {
            el.innerHTML = '<div class="atlas-empty">No leave requests yet.</div>';
        }
    } catch(e) {
        const el = document.getElementById('leaveRequestsList');
        if (el) el.innerHTML = '<div class="atlas-empty">Error loading requests.</div>';
    }
}

async function viewLeaveDetail(docname) {
    try {
        const response = await apiFetch(`/api/leave-requests/${config.employeeId}`);
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
        
        const statusClass = statusToClass(request.status);

        document.getElementById('leaveDetailContent').innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;gap:12px;">
                <div class="atlas-row-title">${request.leave_type}</div>
                <span class="leave-status ${statusClass}">${request.status}</span>
            </div>
            <div class="hours-row"><span>From</span><span>${request.from_date}</span></div>
            <div class="hours-row"><span>To</span><span>${request.to_date}</span></div>
            <div class="hours-row"><span>Days</span><span>${request.total_leave_days || '—'}</span></div>
            ${request.description ? `<div class="hours-row"><span>Reason</span><span style="text-align:right;">${request.description}</span></div>` : ''}
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
        const response = await apiFetch(`/api/leave-application`, {
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
        const response = await apiFetch(`/api/schedule/${config.employeeId}`);
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
    const dayHeaders = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    dayHeaders.forEach(d => {
        gridHTML += `<div class="cal-header-cell">${d}</div>`;
    });
    for (let i = 0; i < firstDay; i++) gridHTML += '<div></div>';

    for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        let status = 'off', tag = '';

        if (scheduleData.shifts?.some(s => dateStr >= s.start_date && dateStr <= s.end_date)) {
            status = 'work'; tag = '';
        }
        if (scheduleData.leaves?.some(l => dateStr >= l.from_date && dateStr <= l.to_date)) {
            status = 'leave'; tag = 'Leave';
        }
        if (scheduleData.holidays?.some(h => h.holiday_date === dateStr)) {
            status = 'holiday'; tag = 'Hol';
        }

        const isToday = dateStr === today;
        const classes = ['cal-cell', `is-${status}`];
        if (isToday) classes.push('is-today');

        gridHTML += `
            <div onclick="showDayDetail('${dateStr}')" class="${classes.join(' ')}">
                <div class="cal-num">${day}</div>
                ${tag ? `<div class="cal-tag">${tag}</div>` : ''}
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

    title.textContent = new Date(dateStr).toLocaleDateString('en-US', { weekday:'long', day:'numeric', month:'long' });
    let html = '', found = false;

    const row = (kind, title, sub, cls) => `
        <div class="atlas-row" style="cursor:default;">
            <div class="atlas-row-head">
                <div style="min-width:0;flex:1;">
                    <div class="atlas-row-meta">${kind}</div>
                    <div class="atlas-row-title" style="font-size:16px;margin-top:2px;">${title}</div>
                    ${sub ? `<div class="atlas-row-meta" style="margin-top:4px;">${sub}</div>` : ''}
                </div>
                <span class="leave-status ${cls}">${kind}</span>
            </div>
        </div>`;

    scheduleData.shifts?.forEach(s => {
        if (dateStr >= s.start_date && dateStr <= s.end_date) {
            found = true;
            html += row('Work', s.shift_type || 'Assigned shift', '', 'status-approved');
        }
    });
    scheduleData.leaves?.forEach(l => {
        if (dateStr >= l.from_date && dateStr <= l.to_date) {
            found = true;
            html += row('Leave', l.leave_type, '', 'status-pending');
        }
    });
    scheduleData.holidays?.forEach(h => {
        if (h.holiday_date === dateStr) {
            found = true;
            html += row('Holiday', h.description || 'Holiday', '', 'status-rejected');
        }
    });

    content.innerHTML = found ? html : '<div class="atlas-empty">No events on this day.</div>';
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
        listEl.innerHTML = '<div class="atlas-empty">No upcoming shifts.</div>';
        return;
    }

    let html = '';
    scheduleData.shifts.slice(0, 5).forEach(s => {
        const range = s.start_date === s.end_date ? s.start_date : `${s.start_date} → ${s.end_date}`;
        html += `
            <div class="atlas-row" style="cursor:default;">
                <div class="atlas-row-head">
                    <div style="min-width:0;flex:1;">
                        <div class="atlas-row-title">${s.shift_type || 'Shift'}</div>
                        <div class="atlas-row-meta">${range}${s.shift_location ? ' · ' + s.shift_location : ''}</div>
                    </div>
                    <span class="leave-status status-approved">Confirmed</span>
                </div>
            </div>
        `;
    });
    listEl.innerHTML = html;
}

// PAYSLIPS
async function loadPayslipsScreen() {
    if(!config.employeeId) return;
    const fmtBND = v => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'BND' }).format(v || 0);
    try {
        const res = await apiFetch(`/api/payslips/${config.employeeId}`);
        const data = await res.json();
        const el = $('payslipsList');
        if (!el) return;

        if (data.success && data.payslips?.length) {
            let html = '';
            data.payslips.forEach(s => {
                html += `
                    <div class="atlas-row">
                        <div class="atlas-row-meta">${s.period}</div>
                        <div class="atlas-amount" style="margin-top:4px;">${fmtBND(s.net_pay)}</div>
                        <div class="atlas-row-foot">
                            <span>Gross ${fmtBND(s.gross_pay)}</span>
                            <span>Ded ${fmtBND(s.total_deduction)}</span>
                        </div>
                    </div>
                `;
            });
            el.innerHTML = html;
        } else {
            el.innerHTML = '<div class="atlas-empty">No payslips yet.</div>';
        }
    } catch(e) {
        if($('payslipsList')) $('payslipsList').innerHTML = '<div class="atlas-empty">Error loading payslips.</div>';
    }
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
        
        const response = await apiFetch(`/api/approvals/${encodeURIComponent(userEmail)}`);
        const result = await response.json();

        if (result.success && result.approvals && result.approvals.length > 0) {
            let html = '';
            result.approvals.forEach(approval => {
                html += `
                    <div class="atlas-row" onclick="viewApproval('${approval.doctype}', '${approval.docname}', '${approval.next_action || 'Approve'}')">
                        <div class="atlas-row-head">
                            <div style="min-width:0;flex:1;">
                                <div class="atlas-row-title">${approval.title}</div>
                                <div class="atlas-row-meta">${approval.doctype} · ${approval.state || 'Pending'}</div>
                            </div>
                            <span class="leave-status status-pending">Review</span>
                        </div>
                    </div>
                `;
            });
            if (listEl) listEl.innerHTML = html;
        } else {
            if (listEl) listEl.innerHTML = '<div class="atlas-empty">No pending approvals.</div>';
        }
    } catch (error) {
        console.error('Approval load error:', error);
        if (listEl) listEl.innerHTML = '<div class="atlas-empty">Error loading approvals.</div>';
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
    if (printViewEl) printViewEl.innerHTML = '<div class="atlas-empty">Loading document…</div>';
    if (approveBtn) { approveBtn.style.display = 'block'; approveBtn.textContent = nextAction || 'Approve'; }
    if (rejectBtn) rejectBtn.style.display = 'block';

    // Fetch Document Print Format
    try {
        const response = await apiFetch(`/api/print-format/${doctype}/${docname}`);
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
        const response = await apiFetch(`/api/workflow-action`, {
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
    if($('profileAvatar')) $('profileAvatar').textContent = getInitials(name);
    if($('profileDesignation')) $('profileDesignation').textContent = currentEmployee.designation || 'N/A';
    if($('profileEmployeeId')) $('profileEmployeeId').textContent = config.employeeId;
    if($('profileDepartment')) $('profileDepartment').textContent = currentEmployee.department || 'N/A';
    if($('profileEmploymentType')) $('profileEmploymentType').textContent = config.employmentType;
    if($('profileEmail')) $('profileEmail').textContent = userEmail;
}