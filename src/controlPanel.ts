/**
 * Control Panel - Main Webview Panel for Gravity Orchestrator
 * 
 * This file handles the webview panel lifecycle and message handling.
 * UI rendering is delegated to the webview module.
 */

import * as vscode from 'vscode';
import { QuotaSnapshot, ModelQuotaInfo, Config } from './types';
import { escapeHtml } from './utils/htmlUtils';
import { getMultiAccountInfo, cleanupDuplicateAccounts, MultiAccountInfo, clearAccountUsageCache } from './utils/accountUtils';
import { logger } from './utils/logger';
import { GravityOrchestratorApi } from './api/gravityOrchestratorApi';
import { ConfigService } from './configService';
import { GoogleAuthService } from './auth/googleAuthService';
import { GoogleCloudCodeClient } from './api/googleCloudCodeClient';
import { filterModelsForDisplay, formatModelDisplayName } from './utils/modelUtils';

// Import webview modules
import {
    formatTimeUntilReset,
    maskEmail,
    getRandomLastUsed,
    getTierBadgeHtml,
    getPillColorClass
} from './webview/helpers';
import { getEmptyStateHtml, getLoadingHtml } from './webview/templates';
import { getWebviewScript } from './webview/scripts';

// ============================================================================
// Types
// ============================================================================

interface WebviewMessage {
    command: string;
    email?: string;
    id?: string;
    tab?: string;
    settings?: Partial<Config>;
}

// ============================================================================
// Control Panel Class
// ============================================================================

export class ControlPanel {
    private static currentPanel: ControlPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private disposables: vscode.Disposable[] = [];
    private lastSnapshot: QuotaSnapshot | undefined;
    private configService: ConfigService;
    private initialTab: 'account';
    private currentTheme: 'light' | 'dark' = 'light';

    // ========================================================================
    // Constructor & Lifecycle
    // ========================================================================

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        initialTab: 'account' = 'account'
    ) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.initialTab = initialTab;
        this.configService = new ConfigService();

        // Load theme preference
        const config = vscode.workspace.getConfiguration('gravityOrchestrator');
        this.currentTheme = config.get<'light' | 'dark'>('theme', 'light');

        // Show loading state immediately
        this.panel.webview.html = getLoadingHtml(this.getCodiconUri(panel.webview));

        this.update().catch(logger.error);

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        this.panel.webview.onDidReceiveMessage(
            async (message: WebviewMessage) => {
                await this.handleMessage(message);
            },
            null,
            this.disposables
        );

        // Listen for configuration changes
        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('gravityOrchestrator.theme')) {
                    const config = vscode.workspace.getConfiguration('gravityOrchestrator');
                    const newTheme = config.get<'light' | 'dark'>('theme', 'light');
                    if (this.currentTheme !== newTheme) {
                        this.currentTheme = newTheme;
                        this.panel.webview.postMessage({
                            command: 'updateTheme',
                            theme: this.currentTheme
                        });
                    }
                }
            })
        );
    }

    public static createOrShow(extensionUri: vscode.Uri, initialTab: 'account' = 'account') {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (ControlPanel.currentPanel) {
            ControlPanel.currentPanel.panel.reveal(column);
            if (initialTab !== ControlPanel.currentPanel.initialTab) {
                ControlPanel.currentPanel.initialTab = initialTab;
                ControlPanel.currentPanel.update().catch(logger.error);
            }
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'gravityOrchestratorControlPanel',
            'Gravity Orchestrator',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        ControlPanel.currentPanel = new ControlPanel(panel, extensionUri, initialTab);
    }

    public static update(snapshot: QuotaSnapshot | undefined) {
        if (ControlPanel.currentPanel) {
            ControlPanel.currentPanel.lastSnapshot = snapshot;
            ControlPanel.currentPanel.update().catch(logger.error);
        }
    }

    public static revive(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        ControlPanel.currentPanel = new ControlPanel(panel, extensionUri, 'account');
    }

    public dispose(): void {
        ControlPanel.currentPanel = undefined;
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
    }

    // ========================================================================
    // Update & Message Handling
    // ========================================================================

    private async update(): Promise<void> {
        try {
            await cleanupDuplicateAccounts();
            this.panel.webview.html = await this.getHtmlForWebview(this.panel.webview, undefined);
        } catch (error) {
            logger.error('[ControlPanel] Failed to update webview:', error);
        }
    }

    private async handleMessage(message: WebviewMessage): Promise<void> {
        const executeAndUpdate = async (command: string, ...args: any[]) => {
            await vscode.commands.executeCommand(command, ...args);
            await this.update();
        };

        switch (message.command) {
            case 'refresh':
                vscode.commands.executeCommand('gravity-orchestrator.quickRefreshQuota').then(undefined, logger.error);
                break;

            case 'refreshAll':
                await this.handleRefreshAll();
                break;

            case 'login':
                await executeAndUpdate('gravity-orchestrator.googleLogin');
                break;

            case 'logout':
                await executeAndUpdate('gravity-orchestrator.googleLogout');
                break;

            case 'addAccount':
                await executeAndUpdate('gravity-orchestrator.googleAddAccount');
                break;

            case 'switchAccount':
                if (message.email) {
                    await executeAndUpdate('gravity-orchestrator.googleSwitchAccount', message.email);
                }
                break;

            case 'logoutAccount':
                if (message.email) {
                    await executeAndUpdate('gravity-orchestrator.googleLogoutAccount', message.email, message.id);
                }
                break;

            case 'toggleTheme':
                await this.toggleTheme();
                this.panel.webview.postMessage({
                    command: 'updateTheme',
                    theme: this.currentTheme
                });
                await this.update();
                break;



            case 'transferAccount':
                if (message.email) {
                    await executeAndUpdate('gravity-orchestrator.googleSwitchAccount', message.email);
                }
                break;

            case 'refreshAccount':
                if (message.email) {
                    await this.handleRefreshAccount(message.email, message.id);
                }
                break;


        }
    }

    private async handleRefreshAll(): Promise<void> {
        vscode.window.showInformationMessage('Refreshing all account quotas...');
        try {
            if (await GravityOrchestratorApi.isApiReady()) {
                await GravityOrchestratorApi.refreshAllQuotas();
                logger.info('[ControlPanel] Triggered refresh for all accounts');
                await new Promise(resolve => setTimeout(resolve, 800));
            }
        } catch (error) {
            logger.error('[ControlPanel] Failed to refresh all accounts:', error);
        }
        await this.update();
    }

    private async handleRefreshAccount(email: string, id?: string): Promise<void> {
        vscode.window.showInformationMessage(`Refreshing account: ${email}...`);
        try {
            clearAccountUsageCache();
            if (await GravityOrchestratorApi.isApiReady()) {
                await GravityOrchestratorApi.refreshAccountQuota(email, id);
                logger.info(`[ControlPanel] Triggered quota refresh for ${email} (ID: ${id})`);
                await new Promise(resolve => setTimeout(resolve, 300));
            }
        } catch (error) {
            logger.error('[ControlPanel] Failed to refresh account quota:', error);
        }
        await this.update();
    }

    // ========================================================================
    // Theme Management
    // ========================================================================

    private async toggleTheme(): Promise<void> {
        const newTheme = this.currentTheme === 'light' ? 'dark' : 'light';
        this.currentTheme = newTheme;

        const config = vscode.workspace.getConfiguration('gravityOrchestrator');
        await config.update('theme', newTheme, vscode.ConfigurationTarget.Global);
    }

    // ========================================================================
    // Utility Methods
    // ========================================================================

    private getCodiconUri(webview: vscode.Webview): vscode.Uri | null {
        try {
            const codiconPath = vscode.Uri.joinPath(
                this.extensionUri,
                'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'
            );
            const uri = webview.asWebviewUri(codiconPath);
            if (!uri || uri.toString() === '') {
                logger.warn('[ControlPanel] Codicon URI is empty');
                return null;
            }
            return uri;
        } catch (error) {
            logger.error('[ControlPanel] Failed to load codicon CSS:', error);
            return null;
        }
    }

    private async isApiReady(): Promise<boolean> {
        try {
            const isReady = await GravityOrchestratorApi.isApiReady();
            if (isReady) {
                logger.info('[ControlPanel] Antigravity Tools API is ready');
                return true;
            }
        } catch (error) {
            logger.debug('[ControlPanel] Antigravity Tools API check failed:', error);
        }
        return false;
    }

    // ========================================================================
    // Quota Fetching
    // ========================================================================

    private async getQuotaFromApp(): Promise<QuotaSnapshot | undefined> {
        const config = vscode.workspace.getConfiguration('gravityOrchestrator');
        const apiMethod = config.get<string>('apiMethod', 'GET_USER_STATUS');

        if (apiMethod === 'GOOGLE_API') {
            const snapshot = await this.getQuotaFromGoogleApi();
            if (snapshot) {
                return snapshot;
            }
        }

        return this.getQuotaFromLocalApi();
    }

    private async getQuotaFromGoogleApi(): Promise<QuotaSnapshot | undefined> {
        try {
            const googleAuthService = GoogleAuthService.getInstance();
            const googleApiClient = GoogleCloudCodeClient.getInstance();

            const activeAccount = await googleAuthService.getActiveAccount();
            if (!activeAccount) {
                logger.info('[ControlPanel] No active Google account for GOOGLE_API method');
                return undefined;
            }

            const token = await googleAuthService.getValidAccessTokenForAccount(activeAccount);
            const projectInfo = await googleApiClient.loadProjectInfo(token);
            const modelsQuota = await googleApiClient.fetchModelsQuota(token, projectInfo.projectId);

            const models: ModelQuotaInfo[] = modelsQuota.models.map(m => {
                const resetDate = new Date(m.resetTime);
                const timeUntilReset = resetDate.getTime() - Date.now();
                return {
                    label: m.displayName,
                    modelId: m.modelName,
                    remainingFraction: m.remainingQuota,
                    remainingPercentage: m.remainingQuota * 100,
                    isExhausted: m.isExhausted || m.remainingQuota <= 0,
                    resetTime: resetDate,
                    timeUntilReset: timeUntilReset,
                    timeUntilResetFormatted: formatTimeUntilReset(timeUntilReset)
                };
            });

            return {
                timestamp: new Date(),
                models: models,
                userEmail: activeAccount,
                planName: 'Pro'
            };
        } catch (error) {
            logger.error('[ControlPanel] Google API quota fetch failed:', error);
            return undefined;
        }
    }

    private async getQuotaFromLocalApi(): Promise<QuotaSnapshot | undefined> {
        try {
            logger.info('[ControlPanel] Calling getCurrentAccount API...');
            const currentAccountResponse = await GravityOrchestratorApi.getCurrentAccount();
            logger.info('[ControlPanel] getCurrentAccount response received');

            if (!currentAccountResponse.account) {
                logger.warn('[ControlPanel] No current account found in response');
                return undefined;
            }

            const account = currentAccountResponse.account;
            logger.info(`[ControlPanel] Current account: ${account.email}`);

            if (!account.quota) {
                logger.warn('[ControlPanel] Account has no quota data');
                return undefined;
            }

            const quota = account.quota;

            if (!quota || !quota.models || quota.models.length === 0) {
                logger.warn('[ControlPanel] Quota has no models');
                return undefined;
            }

            logger.info(`[ControlPanel] Found ${quota.models.length} models in quota`);

            // Filter models using the common utility
            const filteredModels = quota.models.filter(m => filterModelsForDisplay(m.name));

            const models: ModelQuotaInfo[] = filteredModels.map(model => {
                const resetTime = new Date(model.reset_time);
                const timeUntilReset = resetTime.getTime() - Date.now();

                return {
                    label: formatModelDisplayName(model.name),
                    modelId: model.name,
                    remainingFraction: model.percentage / 100,
                    remainingPercentage: model.percentage,
                    isExhausted: model.percentage <= 0,
                    resetTime,
                    timeUntilReset,
                    timeUntilResetFormatted: formatTimeUntilReset(timeUntilReset),
                };
            });

            logger.info(`[ControlPanel] Filtered to ${models.length} models (from ${quota.models.length} total)`);

            return {
                timestamp: quota.updated_at ? new Date(quota.updated_at * 1000) : new Date(),
                promptCredits: undefined,
                models,
                planName: quota.subscription_tier,
                userEmail: account.email,
            };
        } catch (error) {
            logger.error('[ControlPanel] Failed to get quota from app:', error);
            if (error instanceof Error) {
                logger.error('[ControlPanel] Error message:', error.message);
                logger.error('[ControlPanel] Error stack:', error.stack);
            }
            return undefined;
        }
    }

    private filterIdeModels(models: any[]): any[] {
        return models.filter(model => filterModelsForDisplay(model.name));
    }

    // ========================================================================
    // HTML Building
    // ========================================================================

    private async getHtmlForWebview(
        webview: vscode.Webview,
        snapshot: QuotaSnapshot | undefined
    ): Promise<string> {
        const codiconUri = this.getCodiconUri(webview);

        // Check if API is ready first
        const isApiReady = await this.isApiReady();

        if (!isApiReady) {
            logger.info('[ControlPanel] API not ready, showing empty state');
            return getEmptyStateHtml(codiconUri);
        }

        // Fetch quota snapshot
        logger.info('[ControlPanel] API ready, preparing quota snapshot...');
        let quotaSnapshot = snapshot;
        if (!quotaSnapshot) {
            logger.info('[ControlPanel] No snapshot provided, fetching from configured API...');
            quotaSnapshot = await this.getQuotaFromApp();
        }

        const multiAccountInfo = await getMultiAccountInfo();

        // Build account management tab
        const accountTab = await this.buildAccountManagementTab(multiAccountInfo);

        const codiconLink = codiconUri ? `<link rel="stylesheet" href="${codiconUri}">` : '';

        return this.buildMainHtml(codiconLink, accountTab, this.currentTheme, multiAccountInfo);
    }

    private buildMainHtml(
        codiconLink: string,
        accountTab: string,
        theme: 'light' | 'dark',
        accountTabData: MultiAccountInfo
    ): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Gravity Orchestrator</title>
    ${codiconLink}
    ${this.getInlineStyles()}
</head>
<body data-theme="${theme}">
    <div class="header">
        <h1>Antigravity Orchestrator</h1>
        <div class="header-actions">
            <button class="action-btn-header" onclick="refreshAll()" title="Refresh all accounts & quotas">
                <span class="codicon codicon-refresh"></span>
            </button>
            <button class="theme-toggle" onclick="toggleTheme()" title="Toggle theme">
                <span class="codicon codicon-symbol-color"></span>
            </button>
        </div>
    </div>

    <div id="account-tab" class="tab-content active">
        ${accountTab}
    </div>

    <div id="quota-modal" class="modal">
        <div class="modal-content">
            <div class="modal-header">
                <h2 id="modal-title">Account Quota</h2>
                <button class="close-btn" onclick="closeModal()">&times;</button>
            </div>
            <div id="modal-body" class="modal-body">
                <!-- Quota content will be injected here -->
            </div>
        </div>
    </div>

    <script>
        window.accountsData = ${JSON.stringify(accountTabData.accounts)};
        ${getWebviewScript(theme)}
    </script>
</body>
</html>`;
    }

    private getInlineStyles(): string {
        return `<style>
${this.getBaseStyles()}
${this.getComponentStyles()}
${this.getTabStyles()}
${this.getModelStyles()}
${this.getAccountStyles()}
${this.getFilterStyles()}
${this.getModalStyles()}
</style>`;
    }

    // ========================================================================
    // Content Builders
    // ========================================================================

    // ========================================================================
    // Account Management Tab
    // ========================================================================

    private async buildAccountManagementTab(multiAccountInfo: MultiAccountInfo): Promise<string> {
        const accounts = multiAccountInfo.accounts || [];
        const totalAccounts = accounts.length;
        const activeCount = accounts.filter(a => !a.isExpired).length;
        const inactiveCount = totalAccounts - activeCount;

        const headerHtml = this.buildAccountHeader(activeCount, inactiveCount);

        if (accounts.length === 0) {
            return headerHtml + this.buildEmptyAccountState();
        }

        const tableRows = accounts.map(account => this.buildAccountRow(account)).join('');

        return headerHtml + `
            <div class="accounts-table-container">
                <table class="accounts-table">
                    <thead>
                        <tr>
                            <th class="col-email">EMAIL</th>
                            <th class="col-models">MODEL QUOTA</th>
                            <th class="col-actions" style="text-align: right;">ACTIONS</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${tableRows}
                    </tbody>
                </table>
            </div>
        `;
    }

    private buildAccountHeader(activeCount: number, inactiveCount: number): string {
        return `
            <div class="list-header">
                <div class="search-container">
                    <span class="codicon codicon-search"></span>
                    <input type="text" placeholder="Search email..." class="search-input">
                </div>
                <div class="header-right">
                    <div class="filter-group">
                        <button class="filter-btn available active">Available <span class="count">${activeCount}</span></button>
                        <button class="filter-btn off">OFF (Disabled) <span class="count">${inactiveCount}</span></button>
                    </div>
                </div>
            </div>
        `;
    }

    private buildEmptyAccountState(): string {
        return `
            <div class="empty-state">
                <div class="empty-state-title">No account</div>
                <div class="empty-state-description">
                    Login to start using Gravity Orchestrator
                </div>
                <button onclick="login()">
                    <span class="codicon codicon-sign-in"></span> Login with Google
                </button>
            </div>
        `;
    }

    private buildAccountRow(account: any): string {
        const isCurrent = account.isActive;
        const tierBadge = getTierBadgeHtml(account.tier);
        const currentBadge = isCurrent ? '<span class="badge-fill-blue">CURRENT</span>' : '';
        const maskedEmailText = maskEmail(account.email);
        const lastUsed = getRandomLastUsed();
        const modelsHtml = this.buildAccountModelsHtml(account.models);
        const accountStatus = account.isExpired ? 'off' : 'available';

        return `
            <tr class="account-row ${isCurrent ? 'account-row-current' : ''}" data-email="${escapeHtml(account.email)}" data-status="${accountStatus}">
                <td class="account-email-cell">
                    <div class="account-info-col">
                        <div class="email-row">
                            <span class="masked-email" title="${escapeHtml(account.email)}">${maskedEmailText}</span>
                            ${currentBadge}
                            ${tierBadge}
                        </div>
                        <span class="last-used">${lastUsed}</span>
                    </div>
                </td>
                <td class="account-models-cell">
                    ${modelsHtml}
                </td>
                <td class="account-actions-cell">
                    <div class="action-row">
                        <button class="action-btn quote-info-btn" title="View Quota" onclick="showQuotaPopup('${escapeHtml(account.email)}')"><span class="codicon codicon-info"></span></button>
                        <button class="action-btn" title="Switch" onclick="transferAccount('${escapeHtml(account.email)}')"><span class="codicon codicon-arrow-swap"></span></button>
                        <button class="action-btn" title="Refresh" onclick="refreshAccount('${escapeHtml(account.email)}', '${account.id}')"><span class="codicon codicon-refresh"></span></button>
                        <button class="action-btn" title="Delete" onclick="logoutAccount('${escapeHtml(account.email)}', '${account.id}')"><span class="codicon codicon-trash"></span></button>
                    </div>
                </td>
            </tr>
        `;
    }

    private buildAccountModelsHtml(models: any[] | undefined): string {
        let html = '<div class="account-models">';

        if (models && models.length > 0) {
            const modelMap = models.map(m => this.mapModelForDisplay(m));
            const displayModels = modelMap.slice(0, 4);

            html += displayModels.map(m => `
                <div class="model-pill ${m.colorClass}">
                    <div class="left-content">
                        <span class="name">${m.label}</span>
                        <span class="value">${m.percent}%</span>
                    </div>
                    <span class="time">${m.time}</span>
                </div>
            `).join('');
        } else {
            html += '<span style="color: var(--text-secondary); font-size: 11px;">No Quota Info</span>';
        }

        html += '</div>';
        return html;
    }

    private mapModelForDisplay(m: any): { label: string; percent: number; colorClass: string; time: string } {
        const displayName = formatModelDisplayName(m.name);
        const colorClass = getPillColorClass(m.percentage);
        const remainingTimeStr = this.calculateRemainingTime(m.reset_time);

        return {
            label: displayName,
            percent: m.percentage,
            colorClass,
            time: remainingTimeStr
        };
    }

    private calculateRemainingTime(resetTime: unknown): string {
        if (!resetTime) {
            return '2h';
        }

        try {
            let reset: Date;
            if (typeof resetTime === 'number') {
                reset = new Date(resetTime * 1000);
            } else {
                reset = new Date(resetTime as string | Date);
            }

            if (!isNaN(reset.getTime())) {
                const diff = reset.getTime() - Date.now();
                if (diff > 0) {
                    const d = Math.floor(diff / (1000 * 60 * 60 * 24));
                    const h = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
                    if (d > 0) {
                        return `${d}d`;
                    }
                    return `${h}h`;
                }
                return 'Exp';
            }
        } catch {
            // Ignore parse errors, fallback to default
        }

        return '2h';
    }

    // ========================================================================
    // Inline Styles
    // ========================================================================

    private getBaseStyles(): string {
        return `
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif; padding: 20px; color: #111827; background-color: #FAFBFC; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
body[data-vscode-theme-kind="dark"], body[data-theme="dark"] { color: #e2e8f0; background-color: #1d232a; }
.header { margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center; }
.header h1 { margin: 0 0 10px 0; font-size: 24px; font-weight: 700; color: #111827; }
body[data-vscode-theme-kind="dark"] .header h1, body[data-theme="dark"] .header h1 { color: #e2e8f0; }
.header-actions { display: flex; gap: 8px; align-items: center; }
.stale-warning { background-color: #fef3c7; color: #92400e; padding: 12px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #fde68a; }
body[data-vscode-theme-kind="dark"] .stale-warning, body[data-theme="dark"] .stale-warning { background-color: #78350f; color: #fde68a; border-color: #92400e; }
.empty-state { text-align: center; padding: 60px 20px; color: #6b7280; }
body[data-vscode-theme-kind="dark"] .empty-state, body[data-theme="dark"] .empty-state { color: #9ca3af; }
.empty-state-title { font-size: 18px; font-weight: 600; margin-bottom: 8px; color: #111827; }
body[data-vscode-theme-kind="dark"] .empty-state-title, body[data-theme="dark"] .empty-state-title { color: #e2e8f0; }
.empty-state-description { font-size: 14px; margin-bottom: 24px; }
.timestamp { color: #6b7280; font-size: 11px; margin-top: 16px; text-align: center; }
body[data-vscode-theme-kind="dark"] .timestamp, body[data-theme="dark"] .timestamp { color: #9ca3af; }
        `;
    }

    private getComponentStyles(): string {
        return `
.btn-primary { padding: 6px 12px; background-color: #3b82f6; color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 12px; font-weight: 500; display: inline-flex; align-items: center; gap: 6px; transition: all 0.2s; }
.btn-primary:hover { background-color: #2563eb; }
.btn-primary .codicon { font-size: 14px; }
.theme-toggle, .action-btn-header { background: transparent; border: 1px solid #e5e7eb; border-radius: 8px; padding: 8px 12px; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.2s; color: #6b7280; min-width: 40px; min-height: 40px; }
.theme-toggle .codicon, .action-btn-header .codicon { font-size: 16px; }
.theme-toggle:hover, .action-btn-header:hover { background: #f3f4f6; border-color: #d1d5db; color: #111827; }
body[data-vscode-theme-kind="dark"] .theme-toggle, body[data-vscode-theme-kind="dark"] .action-btn-header, body[data-theme="dark"] .theme-toggle, body[data-theme="dark"] .action-btn-header { border-color: #475569; color: #94a3b8; }
body[data-vscode-theme-kind="dark"] .theme-toggle:hover, body[data-vscode-theme-kind="dark"] .action-btn-header:hover, body[data-theme="dark"] .theme-toggle:hover, body[data-theme="dark"] .action-btn-header:hover { background: #334155; border-color: #64748b; color: #e2e8f0; }
.actions { margin-top: 24px; display: flex; gap: 8px; }
.action-row { display: flex; align-items: center; gap: 4px; justify-content: flex-end; }
.action-btn { background: transparent; border: 1px solid transparent; color: var(--text-secondary, #6b7280); cursor: pointer; width: 28px; height: 28px; border-radius: 6px; display: flex; align-items: center; justify-content: center; transition: all 0.2s; }
.action-btn:hover { color: var(--text-primary, #111827); background: var(--hover-bg, #f3f4f6); border-color: var(--border-color, #e5e7eb); }
.quote-info-btn.off { color: var(--text-secondary, #6b7280); }
        `;
    }

    private getTabStyles(): string {
        return `.tab-content { display: none; } .tab-content.active { display: block; }`;
    }

    private getModelStyles(): string {
        return `
.models-section { margin-bottom: 24px; }
.section-title { margin: 0 0 16px 0; font-size: 16px; font-weight: 600; color: #111827; display: flex; align-items: center; gap: 8px; }
body[data-vscode-theme-kind="dark"] .section-title, body[data-theme="dark"] .section-title { color: #e2e8f0; }
.models-list { display: flex; flex-direction: column; gap: 16px; }
.model-item { display: flex; flex-direction: column; gap: 6px; }
.model-progress-header { display: flex; justify-content: space-between; align-items: baseline; }
.model-name { font-size: 12px; font-weight: 500; color: #4b5563; }
body[data-vscode-theme-kind="dark"] .model-name, body[data-theme="dark"] .model-name { color: #9ca3af; }
.model-meta { display: flex; align-items: center; gap: 8px; }
.reset-time { font-size: 10px; color: #9ca3af; }
body[data-vscode-theme-kind="dark"] .reset-time, body[data-theme="dark"] .reset-time { color: #6b7280; }
.model-percentage { font-size: 12px; font-weight: 700; }
.model-progress-bar-container { width: 100%; height: 6px; background-color: #f3f4f6; border-radius: 999px; overflow: hidden; }
body[data-vscode-theme-kind="dark"] .model-progress-bar-container, body[data-theme="dark"] .model-progress-bar-container { background-color: #334155; }
.model-progress-bar { height: 100%; border-radius: 999px; transition: width 0.7s ease; }
.quota-container { display: flex; flex-direction: column; gap: 16px; width: 100%; }
.model-pill { display: flex; justify-content: space-between; align-items: center; padding: 3px 8px; border-radius: 6px; font-size: 11px; background: transparent; border: 1px solid var(--border-color, #e5e7eb); color: var(--text-primary, #111827); }
.model-pill .left-content { display: flex; align-items: center; gap: 6px; }
.model-pill .name { color: var(--text-secondary, #6b7280); font-weight: 500; }
.model-pill .value { font-weight: 600; }
.model-pill .time { font-size: 10px; color: var(--text-secondary, #6b7280); opacity: 0.8; padding-left: 6px; border-left: 1px solid var(--border-color, #e5e7eb); min-width: 24px; text-align: center; }
.model-pill.green { border-color: rgba(52, 211, 153, 0.5); }
.model-pill.green .value { color: #059669; }
.model-pill.yellow { border-color: rgba(251, 191, 36, 0.5); }
.model-pill.yellow .value { color: #d97706; }
.model-pill.red { border-color: rgba(248, 113, 113, 0.5); }
.model-pill.red .value { color: #dc2626; }
body[data-theme="dark"] .model-pill.green .value { color: #34d399; }
body[data-theme="dark"] .model-pill.yellow .value { color: #fbbf24; }
body[data-theme="dark"] .model-pill.red .value { color: #f87171; }
        `;
    }

    private getAccountStyles(): string {
        return `
.accounts-table-container { overflow-x: auto; margin-bottom: 20px; }
.accounts-table { width: 100%; border-collapse: collapse; background: var(--bg-primary, white); border-radius: 8px; overflow: hidden; border: 1px solid var(--border-color, #e5e7eb); }
body[data-theme="dark"] .accounts-table, body[data-vscode-theme-kind="dark"] .accounts-table { background: #181818; }
.accounts-table thead { background: var(--table-header-bg, #f9fafb); border-bottom: 1px solid var(--border-color, #e5e7eb); }
body[data-theme="dark"] .accounts-table thead, body[data-vscode-theme-kind="dark"] .accounts-table thead { background: #181818; border-bottom-color: #181818; }
.accounts-table th { padding: 12px; text-align: left; font-size: 11px; font-weight: 600; color: var(--text-secondary, #6b7280); text-transform: uppercase; letter-spacing: 0.05em; }
body[data-theme="dark"] .accounts-table th, body[data-vscode-theme-kind="dark"] .accounts-table th { color: #989899; }
.accounts-table .col-email { width: 30%; }
.accounts-table .col-models { width: 50%; }
.accounts-table .col-actions { width: 20%; }
.accounts-table tbody tr { border-bottom: 1px solid var(--border-color, #e5e7eb); transition: background 0.2s; background: var(--bg-primary, white); }
body[data-theme="dark"] .accounts-table tbody tr, body[data-vscode-theme-kind="dark"] .accounts-table tbody tr { border-bottom-color: #181818; }
.accounts-table tbody tr:hover { background: var(--hover-bg, #f9fafb) !important; }
body[data-theme="dark"] .accounts-table tbody tr:hover, body[data-vscode-theme-kind="dark"] .accounts-table tbody tr:hover { background: #181818; }
.account-row-current { background: rgba(59, 130, 246, 0.05) !important; }
.accounts-table td { vertical-align: middle; padding: 12px; }
.account-info-col { display: flex; flex-direction: column; gap: 4px; }
.email-row { display: flex; align-items: center; gap: 8px; }
.masked-email { font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: 13px; color: var(--text-primary, #111827); white-space: nowrap; font-weight: 500; }
.last-used { font-size: 11px; color: var(--text-secondary, #6b7280); }
.account-models { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; width: 100%; }
.badge-pro { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 99px; background: linear-gradient(135deg, #2563eb, #4f46e5); color: white; font-size: 10px; font-weight: 700; }
.badge-outline { border: 1px solid var(--border-color, #e5e7eb); color: var(--text-secondary, #6b7280); padding: 2px 8px; border-radius: 99px; font-size: 10px; font-weight: 600; background: transparent; }
.badge-fill-blue { background: #eff6ff; color: #2563eb; padding: 2px 8px; border-radius: 99px; font-size: 10px; font-weight: 700; border: 1px solid #dbeafe; }
body[data-theme="dark"] .badge-fill-blue { background: rgba(37, 99, 235, 0.2); color: #60a5fa; border-color: rgba(37, 99, 235, 0.3); }
        `;
    }

    private getFilterStyles(): string {
        return `
:root { --bg-primary: #ffffff; --bg-secondary: #f3f4f6; --bg-tertiary: #e5e7eb; --text-primary: #111827; --text-secondary: #6b7280; --border-color: #e5e7eb; --input-bg: #f9fafb; --hover-bg: #f3f4f6; --table-header-bg: #f9fafb; }
body[data-theme="dark"] { --bg-primary: #181818; --bg-secondary: #1f2937; --bg-tertiary: #374151; --text-primary: #e2e8f0; --text-secondary: #9ca3af; --border-color: #374151; --input-bg: #1f2937; --hover-bg: #374151; --table-header-bg: #1f2937; }
.list-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; gap: 20px; background: transparent; }
.search-container { position: relative; flex: 1; max-width: 300px; }
.search-container .codicon { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--text-secondary); z-index: 1; }
.search-input { width: 100%; padding: 8px 12px 8px 36px; background: var(--input-bg); border: 1px solid var(--border-color); border-radius: 6px; color: var(--text-primary); font-size: 13px; transition: all 0.2s; }
.search-input:focus { outline: none; border-color: #3b82f6; background: var(--bg-primary); box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.1); }
.header-right { display: flex; align-items: center; gap: 16px; }
.filter-group { display: flex; gap: 4px; background: var(--bg-secondary); padding: 4px; border-radius: 8px; border: 1px solid var(--border-color); }
.filter-btn { background: transparent; border: none; color: var(--text-secondary); padding: 6px 12px; border-radius: 6px; font-size: 12px; font-weight: 500; cursor: pointer; display: flex; align-items: center; gap: 6px; transition: all 0.2s; }
.filter-btn:hover { color: var(--text-primary); background: rgba(0,0,0,0.05); }
body[data-theme="dark"] .filter-btn:hover { background: rgba(255,255,255,0.05); }
.filter-btn .count { background: rgba(0,0,0,0.1); color: var(--text-primary); padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 600; }
body[data-theme="dark"] .filter-btn .count { background: rgba(255,255,255,0.1); }
.filter-btn.available.active { background: #2563eb; color: white; box-shadow: 0 1px 2px rgba(37, 99, 235, 0.2); }
.filter-btn.available.active .count { background: rgba(255,255,255,0.2); color: white; }
.filter-btn.off.active { background: var(--bg-tertiary); color: var(--text-primary); }
        `;
    }

    private getModalStyles(): string {
        return `
.modal { display: none; position: fixed; z-index: 1000; left: 0; top: 0; width: 100%; height: 100%; background-color: rgba(0,0,0,0.5); backdrop-filter: blur(2px); }
.modal-content { background-color: var(--bg-primary); margin: 10% auto; padding: 24px; border: 1px solid var(--border-color); border-radius: 12px; width: 80%; max-width: 500px; box-shadow: 0 10px 25px rgba(0,0,0,0.2); animation: modalFadeIn 0.3s ease-out; }
@keyframes modalFadeIn { from { transform: translateY(-20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
.modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; border-bottom: 1px solid var(--border-color); padding-bottom: 12px; }
.modal-header h2 { margin: 0; font-size: 18px; color: var(--text-primary); }
.close-btn { background: none; border: none; font-size: 24px; cursor: pointer; color: var(--text-secondary); transition: color 0.2s; }
.close-btn:hover { color: var(--text-primary); }
.modal-body { max-height: 400px; overflow-y: auto; }
.modal-quota-item { margin-bottom: 16px; }
.modal-quota-header { display: flex; justify-content: space-between; margin-bottom: 6px; }
.modal-quota-name { font-weight: 600; font-size: 13px; color: var(--text-primary); }
.modal-quota-percent { font-weight: 700; font-size: 13px; }
.modal-quota-bar-bg { height: 8px; background: var(--bg-secondary); border-radius: 4px; overflow: hidden; }
.modal-quota-bar-fill { height: 100%; border-radius: 4px; transition: width 0.5s ease-out; }
.modal-quota-footer { font-size: 11px; color: var(--text-secondary); margin-top: 4px; text-align: right; }
        `;
    }

}
