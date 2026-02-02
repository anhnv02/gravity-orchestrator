export type TranslationKey =

    | 'status.initializing'
    | 'status.fetching'
    | 'status.retrying'
    | 'status.error'
    | 'status.refreshing'
    | 'status.notLoggedIn'
    | 'status.loggingIn'
    | 'status.loginExpired'
    | 'status.stale'

    | 'tooltip.title'

    | 'tooltip.resetTime'
    | 'tooltip.model'
    | 'tooltip.status'
    | 'tooltip.error'
    | 'tooltip.clickToRetry'
    | 'tooltip.clickToLogin'
    | 'tooltip.clickToRelogin'
    | 'tooltip.staleWarning'

    | 'notify.retry'
    | 'notify.cancel'
    | 'notify.refreshingQuota'

    | 'notify.configUpdated'

    | 'notify.pleaseLoginFirst'

    | 'login.error.serviceNotInitialized'
    | 'login.error.authFailed'

    | 'notify.localTokenDetected'
    | 'notify.useLocalToken'
    | 'notify.manualLogin'

    | 'notify.tokenChanged'
    | 'notify.tokenRemoved'
    | 'notify.syncToken'
    | 'notify.keepCurrentToken'
    | 'notify.syncLogout'
    | 'notify.keepLogin'

    | 'login.success.google'
    | 'login.success.localToken'
    | 'login.error.google'
    | 'login.error.localToken'
    | 'logout.success'

    | 'devTools.previewComplete'
    | 'devTools.stop'
    | 'common.yes'
    | 'common.no'


export interface TranslationMap {
    [key: string]: string;
}
