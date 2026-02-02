import * as vscode from 'vscode';
import { QuotaService } from '../quotaService';
import { QuotaSnapshot } from '../types';
import { logger } from '../utils/logger';
import { GoogleAuthService } from '../auth/googleAuthService';

export class GravitySidebarProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'gravity-orchestrator.sidebarView';

    private _view?: vscode.WebviewView;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _quotaService: QuotaService | undefined
    ) { }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this._extensionUri
            ]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Listen for messages from the sidebar
        webviewView.webview.onDidReceiveMessage(data => {
            switch (data.type) {

                case 'login':
                    vscode.commands.executeCommand('gravity-orchestrator.googleLogin');
                    break;
                case 'downloadApp':
                    vscode.env.openExternal(vscode.Uri.parse('https://github.com/anhnv02/gravity-orchestrator/releases'));
                    break;
                case 'addAccount':
                    vscode.commands.executeCommand('gravity-orchestrator.googleAddAccount');
                    break;
                case 'switchAccount':
                    vscode.commands.executeCommand('gravity-orchestrator.googleSwitchAccount', data.email);
                    break;
                case 'logoutAccount':
                    vscode.commands.executeCommand('gravity-orchestrator.googleLogoutAccount', data.email, data.id);
                    break;
                case 'logoutAll':
                     vscode.commands.executeCommand('gravity-orchestrator.googleLogout');
                     break;
                case 'webviewReady':
                    this.handleWebviewReady();
                    break;
            }
        });
    }

    private async handleWebviewReady() {
        this.checkAppApiStatus();
        this.updateAccounts();
        if (this._quotaService) {
            const snapshot = this._quotaService.getLastSnapshot();
            if (snapshot && this._view) {
                this._view.webview.postMessage({ type: 'updateQuota', snapshot });
            }
        }
    }



    private async checkAppApiStatus() {
        try {
            const { GravityOrchestratorApi } = await import('../api/gravityOrchestratorApi');
            const isReady = await GravityOrchestratorApi.isApiReady();
            
            if (this._view) {
                this._view.webview.postMessage({ 
                    type: 'appApiStatus', 
                    isReady 
                });
            }
        } catch (error) {
            logger.error('[Sidebar] Failed to check app API status:', error);
        }
    }

    public async updateAccounts() {
        if (!this._view) { return; }

        try {
            const authService = GoogleAuthService.getInstance();
            const currentEmail = authService.getUserEmail();
            
            // Default structure
            let accounts: any[] = [];
            
            // Try to get accounts from App API if available
            try {
                const { GravityOrchestratorApi } = await import('../api/gravityOrchestratorApi');
                if (await GravityOrchestratorApi.isApiReady()) {
                    const response = await GravityOrchestratorApi.listAccounts();
                    if (response && response.accounts) {
                        accounts = response.accounts;
                    }
                }
            } catch (e) {
                logger.warn('[Sidebar] Could not fetch accounts from app, falling back to local only');
            }

            // If we have a local email but no app accounts, create a dummy entry
            if (accounts.length === 0 && currentEmail) {
                accounts.push({ email: currentEmail, id: 'local', isActive: true });
            }

            // Mark active account
            const accountData = accounts.map(acc => ({
                ...acc,
                isActive: acc.email === currentEmail
            }));

            this._view.webview.postMessage({
                type: 'updateAccounts',
                accounts: accountData,
                currentEmail
            });

        } catch (error) {
            logger.error('[Sidebar] Error updating accounts:', error);
        }
    }

    public update(snapshot: QuotaSnapshot | undefined) {
        if (this._view) {
            this._view.webview.postMessage({ type: 'updateQuota', snapshot });
        }
        // Also refresh accounts list when quota updates, to ensure sync
        this.updateAccounts();
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const nonce = getNonce();
        const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'));

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="${codiconsUri}" rel="stylesheet" />
    <title>Gravity Agent</title>
    <style>
        body { padding: 0; margin: 0; font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); background-color: var(--vscode-sideBar-background); }
        .container { padding: 15px; }
        
        /* Account Section */
        .account-section { margin-bottom: 15px; border: 1px solid var(--vscode-widget-border); border-radius: 6px; background: var(--vscode-editor-background); overflow: hidden; }
        .current-account { padding: 8px 10px; display: flex; align-items: center; justify-content: space-between; cursor: pointer; user-select: none; }
        .current-account:hover { background-color: var(--vscode-list-hoverBackground); }
        .account-info { display: flex; align-items: center; gap: 8px; overflow: hidden; }
        .account-email { font-weight: 600; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 160px; }
        .account-list { border-top: 1px solid var(--vscode-widget-border); background-color: var(--vscode-list-hoverBackground); display: none; }
        .account-list.expanded { display: block; }
        
        .account-item { padding: 8px 10px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--vscode-widget-border); opacity: 0.9; }
        .account-item:last-child { border-bottom: none; }
        .account-item:hover { background-color: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
        .account-actions { display: flex; gap: 6px; }
        .icon-btn { cursor: pointer; padding: 2px; border-radius: 3px; display: flex; align-items: center; }
        .icon-btn:hover { background-color: rgba(255,255,255,0.2); }

        .account-footer { padding: 8px; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; background-color: var(--vscode-editor-background); border-top: 1px solid var(--vscode-widget-border); }
        
        /* Header & Quota */
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; padding: 0 2px; }
        .header h2 { margin: 0; font-size: 11px; text-transform: uppercase; font-weight: 700; opacity: 0.8; }
        .refresh-btn { background: none; border: none; color: var(--vscode-icon-foreground); cursor: pointer; padding: 4px; border-radius: 4px; }
        .refresh-btn:hover { background-color: var(--vscode-toolbar-hoverBackground); }

        /* Quota List - Compact Style */
        .quota-list { display: flex; flex-direction: column; gap: 4px; }
        .model-item { padding: 6px 0; border-bottom: 1px solid var(--vscode-tree-inputValidation-infoBorder); border-bottom-color: var(--vscode-panel-border); }
        .model-item:last-child { border-bottom: none; }
        
        .model-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
        .model-name { font-weight: 500; font-size: 12px; display: flex; align-items: center; gap: 6px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
        .model-percent { font-size: 11px; font-weight: 600; min-width: 35px; text-align: right; }
        
        /* Compact Progress Bar */
        .progress-container { width: 100%; height: 3px; background-color: #222; border-radius: 2px; overflow: hidden; opacity: 0.5; margin-top: 2px; }
        .progress-bar { height: 100%; border-radius: 2px; }
        
        /* Meta info (Reset time) */
        .model-meta { font-size: 10px; opacity: 0.6; margin-top: 3px; display: flex; align-items: center; gap: 4px; }

        /* App Banner */
        .app-banner { margin-bottom: 15px; padding: 12px; border-radius: 6px; background: var(--vscode-inputValidation-warningBackground); border: 1px solid var(--vscode-inputValidation-warningBorder); }
        .app-banner-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-weight: 600; font-size: 12px; color: var(--vscode-inputValidation-warningForeground); }
        .app-banner-text { font-size: 11px; margin-bottom: 10px; line-height: 1.4; opacity: 0.9; }
        .app-banner.hidden { display: none; }

        .btn-primary { background-color: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; border-radius: 2px; cursor: pointer; width: 100%; text-align: center; display: flex; align-items: center; justify-content: center; gap: 6px; }
        .btn-primary:hover { background-color: var(--vscode-button-hoverBackground); }
        .btn-small { padding: 6px; font-size: 11px; }
        .btn-danger { background-color: var(--vscode-errorForeground); color: var(--vscode-button-foreground); }
        .btn-danger:hover { opacity: 0.8; }

        /* Utilities */
        .hidden { display: none !important; }
        .status-green { color: #4ade80; }
        .status-yellow { color: #facc15; }
        .status-red { color: #f87171; }
        .bg-green { background-color: #4ade80; }
        .bg-yellow { background-color: #facc15; }
        .bg-red { background-color: #f87171; }
        
        .loading-spinner { animation: spin 1s linear infinite; }
        @keyframes spin { 100% { transform: rotate(360deg); } }
    </style>
</head>
<body>
    <div class="container">
        <!-- App Banner -->
        <div id="appBanner" class="app-banner hidden">
            <div class="app-banner-header">
                <i class="codicon codicon-warning"></i><span>Gravity Orchestrator App Required</span>
            </div>
            <div class="app-banner-text">Install the Gravity Orchestrator desktop app for full quota tracking.</div>
            <button class="btn-primary" onclick="downloadApp()">Download App</button>
        </div>

        <!-- Account Management -->
        <div id="accountSection" class="account-section hidden">
            <div class="current-account" onclick="toggleAccounts()">
                <div class="account-info">
                    <span class="codicon codicon-account"></span>
                    <span class="account-email" id="currentEmail">...</span>
                </div>
                <span id="accountChevron" class="codicon codicon-chevron-down"></span>
            </div>
            <div id="accountList" class="account-list">
                <!-- Dropdown items will be injected here -->
                <div id="otherAccountsList"></div>
                
                <div class="account-footer">
                    <button class="btn-primary btn-small" onclick="addAccount()">
                        <i class="codicon codicon-add"></i> Add
                    </button>
                     <button class="btn-primary btn-small btn-danger" onclick="logoutAll()">
                        <i class="codicon codicon-sign-out"></i> Logout
                    </button>
                </div>
            </div>
        </div>

        <!-- No Account State -->
        <div id="loginSection" class="hidden" style="margin-bottom: 20px;">
            <button class="btn-primary" onclick="login()">Login with Google</button>
        </div>

        <!-- Quota Section -->
        <div class="header">
            <h2>Model Quotas</h2>
        </div>

        <div id="quotaContainer" class="quota-list">
            <div class="empty-state" style="padding: 20px; text-align: center; color: var(--vscode-descriptionForeground);">
                <i class="codicon codicon-loading loading-spinner"></i> Checking status...
            </div>
        </div>
        

    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        
        // --- Event Listeners ---


        window.addEventListener('message', event => {
            const msg = event.data;
            switch (msg.type) {
                case 'updateQuota':
                    renderQuota(msg.snapshot);
                    break;
                case 'appApiStatus':
                    toggleElement('appBanner', !msg.isReady);
                    break;
                case 'updateAccounts':
                    renderAccounts(msg.accounts, msg.currentEmail);
                    break;
            }
        });

        // --- Account Logic ---
        function toggleAccounts() {
            const list = document.getElementById('accountList');
            const chevron = document.getElementById('accountChevron');
            list.classList.toggle('expanded');
            if (list.classList.contains('expanded')) {
                chevron.classList.remove('codicon-chevron-down');
                chevron.classList.add('codicon-chevron-up');
            } else {
                chevron.classList.remove('codicon-chevron-up');
                chevron.classList.add('codicon-chevron-down');
            }
        }

        let globalCurrentEmail = null;

        function renderAccounts(accounts, currentEmail) {
            globalCurrentEmail = currentEmail;

            if (!currentEmail) {
                toggleElement('accountSection', false);
                toggleElement('loginSection', true);
                toggleElement('quotaContainer', false); 
                return;
            }

            toggleElement('accountSection', true);
            toggleElement('loginSection', false);
            toggleElement('quotaContainer', true);

            document.getElementById('currentEmail').textContent = currentEmail;

            // Render other accounts in dropdown
            const listContainer = document.getElementById('otherAccountsList');
            const otherAccounts = accounts.filter(a => a.email !== currentEmail);
            
            if (otherAccounts.length === 0) {
                listContainer.innerHTML = '<div style="padding:10px; font-size:11px; font-style:italic; opacity:0.7;">No other accounts</div>';
            } else {
                listContainer.innerHTML = otherAccounts.map(acc => {
                    let quotaHtml = '';
                    if (acc.quota && acc.quota.models && acc.quota.models.length > 0) {
                        const models = acc.quota.models;
                        const items = [];

                        const getStyle = (percent) => {
                            const p = percent != null ? percent : 0;
                            const color = p > 50 ? 'green' : (p > 30 ? 'yellow' : 'red');
                            return { p, color };
                        };

                        // Helper to find and add
                        const addModel = (keywords, label) => {
                            const model = models.find(m => {
                                const name = (m.name || '').toLowerCase();
                                return keywords.every(k => name.includes(k));
                            });
                            if (model) {
                                const { p, color } = getStyle(model.percentage);
                                items.push(\`<span class="status-\${color}" title="\${model.name}">\${label} \${p.toFixed(0)}%</span>\`);
                            }
                        };

                        // Use more specific keywords to match the exact models requested
                        addModel(['gemini', 'pro', 'high'], 'GP'); 
                        addModel(['gemini', 'flash', '3'], 'GF'); // gemini-3-flash
                        addModel(['claude', 'sonnet'], 'C'); // claude-sonnet-4-5

                        // Fallback: if none of regular ones found, show first available
                        if (items.length === 0 && models.length > 0) {
                            const first = models[0];
                            const { p, color } = getStyle(first.percentage);
                             items.push(\`<span class="status-\${color}" title="\${first.name}">\${first.name.substring(0,10)}.. \${p.toFixed(0)}%</span>\`);
                        }

                        if (items.length > 0) {
                             quotaHtml = \`
                                <div style="font-size:10px; opacity:0.8; display:flex; align-items:center; gap:6px; margin-top:2px;">
                                    \${items.join('<span style="opacity:0.3">|</span>')}
                                </div>
                            \`;
                        }
                    }

                    return \`
                    <div class="account-item">
                        <div style="display:flex; flex-direction:column; overflow:hidden; flex:1; margin-right:8px;">
                             <span style="font-size:11px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="\${acc.email}">\${acc.email}</span>
                             \${quotaHtml}
                        </div>
                        <div class="account-actions">
                            <span class="icon-btn" title="Switch to this account" onclick="switchAccount('\${acc.email}')">
                                <i class="codicon codicon-play"></i>
                            </span>
                            <span class="icon-btn" title="Logout" onclick="logoutAccount('\${acc.email}', '\${acc.id}')">
                                <i class="codicon codicon-trash"></i>
                            </span>
                        </div>
                    </div>
                \`;
                }).join('');
            }
        }

        // --- Quota Logic ---
        function renderQuota(snapshot) {
            const container = document.getElementById('quotaContainer');
            if (!snapshot) {
                // If we are logged in (have globalCurrentEmail), show loading instead of error
                if (globalCurrentEmail) {
                     container.innerHTML = '<div class="empty-state" style="padding:20px;text-align:center"><i class="codicon codicon-loading loading-spinner"></i> Refreshing quota...</div>';
                     return;
                }

                const loginSectionVisible = !document.getElementById('loginSection').classList.contains('hidden');
                if (loginSectionVisible) return;

                container.innerHTML = '<div class="empty-state" style="padding:10px;text-align:center"><i class="codicon codicon-plug"></i> No connection</div>';
                return;
            }

            if (!snapshot.models || snapshot.models.length === 0) {
                container.innerHTML = '<div class="empty-state" style="padding:10px;text-align:center">No models available</div>';
                return;
            }

            // SORTING
            const sortedModels = [...snapshot.models].sort((a, b) => {
                const getPriority = (label) => {
                    const name = label.toLowerCase();
                    if (name.includes('gemini')) return 1;
                    if (name.includes('claude')) return 2;
                    if (name.includes('gpt')) return 3;
                    return 4;
                };
                const pA = getPriority(a.label);
                const pB = getPriority(b.label);
                return (pA !== pB) ? pA - pB : a.label.localeCompare(b.label);
            });

            container.innerHTML = sortedModels.map(model => {
                const percent = model.remainingPercentage || 0;
                const colorClass = percent > 50 ? 'green' : (percent > 30 ? 'yellow' : 'red');
                const resetTime = model.timeUntilResetFormatted ? model.timeUntilResetFormatted.replace(' from now', '') : '-';
                
                return \`
                    <div class="model-item">
                        <div class="model-header">
                            <div class="model-name" title="\${model.label}">
                                <span class="codicon codicon-circle-filled status-\${colorClass}" style="font-size: 8px;"></span>
                                \${model.label}
                            </div>
                            <div class="model-percent status-\${colorClass}">\${percent.toFixed(0)}%</div>
                        </div>
                        <div class="progress-container">
                            <div class="progress-bar bg-\${colorClass}" style="width: \${percent}%; opacity: 1;"></div>
                        </div>
                        <div class="model-meta">
                            <span class="codicon codicon-history" style="font-size: 10px;"></span> \${resetTime}
                        </div>
                    </div>
                \`;
            }).join('');
        }

        // --- Actions ---
        function login() { vscode.postMessage({ type: 'login' }); }
        function downloadApp() { vscode.postMessage({ type: 'downloadApp' }); }
        function addAccount() { vscode.postMessage({ type: 'addAccount' }); }
        function logoutAll() { vscode.postMessage({ type: 'logoutAll' }); }
        function switchAccount(email) { vscode.postMessage({ type: 'switchAccount', email }); }
        function logoutAccount(email, id) { vscode.postMessage({ type: 'logoutAccount', email, id }); }
        
        function toggleElement(id, show) {
            const el = document.getElementById(id);
            if (el) {
                if (show) el.classList.remove('hidden'); else el.classList.add('hidden');
            }
        }
        
        // Signal readiness
        vscode.postMessage({ type: 'webviewReady' });
    </script>
</body>
</html>`;
    }
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
