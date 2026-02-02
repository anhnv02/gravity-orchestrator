import { TranslationMap } from './types';

export const en: TranslationMap = {
    // Status Bar
    'status.initializing': '⏳ Initializing...',
    'status.fetching': '$(sync~spin) Fetching quota...',
    'status.retrying': '$(sync~spin) Retrying ({current}/{max})...',
    'status.error': '$(error) Gravity Orchestrator: Error',
    'status.refreshing': '$(sync~spin) Refreshing...',
    'status.notLoggedIn': '$(account) Not logged in, click to login',
    'status.loggingIn': '$(sync~spin) Logging in...',
    'status.loginExpired': '$(warning) Login expired, click to re-login',
    'status.stale': '⏸️',

    // Tooltip
    'tooltip.title': '**Gravity Orchestrator Quota**', // Markdown bold

    'tooltip.resetTime': 'Reset',
    'tooltip.model': 'Model',
    'tooltip.status': 'Status',
    'tooltip.error': 'Error fetching quota information.',
    'tooltip.clickToRetry': 'Click to retry',
    'tooltip.clickToLogin': 'Click to login with Google',
    'tooltip.clickToRelogin': 'Login expired, click to re-login',
    'tooltip.staleWarning': '⚠️ Data may be outdated (network issue or timeout)',

    // Notifications (vscode.window.show*Message)
    'notify.retry': 'Retry',
    'notify.cancel': 'Cancel',
    'notify.refreshingQuota': '🔄 Refreshing quota...',
    'notify.configUpdated': 'Gravity Orchestrator config updated',

    'notify.pleaseLoginFirst': 'Please login with Google first',

    // Login errors
    'login.error.serviceNotInitialized': 'Auth service not initialized',
    'login.error.authFailed': 'Authentication failed',

    // Local Token detection
    'notify.localTokenDetected': 'Detected local Gravity Orchestrator login. Use this account?',
    'notify.useLocalToken': 'Use local token',
    'notify.manualLogin': 'Manual login',

    // Token sync check
    'notify.tokenChanged': 'Gravity Orchestrator account changed. Sync now?',
    'notify.tokenRemoved': 'Gravity Orchestrator logged out. Sync logout?',
    'notify.syncToken': 'Sync',
    'notify.keepCurrentToken': 'Keep current',
    'notify.syncLogout': 'Sync logout',
    'notify.keepLogin': 'Keep login',

    // Login success/error messages
    'login.success.google': 'Successfully logged in with Google!',
    'login.success.localToken': 'Successfully logged in with local Gravity Orchestrator account!',
    'login.error.google': 'Google login failed: {error}',
    'login.error.localToken': 'Login with local token failed: {error}',
    'logout.success': 'Logged out from Google account',

    // Dev tools
    'devTools.previewComplete': '✅ Notification preview complete',
    'devTools.stop': 'Stop',
    'common.yes': 'Yes',
    'common.no': 'No',

};
