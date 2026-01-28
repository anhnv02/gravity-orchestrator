import * as vscode from 'vscode';
import { LocalizationService } from './i18n/localizationService';
import { TranslationKey } from './i18n/types';
import { logger } from './utils/logger';

export function registerDevCommands(context: vscode.ExtensionContext) {

    if (context.extensionMode === vscode.ExtensionMode.Production) {
        return;
    }

    logger.info('[DevTools] Registering dev commands (non-production mode)');
    const locService = LocalizationService.getInstance();

    const previewNotificationsCommand = vscode.commands.registerCommand(
        'gravity-orchestrator.dev.previewNotifications',
        async () => {
            const notifyKeys: { key: TranslationKey; type: 'info' | 'warning' | 'error' }[] = [
                { key: 'notify.unableToDetectProcess', type: 'warning' },
                { key: 'notify.refreshingQuota', type: 'info' },
                { key: 'notify.detectionSuccess', type: 'info' },
                { key: 'notify.unableToDetectPort', type: 'error' },
                { key: 'notify.portDetectionFailed', type: 'error' },
                { key: 'notify.configUpdated', type: 'info' },
                { key: 'notify.portCommandRequired', type: 'error' },
            ];

            const items: vscode.QuickPickItem[] = [
                { label: '$(play-all) Play all notifications', description: 'Show all notifications sequentially' },
                { label: '', kind: vscode.QuickPickItemKind.Separator },
                ...notifyKeys.map(n => ({
                    label: getTypeIcon(n.type) + ' ' + n.key,
                    description: locService.t(n.key, { port: '12345', error: 'Sample error' }).substring(0, 50)
                }))
            ];

            const selected = await vscode.window.showQuickPick(items, {
                title: '🔧 Dev Tools: Preview Notifications',
                placeHolder: 'Select notification to preview, or play all'
            });

            if (!selected) return;

            if (selected.label.includes('Play all')) {

                for (const n of notifyKeys) {
                    const msg = locService.t(n.key, { port: '12345', error: 'Sample error' });
                    const choice = await showNotification(n.type, `[${n.key}]\n${msg}`, ['Next', locService.t('devTools.stop')]);
                    if (choice === locService.t('devTools.stop')) break;
                }
                vscode.window.showInformationMessage(locService.t('devTools.previewComplete'));
            } else {

                const keyMatch = selected.label.match(/notify\.\w+/);
                if (keyMatch) {
                    const key = keyMatch[0] as TranslationKey;
                    const notifyItem = notifyKeys.find(n => n.key === key);
                    if (notifyItem) {
                        const msg = locService.t(notifyItem.key, { port: '12345', error: 'Sample error' });
                        await showNotification(notifyItem.type, `[${key}]\n${msg}`);
                    }
                }
            }
        }
    );

    const previewStatusBarCommand = vscode.commands.registerCommand(
        'gravity-orchestrator.dev.previewStatusBar',
        async () => {
            const statusKeys: TranslationKey[] = [
                'status.initializing',
                'status.detecting',
                'status.fetching',
                'status.retrying',
                'status.error',
                'status.refreshing',
            ];

            const items: vscode.QuickPickItem[] = statusKeys.map(key => ({
                label: key,
                description: locService.t(key, { current: '1', max: '3' })
            }));

            await vscode.window.showQuickPick(items, {
                title: '🔧 Dev Tools: Preview Status Bar Text',
                placeHolder: 'View status bar text (preview only, does not change actual status bar)'
            });
        }
    );

    const previewTooltipCommand = vscode.commands.registerCommand(
        'gravity-orchestrator.dev.previewTooltip',
        async () => {
            const tooltipKeys: TranslationKey[] = [
                'tooltip.title',
                'tooltip.credits',
                'tooltip.available',
                'tooltip.remaining',
                'tooltip.depleted',
                'tooltip.resetTime',
                'tooltip.model',
                'tooltip.status',
                'tooltip.error',
                'tooltip.clickToRetry',
            ];

            let tooltipPreview = '=== Tooltip Content Preview ===\n\n';
            for (const key of tooltipKeys) {
                tooltipPreview += `${key}:\n  ${locService.t(key)}\n\n`;
            }

            const channel = vscode.window.createOutputChannel('Gravity Orchestrator Dev Preview');
            channel.clear();
            channel.appendLine(tooltipPreview);
            channel.show();
        }
    );

    context.subscriptions.push(
        previewNotificationsCommand,
        previewStatusBarCommand,
        previewTooltipCommand
    );
}

function getTypeIcon(type: 'info' | 'warning' | 'error'): string {
    switch (type) {
        case 'info': return '$(info)';
        case 'warning': return '$(warning)';
        case 'error': return '$(error)';
    }
}

async function showNotification(
    type: 'info' | 'warning' | 'error',
    message: string,
    buttons?: string[]
): Promise<string | undefined> {
    switch (type) {
        case 'info':
            return vscode.window.showInformationMessage(message, ...(buttons || []));
        case 'warning':
            return vscode.window.showWarningMessage(message, ...(buttons || []));
        case 'error':
            return vscode.window.showErrorMessage(message, ...(buttons || []));
    }
}
