/**
 * Webview Client-side JavaScript
 */

/**
 * Get the webview script as a string
 */
export function getWebviewScript(currentTheme: 'light' | 'dark'): string {
    return `
        const vscode = acquireVsCodeApi();

        function switchTab(tabName) {
            // No-op: only account tab exists
        }
        
        function refresh() {
            vscode.postMessage({
                command: 'refresh'
            });
        }
        
        function refreshAll() {
            vscode.postMessage({
                command: 'refreshAll'
            });
        }

        function openSettings() {
            vscode.postMessage({
                command: 'openSettings'
            });
        }

        function login() {
            vscode.postMessage({ command: 'login' });
        }

        function logout() {
            vscode.postMessage({ command: 'logout' });
        }

        function addAccount() {
            vscode.postMessage({ command: 'addAccount' });
        }

        function switchAccount(email) {
            vscode.postMessage({ command: 'switchAccount', email: email });
        }

        function logoutAccount(email, id) {
            vscode.postMessage({ command: 'logoutAccount', email: email, id: id });
        }

        function showAccountInfo(email) {
            vscode.postMessage({ command: 'showAccountInfo', email: email });
        }

        function showAccountFingerprint(email) {
            vscode.postMessage({ command: 'showAccountFingerprint', email: email });
        }

        function transferAccount(email) {
            vscode.postMessage({ command: 'transferAccount', email: email });
        }

        function refreshAccount(email, id) {
            vscode.postMessage({ command: 'refreshAccount', email: email, id: id });
        }

        function downloadAccount(email) {
            vscode.postMessage({ command: 'downloadAccount', email: email });
        }

        function viewAccount(email) {
            vscode.postMessage({ command: 'viewAccount', email: email });
        }

        function toggleTheme() {
            // Update theme immediately in UI
            const currentTheme = document.body.getAttribute('data-theme') || 'light';
            const newTheme = currentTheme === 'light' ? 'dark' : 'light';
            document.body.setAttribute('data-theme', newTheme);
            updateThemeIcon();
            
            // Notify extension to save preference
            vscode.postMessage({ command: 'toggleTheme' });
        }

        // Apply theme on load and update icon
        function updateThemeIcon() {
            const theme = document.body.getAttribute('data-theme') || 'light';
            const icon = document.querySelector('.theme-toggle .codicon');
            if (icon) {
                icon.className = 'codicon codicon-' + (theme === 'dark' ? 'symbol-color' : 'symbol-color');
            }
        }
        
        document.body.setAttribute('data-theme', '${currentTheme}');
        updateThemeIcon();
        
        // Listen for theme changes
        const observer = new MutationObserver(function(mutations) {
            mutations.forEach(function(mutation) {
                if (mutation.type === 'attributes' && mutation.attributeName === 'data-theme') {
                    updateThemeIcon();
                }
            });
        });
        observer.observe(document.body, { attributes: true, attributeFilter: ['data-theme'] });
        
        // Listen for messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'updateTheme') {
                // Theme is already updated in toggleTheme(), but ensure sync
                document.body.setAttribute('data-theme', message.theme);
                updateThemeIcon();
            }
        });

        // Search and Filter Logic
        document.addEventListener('DOMContentLoaded', () => {
            const searchInput = document.querySelector('.search-input');
            const filterBtns = document.querySelectorAll('.filter-btn');
            const rows = document.querySelectorAll('.account-row');
            
            let currentFilter = 'available'; // available | off
            let currentSearch = '';

            // Search Input Handler
            if (searchInput) {
                searchInput.addEventListener('input', (e) => {
                    currentSearch = e.target.value.toLowerCase();
                    applyFilters();
                });
            }

            // Filter Button Handlers
            filterBtns.forEach(btn => {
                btn.addEventListener('click', () => {
                    // Update active state
                    filterBtns.forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');

                    // Update filter type
                    if (btn.classList.contains('available')) {
                        currentFilter = 'available';
                    } else if (btn.classList.contains('off')) {
                        currentFilter = 'off';
                    }
                    
                    applyFilters();
                });
            });

            function applyFilters() {
                rows.forEach(row => {
                    const email = row.getAttribute('data-email') || '';
                    const status = row.getAttribute('data-status') || 'available'; // 'available' or 'off'
                    
                    const matchesSearch = email.toLowerCase().includes(currentSearch);
                    const matchesFilter = (currentFilter === 'available' && status === 'available') || 
                                        (currentFilter === 'off' && status === 'off');

                    if (matchesSearch && matchesFilter) {
                        row.style.display = '';
                    } else {
                        row.style.display = 'none';
                    }
                });
            }
            
            // Initial filter application
            applyFilters(); 
        });

        function showQuotaPopup(email) {
            const account = window.accountsData.find(a => a.email === email);
            if (!account) return;

            const modal = document.getElementById('quota-modal');
            const title = document.getElementById('modal-title');
            const body = document.getElementById('modal-body');

            title.innerText = 'Quota: ' + email;
            
            let html = '';
            if (account.models && account.models.length > 0) {
                account.models.forEach(m => {
                    const percentage = m.percentage || 0;
                    const color = getModalColor(percentage);
                    const resetTime = formatResetTime(m.reset_time);
                    
                    html += ' \
                        <div class="modal-quota-item"> \
                            <div class="modal-quota-header"> \
                                <span class="modal-quota-name">' + m.name + '</span> \
                                <span class="modal-quota-percent" style="color: ' + color + '">' + percentage + '%</span> \
                            </div> \
                            <div class="modal-quota-bar-bg"> \
                                <div class="modal-quota-bar-fill" style="width: ' + percentage + '%; background-color: ' + color + '"></div> \
                            </div> \
                            <div class="modal-quota-footer">Reset: ' + resetTime + '</div> \
                        </div>';
                });
            } else {
                html = '<div style="text-align: center; color: var(--text-secondary); padding: 20px;">No quota data available</div>';
            }

            body.innerHTML = html;
            modal.style.display = 'block';
        }

        function closeModal() {
            document.getElementById('quota-modal').style.display = 'none';
        }

        function getModalColor(p) {
            if (p < 20) return '#e11d48';
            if (p < 50) return '#d97706';
            return '#059669';
        }

        function formatResetTime(resetTime) {
            if (!resetTime) return 'Unknown';
            try {
                const date = new Date(resetTime);
                if (isNaN(date.getTime())) {
                    // Try parsing as seconds
                    const dateSec = new Date(resetTime * 1000);
                    if (!isNaN(dateSec.getTime())) return dateSec.toLocaleString();
                    return resetTime;
                }
                return date.toLocaleString();
            } catch (e) {
                return resetTime;
            }
        }

        window.onclick = function(event) {
            const modal = document.getElementById('quota-modal');
            if (event.target == modal) {
                closeModal();
            }
        }
    `;
}
