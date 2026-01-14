import * as vscode from 'vscode';
import { QuotaSnapshot } from './types';
import { LocalizationService } from './i18n/localizationService';
import { escapeHtml } from './utils/htmlUtils';
import { getMultiAccountInfo, cleanupDuplicateAccounts, MultiAccountInfo } from './utils/accountUtils';
import { logger } from './utils/logger';

interface WebviewMessage {
  command: string;
  email?: string;
  tab?: string;
}

export class ControlPanel {
  private static currentPanel: ControlPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];
  private lastSnapshot: QuotaSnapshot | undefined;
  private initialTab: 'quota' | 'account';

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, initialTab: 'quota' | 'account' = 'quota') {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.initialTab = initialTab;

    this.update().catch(logger.error);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      async (message: WebviewMessage) => {
        await this.handleMessage(message);
      },
      null,
      this.disposables
    );
  }

  public static createOrShow(extensionUri: vscode.Uri, initialTab: 'quota' | 'account' = 'quota') {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (ControlPanel.currentPanel) {
      ControlPanel.currentPanel.panel.reveal(column);
      // Update initial tab if panel already exists
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
    ControlPanel.currentPanel = new ControlPanel(panel, extensionUri, 'quota');
  }

  public dispose(): void {
    ControlPanel.currentPanel = undefined;
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
  }

  private async update(): Promise<void> {
    try {
      await cleanupDuplicateAccounts();
      this.panel.webview.html = await this.getHtmlForWebview(this.panel.webview, this.lastSnapshot);
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
      case 'openSettings':
        vscode.commands.executeCommand('workbench.action.openSettings', 'gravityOrchestrator').then(undefined, logger.error);
        break;
      case 'switchTab':
        if (message.tab === 'quota' || message.tab === 'account') {
          this.initialTab = message.tab;
        }
        await this.update();
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
          await executeAndUpdate('gravity-orchestrator.googleLogoutAccount', message.email);
        }
        break;
    }
  }

  private getCodiconUri(webview: vscode.Webview): vscode.Uri | null {
    try {
      const codiconPath = vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css');
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

  private getLoadingHtml(codiconUri: vscode.Uri | null): string {
    const codiconLink = codiconUri ? `<link rel="stylesheet" href="${codiconUri}">` : '';
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Gravity Orchestrator</title>
    ${codiconLink}
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            color: var(--vscode-foreground);
        }
        .loading {
            text-align: center;
            padding: 40px;
        }
    </style>
</head>
<body>
    <div class="loading">
        <p>Loading quota information...</p>
    </div>
</body>
</html>`;
  }

  private async getHtmlForWebview(webview: vscode.Webview, snapshot: QuotaSnapshot | undefined): Promise<string> {
    const localizationService = LocalizationService.getInstance();
    const codiconUri = this.getCodiconUri(webview);

    if (!snapshot) {
      return this.getLoadingHtml(codiconUri);
    }

    const multiAccountInfo = await getMultiAccountInfo();

    const modelRows = this.buildModelRows(snapshot, localizationService);
    const creditsSection = this.buildCreditsSection(snapshot, localizationService);
    const emailSection = this.buildEmailSection(snapshot);
    const staleWarning = this.buildStaleWarning(snapshot, localizationService);
    const accountTab = this.buildAccountManagementTab(multiAccountInfo);

    const codiconLink = codiconUri ? `<link rel="stylesheet" href="${codiconUri}">` : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Gravity Orchestrator</title>
    ${codiconLink}
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
        }
        .header {
            margin-bottom: 20px;
        }
        .header h1 {
            margin: 0 0 10px 0;
            font-size: 24px;
        }
        .stale-warning {
            background-color: var(--vscode-inputValidation-warningBackground);
            color: var(--vscode-inputValidation-warningForeground);
            padding: 10px;
            border-radius: 4px;
            margin-bottom: 20px;
        }
        .section {
            margin-bottom: 30px;
        }
        .section h3 {
            margin: 0 0 15px 0;
            font-size: 18px;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .section h3 .codicon {
            font-size: 18px;
        }
        .credits-info {
            background-color: var(--vscode-editor-background);
            padding: 15px;
            border-radius: 4px;
            border: 1px solid var(--vscode-panel-border);
        }
        .info-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 10px;
        }
        .info-row:last-child {
            margin-bottom: 0;
        }
        .label {
            font-weight: 500;
        }
        .value {
            font-weight: 600;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
        }
        td {
            padding: 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        tr:last-child td {
            border-bottom: none;
        }
        tr {
            transition: background-color 0.2s ease;
        }
        tr:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        .model-row-cell {
            padding: 12px 16px 16px!important;
        }
        .model-progress-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
        }
        .model-name {
            font-size: 13px;
            font-weight: 600;
            color: rgba(255, 255, 255, 0.8);
        }
        .model-meta {
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .meta-separator,
        .reset-time {
            font-size: 12px;
            color: #999999;
        }
        .model-percentage {
            font-size: 12px;
            font-weight: 600;
        }
        .model-percentage.normal {
            color: #60B940;
        }
        .model-percentage.warning {
            color: #f59e0b;
        }
        .model-percentage.critical {
            color: #ef4444;
        }
        .model-percentage.depleted {
            color: #808080;
        }
        .model-progress-bar-container {
            width: 100%;
            height: 3px;
            background-color: #eeeeee;
            border-radius: 4px;
            overflow: hidden;
        }
        .model-progress-bar {
            height: 100%;
            border-radius: 4px;
            transition: width 0.3s ease;
        }
        .model-progress-bar.normal {
            background-color: #60B940;
        }
        .model-progress-bar.warning {
            background-color: #f59e0b;
        }
        .model-progress-bar.critical {
            background-color: #ef4444;
        }
        .model-progress-bar.depleted {
            background-color: #808080;
        }
        .actions {
            margin-top: 30px;
            display: flex;
            gap: 10px;
        }
        button {
            padding: 8px 16px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        button .codicon {
            font-size: 16px;
        }
        button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        .timestamp {
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
            margin-top: 20px;
        }
        .tabs {
            display: flex;
            border-bottom: 1px solid var(--vscode-panel-border);
            margin-bottom: 20px;
            gap: 0;
        }
        .tab {
            padding: 12px 24px;
            background: transparent;
            border: none;
            border-bottom: 2px solid transparent;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
            color: var(--vscode-descriptionForeground);
            transition: all 0.2s;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .tab:hover {
            color: var(--vscode-foreground);
            background: var(--vscode-list-hoverBackground);
        }
        .tab.active {
            color: var(--vscode-foreground);
            border-bottom-color: var(--vscode-focusBorder);
        }
        .tab-content {
            display: none;
        }
        .tab-content.active {
            display: block;
        }
        .account-card {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 8px 16px;
            margin-bottom: 16px;
            transition: all 0.2s;
        }
        .account-card.active {
            border-color: var(--vscode-focusBorder);
            border-width: 2px;
        }
        .account-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        .account-info {
            flex: 1;
        }
        .account-email {
            font-size: 13px;
            font-weight: 600;
            margin-bottom: 4px;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .account-status {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: 500;
        }
        .status-authenticated {
            background: rgba(46, 160, 67, 0.15);
            color: #2ea043;
        }
        .status-not-authenticated {
            background: rgba(204, 204, 204, 0.15);
            color: #999;
        }
        .status-expired {
            background: rgba(204, 102, 51, 0.15);
            color: #cc6633;
        }
        .empty-state {
            text-align: center;
            padding: 60px 20px;
            color: var(--vscode-descriptionForeground);
        }
        .empty-state-title {
            font-size: 18px;
            font-weight: 600;
            margin-bottom: 8px;
            color: var(--vscode-foreground);
        }
        .empty-state-description {
            font-size: 14px;
            margin-bottom: 24px;
        }
        .button-group {
            display: flex;
            gap: 12px;
            align-items: center;
        }
        button.secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        button.secondary:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        button.danger {
            background: rgba(204, 51, 51, 0.15);
            color: #cc3333;
        }
        button.danger:hover {
            background: rgba(204, 51, 51, 0.25);
        }
        .account-usage-info {
            margin-top: 8px;
            display: flex;
            align-items: center;
            gap: 12px;
        }
        .usage-label {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }
        .usage-percentage {
            font-size: 12px;
            font-weight: 600;
        }
        .usage-bar-container {
            flex: 1;
            max-width: 200px;
            height: 4px;
            background: rgba(255, 255, 255, 0.1);
            border-radius: 2px;
            overflow: hidden;
        }
        .usage-bar {
            height: 100%;
            transition: width 0.3s ease;
        }
        .usage-bar.normal { background: #2ea043; }
        .usage-bar.warning { background: #f59e0b; }
        .usage-bar.critical { background: #ef4444; }
    </style>
</head>
<body>
    <div class="header">
        <h1>Antigravity Orchestrator</h1>
        ${staleWarning}
    </div>

    <div class="tabs">
        <button class="tab ${this.initialTab === 'quota' ? 'active' : ''}" onclick="switchTab('quota')">
            <span class="codicon codicon-robot"></span> Quota
        </button>
        <button class="tab ${this.initialTab === 'account' ? 'active' : ''}" onclick="switchTab('account')">
            <span class="codicon codicon-account"></span> Account Management
        </button>
    </div>

    <div id="quota-tab" class="tab-content ${this.initialTab === 'quota' ? 'active' : ''}">
        ${emailSection}

        ${creditsSection}

        <div class="section">
            <h3><span class="codicon codicon-robot"></span> Model Status</h3>
            <table>
                <tbody>
                    ${modelRows}
                </tbody>
            </table>
        </div>

        <div class="actions">
            <button onclick="refresh()"><span class="codicon codicon-refresh"></span> Refresh</button>
            <button onclick="openSettings()"><span class="codicon codicon-gear"></span> Settings</button>
        </div>

        <div class="timestamp">
            Last updated: ${snapshot.timestamp.toLocaleString()}
        </div>
    </div>

    <div id="account-tab" class="tab-content ${this.initialTab === 'account' ? 'active' : ''}">
        ${accountTab}
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        function switchTab(tabName) {
            const isQuota = tabName === 'quota';
            document.querySelectorAll('.tab, .tab-content').forEach(el => el.classList.remove('active'));
            
            const quotaTab = document.querySelector('.tab:first-child');
            const accountTab = document.querySelector('.tab:last-child');
            const quotaContent = document.getElementById('quota-tab');
            const accountContent = document.getElementById('account-tab');
            
            if (isQuota) {
                quotaTab?.classList.add('active');
                quotaContent?.classList.add('active');
            } else {
                accountTab?.classList.add('active');
                accountContent?.classList.add('active');
            }

            vscode.postMessage({ command: 'switchTab', tab: tabName });
        }

        function refresh() {
            vscode.postMessage({
                command: 'refresh'
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

        function logoutAccount(email) {
            vscode.postMessage({ command: 'logoutAccount', email: email });
        }
    </script>
</body>
</html>`;
  }

  private getStatusClass(percentage: number, isExhausted: boolean): string {
    if (isExhausted || percentage <= 0) {
      return 'depleted';
    }
    if (percentage < 20) {
      return 'critical';
    }
    if (percentage < 80) {
      return 'warning';
    }
    return 'normal';
  }

  private formatResetTime(timeString: string): string {
    if (!timeString || timeString === 'Expired') {
      return 'Expired';
    }

    const cleanTime = timeString.replace(/\s+from now$/, '');
    const parts: string[] = [];

    const timeUnits: Array<{ pattern: RegExp; unit: string; condition?: (val: number) => boolean; stopAfter?: boolean }> = [
      { pattern: /(\d+)d/, unit: 'day' },
      { pattern: /(\d+)h/, unit: 'hour' },
      { pattern: /(\d+)m/, unit: 'minute', condition: (val: number) => parts.length === 0 || val >= 30, stopAfter: true },
      { pattern: /(\d+)s/, unit: 'second', condition: () => parts.length === 0, stopAfter: true }
    ];

    for (const { pattern, unit, condition, stopAfter } of timeUnits) {
      const match = cleanTime.match(pattern);
      if (match) {
        const value = parseInt(match[1], 10);
        if (!condition || condition(value)) {
          parts.push(`${value} ${unit}${value !== 1 ? 's' : ''}`);
          if (stopAfter) break;
        }
      }
    }

    return parts.length > 0 ? parts.join(' ') : timeString;
  }

  private buildCreditsSection(snapshot: QuotaSnapshot, localizationService: LocalizationService): string {
    if (!snapshot.promptCredits) {
      return '';
    }
    const creditsTitle = localizationService.t('tooltip.credits').replace(/\*\*/g, '');
    return `
      <div class="section">
        <h3>💳 ${escapeHtml(creditsTitle)}</h3>
        <div class="credits-info">
          <div class="info-row">
            <span class="label">${escapeHtml(localizationService.t('tooltip.available'))}:</span>
            <span class="value">${snapshot.promptCredits.available} / ${snapshot.promptCredits.monthly}</span>
          </div>
          <div class="info-row">
            <span class="label">${escapeHtml(localizationService.t('tooltip.remaining'))}:</span>
            <span class="value">${snapshot.promptCredits.remainingPercentage.toFixed(1)}%</span>
          </div>
        </div>
      </div>
    `;
  }

  private buildEmailSection(snapshot: QuotaSnapshot): string {
    if (!snapshot.userEmail) {
      return '';
    }
    return `
      <div class="section">
        <h3 style="font-size: 14px;"><span class="codicon codicon-account"></span> Account:<span>${escapeHtml(snapshot.userEmail)}</span></h3>
      </div>
    `;
  }

  private buildStaleWarning(snapshot: QuotaSnapshot, localizationService: LocalizationService): string {
    if (!snapshot.isStale) {
      return '';
    }
    return `
      <div class="stale-warning">
        ⚠️ ${escapeHtml(localizationService.t('tooltip.staleWarning'))}
      </div>
    `;
  }

  private buildModelRows(snapshot: QuotaSnapshot, localizationService: LocalizationService): string {
    if (snapshot.models.length === 0) {
      return '<tr><td colspan="3" class="model-row-cell"><div style="text-align: center; padding: 20px; color: var(--vscode-descriptionForeground);">No models available</div></td></tr>';
    }
    const sortedModels = [...snapshot.models].sort((a, b) => a.label.localeCompare(b.label));
    return sortedModels.map(model => {
      const percentage = model.isExhausted ? 0 : model.remainingPercentage ?? 0;
      const statusText = model.isExhausted
        ? localizationService.t('tooltip.depleted')
        : `Remaining ${percentage.toFixed(0)}%`;
      const statusClass = this.getStatusClass(percentage, model.isExhausted);
      const formattedResetTime = this.formatResetTime(model.timeUntilResetFormatted);

      return `
        <tr>
          <td colspan="3" class="model-row-cell">
            <div>
              <div class="model-progress-header">
                <span class="model-name">${escapeHtml(model.label)}</span>
                <span class="model-meta">
                  <span class="model-percentage ${statusClass}">${escapeHtml(statusText)}</span>
                  <span class="meta-separator">·</span>
                  <span class="reset-time">Reset in ${escapeHtml(formattedResetTime)}</span>
                </span>
              </div>
              <div class="model-progress-bar-container">
                <div class="model-progress-bar ${statusClass}" style="width: ${percentage}%"></div>
              </div>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  private buildAccountManagementTab(multiAccountInfo: MultiAccountInfo): string {
    const { accounts } = multiAccountInfo;

    if (accounts.length > 0) {
      const accountsHtml = accounts.map(account => {
        let statusClass: string;
        let statusText: string;
        
        if (account.isActive) {
          statusClass = account.isExpired ? 'status-expired' : 'status-authenticated';
          statusText = account.isExpired ? '⚠️ Expired' : '✓ Active';
        } else {
          statusClass = 'status-not-authenticated';
          statusText = 'Inactive';
        }

        return `
          <div class="account-card ${account.isActive ? 'active' : ''}">
            <div class="account-header">
              <div class="account-info">
                <div class="account-email">
                  ${escapeHtml(account.email)}
                  <span class="account-status ${statusClass}">
                    ${statusText}
                  </span>
                </div>
                ${account.usagePercentage !== undefined ? `
                <div class="account-usage-info">
                  <span class="usage-label">Used:</span>
                  <div class="usage-bar-container">
                    <div class="usage-bar ${account.usagePercentage > 80 ? 'critical' : account.usagePercentage > 50 ? 'warning' : 'normal'}" 
                         style="width: ${account.usagePercentage}%"></div>
                  </div>
                  <span class="usage-percentage">${account.usagePercentage.toFixed(1)}%</span>
                </div>
                ` : ''}
              </div>
              <div class="button-group">
              ${!account.isActive ? `
                <button class="secondary" data-email="${escapeHtml(account.email)}" onclick="switchAccount(this.dataset.email)">
                  <span class="codicon codicon-refresh"></span> Switch to this account
                </button>
              ` : ''}
              <button class="danger" data-email="${escapeHtml(account.email)}" onclick="logoutAccount(this.dataset.email)">
                <span class="codicon codicon-trash"></span>
              </button>
              </div>
            </div>
          </div>
        `;
      }).join('');

      return `
        ${accountsHtml}
        <div style="margin-top: 20px; text-align: center;">
          <button onclick="addAccount()" class="secondary">
            <span class="codicon codicon-add"></span> Add another account
          </button>
        </div>
      `;
    }

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
}
