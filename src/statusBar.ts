import * as vscode from 'vscode';
import { ModelQuotaInfo, QuotaSnapshot, QuotaLevel } from './types';
import { LocalizationService } from './i18n/localizationService';

export class StatusBarService {
  private statusBarItem: vscode.StatusBarItem;
  private localizationService: LocalizationService;

  private isQuickRefreshing: boolean = false;
  private refreshStartTime: number = 0;
  private readonly minRefreshDuration: number = 1000;

  constructor() {
    this.localizationService = LocalizationService.getInstance();
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBarItem.command = 'gravity-orchestrator.showControlPanel';
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

  private updateTooltip(snapshot: QuotaSnapshot): void {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportHtml = true;

    const titleSuffix = snapshot.planName ? ` (${snapshot.planName})` : '';
    md.appendMarkdown(`${this.localizationService.t('tooltip.title')}${titleSuffix}\n\n`);

    if (snapshot.userEmail) {
      md.appendMarkdown(`📧 ${snapshot.userEmail}\n\n`);
    }

    const sortedModels = [...snapshot.models].sort((a, b) => a.label.localeCompare(b.label));

    if (sortedModels.length > 0) {
      md.appendMarkdown(`| ${this.localizationService.t('tooltip.model')} | ${this.localizationService.t('tooltip.status')} | ${this.localizationService.t('tooltip.resetTime')} |\n`);
      md.appendMarkdown(`| :--- | :--- | :--- |\n`);

      for (const model of sortedModels) {
        let status = '';
        if (model.isExhausted) {
          status = this.localizationService.t('tooltip.depleted');
        } else if (model.remainingPercentage !== undefined) {
          status = `${model.remainingPercentage.toFixed(1)}%`;
        }

        md.appendMarkdown(`| ${model.label} | ${status} | ${model.timeUntilResetFormatted} |\n`);
      }
    }

    this.statusBarItem.tooltip = md;
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
    this.statusBarItem.dispose();
  }
}
