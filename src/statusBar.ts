import * as vscode from 'vscode';
import { ModelQuotaInfo, QuotaSnapshot, QuotaLevel } from './types';
import { LocalizationService } from './i18n/localizationService';
import { AntigravityToolsApi } from './api/antigravityToolsApi';
import { logger } from './utils/logger';
import { formatTimeUntilReset } from './utils/timeUtils';

export class StatusBarService {
  private statusBarItem: vscode.StatusBarItem;
  private localizationService: LocalizationService;

  private isQuickRefreshing: boolean = false;
  private refreshStartTime: number = 0;
  private readonly minRefreshDuration: number = 1000;
  
  private appApiPollingInterval?: NodeJS.Timeout;
  private readonly appApiPollInterval: number = 60000; // 60 seconds

  constructor() {
    this.localizationService = LocalizationService.getInstance();
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBarItem.command = 'gravity-orchestrator.showControlPanel';
  }

  async updateDisplayFromApp(): Promise<void> {
    try {
      const isApiReady = await AntigravityToolsApi.isApiReady();
      if (!isApiReady) {
        // API not available: show only extension name (no emoji)
        this.stopAppApiPolling();
        this.statusBarItem.text = 'Gravity Orchestrator';
        this.statusBarItem.command = 'gravity-orchestrator.showControlPanel';
        this.statusBarItem.tooltip = undefined;
        this.showStatusBar();
        return;
      }

      // API available: show emoji + extension name
      const snapshot = await this.getQuotaFromApp();
      let quotaLevel: QuotaLevel = QuotaLevel.Normal;

      if (snapshot) {
        quotaLevel = this.getQuotaLevel(snapshot);
        this.updateTooltip(snapshot);
      } else {
        this.statusBarItem.tooltip = undefined;
      }
      
      const statusEmoji = this.getStatusEmoji(quotaLevel);
      logger.info(`[StatusBar] Updating display: level=${quotaLevel}, emoji=${statusEmoji}`);

      this.statusBarItem.text = `${statusEmoji} Gravity Orchestrator`;
      this.statusBarItem.command = 'gravity-orchestrator.showControlPanel';
      this.showStatusBar();
      
      // Start polling if not already started
      this.startAppApiPolling();
    } catch (error) {
      logger.error('[StatusBar] Failed to update from app API:', error);
      // On error, show only extension name (no emoji)
      this.statusBarItem.text = 'Gravity Orchestrator';
      this.statusBarItem.command = 'gravity-orchestrator.showControlPanel';
      this.statusBarItem.tooltip = undefined;
      this.showStatusBar();
    }
  }

  private async getQuotaLevelFromApp(): Promise<QuotaLevel> {
    try {
      const snapshot = await this.getQuotaFromApp();
      if (!snapshot) {
        return QuotaLevel.Normal;
      }
      return this.getQuotaLevel(snapshot);
    } catch (error) {
      logger.error('[StatusBar] Failed to get quota level from app:', error);
      return QuotaLevel.Normal;
    }
  }

  startAppApiPolling(): void {
    if (this.appApiPollingInterval) {
      return; // Already polling
    }

    logger.info('[StatusBar] Starting app API polling');
    this.appApiPollingInterval = setInterval(() => {
      this.updateDisplayFromApp().catch(error => {
        logger.error('[StatusBar] App API polling error:', error);
      });
    }, this.appApiPollInterval);
  }

  stopAppApiPolling(): void {
    if (this.appApiPollingInterval) {
      logger.info('[StatusBar] Stopping app API polling');
      clearInterval(this.appApiPollingInterval);
      this.appApiPollingInterval = undefined;
    }
  }

  updateDisplay(snapshot: QuotaSnapshot): void {
    if (this.isQuickRefreshing && this.refreshStartTime > 0) {
      const elapsed = Date.now() - this.refreshStartTime;
      if (elapsed < this.minRefreshDuration) {
        const remaining = this.minRefreshDuration - elapsed;
        setTimeout(() => {
          this.updateDisplay(snapshot);
        }, remaining);
        return;
      }
    }

    this.isQuickRefreshing = false;
    this.refreshStartTime = 0;

    const quotaLevel = this.getQuotaLevel(snapshot);
    const statusEmoji = this.getStatusEmoji(quotaLevel);

    this.statusBarItem.text = `${statusEmoji} $(dashboard)`;
    this.statusBarItem.command = 'gravity-orchestrator.showControlPanel';
    this.updateTooltip(snapshot);

    this.showStatusBar();
  }

  private async getQuotaFromApp(): Promise<QuotaSnapshot | undefined> {
    try {
      const currentAccountResponse = await AntigravityToolsApi.getCurrentAccount();
      logger.info('[StatusBar] getQuotaFromApp: currentAccountResponse:', JSON.stringify(currentAccountResponse));
      
      if (!currentAccountResponse.account) {
        logger.warn('[StatusBar] No current account found');
        return undefined;
      }

      const account = currentAccountResponse.account;
      
      if (!account.quota) {
        logger.warn('[StatusBar] Account has no quota data');
        return undefined;
      }

      const quota = account.quota;

      if (!quota || !quota.models || quota.models.length === 0) {
        logger.warn('[StatusBar] Quota has no models');
        return undefined;
      }

      logger.info(`[StatusBar] Found ${quota.models.length} models in quota`);

      // Convert quota from app format to QuotaSnapshot format
      const models: ModelQuotaInfo[] = quota.models.map(model => {
        const resetTime = new Date(model.reset_time);
        const timeUntilReset = resetTime.getTime() - Date.now();

        return {
          label: model.name,
          modelId: model.name,
          remainingFraction: model.percentage / 100,
          remainingPercentage: model.percentage,
          isExhausted: model.percentage <= 0,
          resetTime,
          timeUntilReset,
          timeUntilResetFormatted: formatTimeUntilReset(timeUntilReset),
        };
      });

      return {
        timestamp: quota.updated_at ? new Date(quota.updated_at * 1000) : new Date(),
        promptCredits: undefined,
        models,
        planName: quota.subscription_tier,
        userEmail: account.email,
      };
    } catch (error) {
      logger.error('[StatusBar] Failed to get quota from app:', error);
      return undefined;
    }
  }

  private updateTooltip(snapshot: QuotaSnapshot): void {
    const md = new vscode.MarkdownString('', true);
    md.isTrusted = true;
    md.supportHtml = true;

    const titleSuffix = snapshot.planName ? ` (${snapshot.planName})` : '';
    md.appendMarkdown(`${this.localizationService.t('tooltip.title')}${titleSuffix}\n\n`);

    if (snapshot.userEmail) {
      md.appendMarkdown(`📧 ${snapshot.userEmail}\n\n`);
    }

    const sortedModels = [...snapshot.models].sort((a, b) => a.label.localeCompare(b.label));

    if (sortedModels.length > 0) {
      const modelHeader = this.localizationService.t('tooltip.model');
      const usageHeader = this.localizationService.t('tooltip.status');
      const resetHeader = this.localizationService.t('tooltip.resetTime');
      
      md.appendMarkdown(`| ${modelHeader} | ${usageHeader} | ${resetHeader} |\n`);
      md.appendMarkdown('|:---|:---|---:|\n');

      for (const model of sortedModels) {
        const usage = model.remainingPercentage !== undefined ? model.remainingPercentage : 0;
        const barColor = this.getBarColor(usage);
        const percentageText = model.isExhausted ? '0%' : `${usage.toFixed(0)}%`;
        
        const progressBarSvg = this.generateProgressBarSvg(usage, barColor);

        // One line per model: Label | Progress Bar + % | Reset Time
        md.appendMarkdown(`| ${model.label} | ![](${progressBarSvg}) &nbsp; **${percentageText}** | ${model.timeUntilResetFormatted} |\n`);
      }
    }

    this.statusBarItem.tooltip = md;
  }

  private generateProgressBarSvg(percentage: number, color: string): string {
    const width = 60;
    const height = 4;
    const radius = 2;
    // Ensure percentage is between 0 and 100
    const safePercentage = Math.max(0, Math.min(100, percentage));
    const fillWidth = (safePercentage / 100) * width;

    const svg = `
      <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
        <rect width="${width}" height="${height}" rx="${radius}" fill="#333333" />
        <rect width="${fillWidth}" height="${height}" rx="${radius}" fill="${color}" />
      </svg>
    `.trim();

    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  }

  private getBarColor(percentage: number): string {
    if (percentage <= 30) {
      return '#ff453a'; // Critical (Red)
    }
    if (percentage <= 50) {
      return '#ff9f0a'; // Warning (Orange)
    }
    return '#32d74b'; // Normal (Green)
  }

  private getQuotaLevel(snapshot: QuotaSnapshot): QuotaLevel {
    if (!snapshot.models || snapshot.models.length === 0) {
      return QuotaLevel.Normal;
    }

    let worstLevel = QuotaLevel.Normal;

    for (const model of snapshot.models) {
      if (model.isExhausted || (model.remainingPercentage !== undefined && model.remainingPercentage <= 0)) {
        return QuotaLevel.Depleted;
      }

      if (model.remainingPercentage !== undefined && model.remainingPercentage <= 30) {
        worstLevel = QuotaLevel.Critical;
        continue;
      }

      if (model.remainingPercentage !== undefined && model.remainingPercentage <= 50) {
        if (worstLevel === QuotaLevel.Normal) {
          worstLevel = QuotaLevel.Warning;
        }
        continue;
      }
    }

    return worstLevel;
  }

  private getStatusEmoji(level: QuotaLevel): string {
    switch (level) {
      case QuotaLevel.Depleted:
        return '🔴';
      case QuotaLevel.Critical:
        return '🟠';
      case QuotaLevel.Warning:
        return '🟡';
      case QuotaLevel.Normal:
      default:
        return '🟢';
    }
  }

  showQuickRefreshing(): void {
    if (this.isQuickRefreshing) {
      return;
    }
    this.isQuickRefreshing = true;
    this.refreshStartTime = Date.now();

    const currentText = this.statusBarItem.text;
    if (!currentText.startsWith('$(sync~spin)')) {
      this.statusBarItem.text = `${this.localizationService.t('status.refreshing')}`;
    }

    this.statusBarItem.tooltip = this.localizationService.t('status.refreshing');
    this.showStatusBar();
  }

  showDetecting(): void {
    this.statusBarItem.text = this.localizationService.t('status.detecting');
    this.statusBarItem.tooltip = this.localizationService.t('status.detecting');
    this.showStatusBar();
  }

  showInitializing(): void {
    this.statusBarItem.text = this.localizationService.t('status.initializing');
    this.statusBarItem.tooltip = this.localizationService.t('status.initializing');
    this.showStatusBar();
  }

  showFetching(): void {
    this.statusBarItem.text = this.localizationService.t('status.fetching');
    this.statusBarItem.tooltip = this.localizationService.t('status.fetching');
    this.showStatusBar();
  }

  showRetrying(currentRetry: number, maxRetries: number): void {
    this.statusBarItem.text = this.localizationService.t('status.retrying', { current: currentRetry, max: maxRetries });
    this.statusBarItem.tooltip = this.localizationService.t('status.retrying', { current: currentRetry, max: maxRetries });
    this.showStatusBar();
  }

  showError(message: string): void {
    this.statusBarItem.text = this.localizationService.t('status.error');
    this.statusBarItem.tooltip = `${message}\n\n${this.localizationService.t('tooltip.clickToRetry')}`;

    this.statusBarItem.command = 'gravity-orchestrator.refreshQuota';
    this.showStatusBar();
  }

  clearError(): void {
    this.statusBarItem.text = this.localizationService.t('status.fetching');
    this.statusBarItem.tooltip = this.localizationService.t('status.fetching');
    this.showStatusBar();
  }

  showNotLoggedIn(): void {
    this.statusBarItem.text = this.localizationService.t('status.notLoggedIn');
    this.statusBarItem.tooltip = this.localizationService.t('tooltip.clickToLogin');
    this.statusBarItem.command = 'gravity-orchestrator.googleLogin';
    this.showStatusBar();
  }

  showLoggingIn(): void {
    this.statusBarItem.text = this.localizationService.t('status.loggingIn');
    this.statusBarItem.tooltip = this.localizationService.t('status.loggingIn');
    this.statusBarItem.command = undefined;
    this.showStatusBar();
  }

  showLoginExpired(): void {
    this.statusBarItem.text = this.localizationService.t('status.loginExpired');
    this.statusBarItem.tooltip = this.localizationService.t('tooltip.clickToRelogin');
    this.statusBarItem.command = 'gravity-orchestrator.googleLogin';
    this.showStatusBar();
  }

  showStale(): void {
    const currentText = this.statusBarItem.text;
    const staleIcon = this.localizationService.t('status.stale');

    if (!currentText.startsWith(staleIcon)) {
      this.statusBarItem.text = `${staleIcon} ${currentText}`;
    }

    const currentTooltip = this.statusBarItem.tooltip;
    if (currentTooltip instanceof vscode.MarkdownString) {
      const staleWarning = this.localizationService.t('tooltip.staleWarning');

      const newMd = new vscode.MarkdownString();
      newMd.isTrusted = true;
      newMd.supportHtml = true;
      newMd.appendMarkdown(`${staleWarning}\n\n`);
      newMd.appendMarkdown(currentTooltip.value);
      this.statusBarItem.tooltip = newMd;
    }
    this.showStatusBar();
  }

  clearStale(): void {
    const currentText = this.statusBarItem.text;
    const staleIcon = this.localizationService.t('status.stale');
    if (currentText.startsWith(staleIcon)) {
      this.statusBarItem.text = currentText.substring(staleIcon.length + 1);
    }
  }

  private showStatusBar(): void {
    this.statusBarItem.show();
  }

  private hideStatusBar(): void {
    this.statusBarItem.hide();
  }

  show(): void {
    this.showStatusBar();
  }

  hide(): void {
    this.hideStatusBar();
  }

  dispose(): void {
    this.stopAppApiPolling();
    this.statusBarItem.dispose();
  }
}


