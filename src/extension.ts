import * as vscode from 'vscode';
import { QuotaService, QuotaApiMethod } from './quotaService';
import { StatusBarService } from './statusBar';
import { ConfigService } from './configService';

import { Config, QuotaSnapshot } from './types';
import { LocalizationService } from './i18n/localizationService';
import { versionInfo } from './versionInfo';
import { registerDevCommands } from './devTools';
import { GoogleAuthService, AuthState, AuthStateInfo, extractRefreshTokenFromAntigravity, hasAntigravityDb, TokenSyncChecker } from './auth';

import { logger } from './utils/logger';
import { GravitySidebarProvider } from './sidebar/sidebarProvider';

let quotaService: QuotaService | undefined;
let statusBarService: StatusBarService | undefined;
let configService: ConfigService | undefined;

let googleAuthService: GoogleAuthService | undefined;
let sidebarProvider: GravitySidebarProvider | undefined;
let lastQuotaSnapshot: QuotaSnapshot | undefined;
let configChangeTimer: NodeJS.Timeout | undefined;
let localTokenCheckTimer: NodeJS.Timeout | undefined;


const LOCAL_TOKEN_CHECK_INTERVAL_MS = 30000;


export async function activate(context: vscode.ExtensionContext) {
    logger.initialize(context);
    versionInfo.initialize(context);
    logger.info(`=== Gravity Orchestrator v${versionInfo.getExtensionVersion()} ===`);
    logger.info(`Running on: ${versionInfo.getIdeName()} v${versionInfo.getIdeVersion()}`);

    vscode.commands.executeCommand('setContext', 'gravityOrchestrator.isDev', context.extensionMode === vscode.ExtensionMode.Development);

    configService = new ConfigService();
    let config = configService.getConfig();

    const localizationService = LocalizationService.getInstance();

    statusBarService = new StatusBarService();

    // Check if Gravity Orchestrator app is available first
    const { GravityOrchestratorApi } = await import('./api/gravityOrchestratorApi');
    const isAppApiReady = await GravityOrchestratorApi.isApiReady();
    
    if (isAppApiReady) {
        logger.info('[Extension] Gravity Orchestrator app is ready, using app API for status bar');
        statusBarService.updateDisplayFromApp().catch(error => {
            logger.error('[Extension] Failed to initialize status bar from app API:', error);
            if (statusBarService) { 
                statusBarService.show(); 
            }
        });
    } else {
        logger.info('[Extension] Gravity Orchestrator app is not ready, will use GOOGLE_API');
        statusBarService.showInitializing();
    }

    googleAuthService = GoogleAuthService.getInstance();
    await googleAuthService.initialize(context);

    await autoAddAccountFromIde();

    // Always use GOOGLE_API method for quota polling (Gravity Orchestrator app data is fetched separately)
    await initializeGoogleApiMethod(context, config, localizationService, statusBarService, googleAuthService);

    const quickRefreshQuotaCommand = vscode.commands.registerCommand(
        'gravity-orchestrator.quickRefreshQuota',
        async () => {
            if (!statusBarService || !configService) {return;}

            logger.info('[Extension] quickRefreshQuota command invoked');

            await statusBarService.updateDisplayFromApp();

            if (!quotaService) {
                config = configService.getConfig();
                const currentApiMethod = getApiMethodFromConfig(config.apiMethod);

                if (currentApiMethod === QuotaApiMethod.GOOGLE_API) {
                    logger.info('[Extension] quotaService not initialized in GOOGLE_API mode, prompt login');
                    vscode.window.showInformationMessage(
                        localizationService.t('notify.pleaseLoginFirst')
                    );
                }


                return;
            }

            logger.info('User triggered quick quota refresh');
            await quotaService.quickRefresh();
        }
    );

    const refreshQuotaCommand = vscode.commands.registerCommand(
        'gravity-orchestrator.refreshQuota',
        async () => {
            if (!statusBarService || !configService) {return;}

            logger.info('[Extension] refreshQuota command invoked');
            if (!quotaService) {
                config = configService.getConfig();
                const currentApiMethod = getApiMethodFromConfig(config.apiMethod);

                if (currentApiMethod === QuotaApiMethod.GOOGLE_API) {
                    logger.info('[Extension] quotaService not initialized in GOOGLE_API mode, prompt login');
                    vscode.window.showInformationMessage(
                        localizationService.t('notify.pleaseLoginFirst')
                    );
                }


                return;
            }

            vscode.window.showInformationMessage(localizationService.t('notify.refreshingQuota'));
            config = configService.getConfig();
            statusBarService.showFetching();

            if (config.enabled) {
                quotaService.setApiMethod(getApiMethodFromConfig(config.apiMethod));
                await quotaService.retryFromError(config.pollingInterval);
            }
        }
    );



    const configChangeDisposable = configService.onConfigChange((newConfig) => {
        handleConfigChange(newConfig as Config);
    });



    const googleLoginCommand = vscode.commands.registerCommand(
        'gravity-orchestrator.googleLogin',
        async () => {
            if (!googleAuthService || !configService || !statusBarService) {
                vscode.window.showErrorMessage(localizationService.t('login.error.serviceNotInitialized'));
                return;
            }

            logger.info('[Extension] googleLogin command invoked');
            
            statusBarService.showLoggingIn();
            const success = await googleAuthService.login();
            if (success) {
                const userEmail = googleAuthService.getUserEmail();
                if (userEmail) {
                    await syncAccountToApp(userEmail);
                }

                config = configService.getConfig();
                if (config.apiMethod === 'GOOGLE_API' && quotaService) {
                    if (config.enabled) {
                        await quotaService.startPolling(config.pollingInterval);
                    }
                    await quotaService.quickRefresh();
                }
            } else {
                statusBarService.showNotLoggedIn();
            }
        }
    );

    const googleLogoutCommand = vscode.commands.registerCommand(
        'gravity-orchestrator.googleLogout',
        async () => {
            if (!googleAuthService || !configService || !statusBarService) {return;}

            logger.info('[Extension] googleLogout command invoked');

            const userEmail = googleAuthService.getUserEmail();
            const wasLoggedIn = await googleAuthService.logout();
            if (wasLoggedIn || userEmail) {
                const emailToRemove = userEmail;
                if (emailToRemove) {
                    try {
                        const { GravityOrchestratorApi } = await import('./api/gravityOrchestratorApi');
                        if (await GravityOrchestratorApi.isApiReady()) {
                            await GravityOrchestratorApi.removeAccount(emailToRemove);
                            logger.info(`[Extension] Successfully removed active account from app: ${emailToRemove}`);
                        }
                    } catch (e) {
                        logger.error('[Extension] Failed to remove active account from app:', e);
                    }
                }
                vscode.window.showInformationMessage(localizationService.t('logout.success'));
            }

            config = configService.getConfig();
            if (config.apiMethod === 'GOOGLE_API') {
                lastQuotaSnapshot = undefined;
                quotaService?.stopPolling();
                statusBarService.clearStale();
                statusBarService.showNotLoggedIn();
                
                sidebarProvider?.update(undefined);
            }
        }
    );

    const googleAddAccountCommand = vscode.commands.registerCommand(
        'gravity-orchestrator.googleAddAccount',
        async () => {
             if (!googleAuthService || !configService || !statusBarService) {
                vscode.window.showErrorMessage(localizationService.t('login.error.serviceNotInitialized'));
                return;
            }

            logger.info('[Extension] googleAddAccount command invoked');

            statusBarService.showLoggingIn();
            const success = await googleAuthService.addAccount();
            if (success) {
                const userEmail = googleAuthService.getUserEmail();
                if (userEmail) {
                    await syncAccountToApp(userEmail);
                }

                statusBarService.updateDisplayFromApp().catch(error => {
                    logger.error('[Extension] Failed to update status bar:', error);
                });
                
                // Force Update Sidebar
                sidebarProvider?.update(undefined);

                config = configService.getConfig();
                if (config.apiMethod === 'GOOGLE_API' && quotaService) {
                    if (config.enabled) {
                        await quotaService.startPolling(config.pollingInterval);
                    }
                    await quotaService.quickRefresh();
                }
            } else {
                statusBarService.showNotLoggedIn();
            }
        }
    );

    const googleSwitchAccountCommand = vscode.commands.registerCommand(
        'gravity-orchestrator.googleSwitchAccount',
        async (email: string) => {
            if (!googleAuthService || !configService || !statusBarService) {
                vscode.window.showErrorMessage(localizationService.t('login.error.serviceNotInitialized'));
                return;
            }

            logger.info('[Extension] googleSwitchAccount command invoked for:', email);

            const success = await googleAuthService.switchAccount(email);
            if (success) {
                try {
                    const { GravityOrchestratorApi } = await import('./api/gravityOrchestratorApi');
                    if (await GravityOrchestratorApi.isApiReady()) {
                        const accountsResponse = await GravityOrchestratorApi.listAccounts();
                        const targetAccount = accountsResponse.accounts.find(a => a.email === email);
                        if (targetAccount) {
                            await GravityOrchestratorApi.switchAccount(targetAccount.id);
                            logger.info(`[Extension] Successfully switched account in app to: ${email}`);
                        }
                    }
                } catch (e) {
                    logger.error('[Extension] Failed to switch account in app:', e);
                }

                lastQuotaSnapshot = undefined;
                statusBarService.showFetching();

                // Wait a brief moment for app to update its internal state before refreshing UI
                await new Promise(resolve => setTimeout(resolve, 500));
                
                sidebarProvider?.update(undefined);

                config = configService.getConfig();
                if (config.apiMethod === 'GOOGLE_API' && quotaService) {
                    if (config.enabled) {
                        await quotaService.startPolling(config.pollingInterval);
                    }
                    await quotaService.quickRefresh();
                }
                vscode.window.showInformationMessage(`Switched to account: ${email}`);
            } else {
                vscode.window.showErrorMessage(`Failed to switch to account: ${email}`);
            }
        }
    );

    const googleLogoutAccountCommand = vscode.commands.registerCommand(
        'gravity-orchestrator.googleLogoutAccount',
        async (email: string, accountId?: string) => {
            if (!googleAuthService || !configService || !statusBarService) {return;}

            logger.info('[Extension] googleLogoutAccount command invoked for:', email, accountId);

            await googleAuthService.logoutAccount(email);
            vscode.window.showInformationMessage(`Removed account: ${email}`);

            try {
                const { GravityOrchestratorApi } = await import('./api/gravityOrchestratorApi');
                if (await GravityOrchestratorApi.isApiReady()) {
                    await GravityOrchestratorApi.removeAccount(email, accountId);
                    logger.info(`[Extension] Successfully removed account from app: ${email} (ID: ${accountId})`);

                    // Wait a brief moment for app to update its internal state
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            } catch (e) {
                logger.error('[Extension] Failed to remove account from app:', e);
            }

            config = configService.getConfig();
            const activeAccount = await googleAuthService.getActiveAccount();

            // Clear snapshots to force fresh fetch
            lastQuotaSnapshot = undefined;

            if (config.apiMethod === 'GOOGLE_API') {
                if (!activeAccount) {
                    quotaService?.stopPolling();
                    statusBarService.clearStale();
                    statusBarService.showNotLoggedIn();
                    
                    sidebarProvider?.update(undefined);
                } else {
                    // Re-start polling and refresh for the new active account
                    if (config.enabled && quotaService) {
                        await quotaService.startPolling(config.pollingInterval);
                        await quotaService.quickRefresh();
                    }
                    sidebarProvider?.update(undefined);
                }
            } else {
                sidebarProvider?.update(undefined);
                if (config.enabled && quotaService) {
                    await quotaService.quickRefresh();
                }
            }

        }
    );

    const authStateDisposable = googleAuthService.onAuthStateChange((stateInfo: AuthStateInfo) => {
        logger.info('[Extension] Auth state changed:', stateInfo.state);
        const currentConfig = configService?.getConfig();
        if (currentConfig?.apiMethod !== 'GOOGLE_API') {
            return;
        }

        switch (stateInfo.state) {
            case AuthState.AUTHENTICATED:
                stopLocalTokenCheckTimer();
                if (currentConfig?.enabled) {
                    quotaService?.startPolling(currentConfig.pollingInterval);
                    quotaService?.quickRefresh();
                }
                sidebarProvider?.update(lastQuotaSnapshot);
                break;
            case AuthState.NOT_AUTHENTICATED:
                quotaService?.stopPolling();
                statusBarService?.clearStale();
                statusBarService?.showNotLoggedIn();
                startLocalTokenCheckTimer();
                sidebarProvider?.update(lastQuotaSnapshot);
                break;
            case AuthState.TOKEN_EXPIRED:
                quotaService?.stopPolling();
                statusBarService?.clearStale();
                statusBarService?.showLoginExpired();
                startLocalTokenCheckTimer();
                sidebarProvider?.update(lastQuotaSnapshot);
                break;
            case AuthState.AUTHENTICATING:
                statusBarService?.showLoggingIn();
                sidebarProvider?.update(lastQuotaSnapshot);
                break;
            case AuthState.ERROR:
                statusBarService?.showError(localizationService.t('login.error.authFailed'));
                sidebarProvider?.update(lastQuotaSnapshot);
                break;
        }
    });

    context.subscriptions.push(
        quickRefreshQuotaCommand,
        refreshQuotaCommand,

        googleLoginCommand,
        googleLogoutCommand,
        googleAddAccountCommand,
        googleSwitchAccountCommand,
        googleLogoutAccountCommand,
        vscode.commands.registerCommand('gravity-orchestrator.showControlPanel', async () => {
            await vscode.commands.executeCommand('gravity-orchestrator.sidebarView.focus');
        }),
        configChangeDisposable,

        authStateDisposable,
        { dispose: () => quotaService?.dispose() },
        { dispose: () => statusBarService?.dispose() }
    );

    // Initialize Sidebar Provider
    sidebarProvider = new GravitySidebarProvider(context.extensionUri, quotaService);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(GravitySidebarProvider.viewType, sidebarProvider)
    );
    
    // Pass latest snapshot to sidebar if available
    if (lastQuotaSnapshot) {
        sidebarProvider.update(lastQuotaSnapshot);
    }

    registerDevCommands(context);

    logger.info('Gravity Orchestrator initialized');
}

async function autoAddAccountFromIde(): Promise<void> {
    try {
        const { GravityOrchestratorApi } = await import('./api/gravityOrchestratorApi');
        const { extractRefreshTokenFromAntigravity, hasAntigravityDb } = await import('./auth/antigravityTokenExtractor');

        // Check if app API is ready
        const isApiReady = await GravityOrchestratorApi.isApiReady();
        if (!isApiReady) {
            logger.info('[AutoAddAccount] App API not ready, skipping auto-add');
            return;
        }

        // Check if app has current account
        const currentAccountResponse = await GravityOrchestratorApi.getCurrentAccount();
        if (currentAccountResponse.account) {
            logger.info('[AutoAddAccount] App already has current account, skipping auto-add');
            return;
        }

        // Check if IDE has a logged-in account
        if (!hasAntigravityDb()) {
            logger.info('[AutoAddAccount] No Antigravity database found, skipping auto-add');
            return;
        }

        const refreshToken = await extractRefreshTokenFromAntigravity();
        if (!refreshToken) {
            logger.info('[AutoAddAccount] No refresh token found in IDE, skipping auto-add');
            return;
        }

        logger.info('[AutoAddAccount] Found refresh token in IDE, adding to app...');

        // Add account to app using the refresh token
        const addResponse = await GravityOrchestratorApi.addAccount(refreshToken);
        if (addResponse.success) {
            logger.info('[AutoAddAccount] Successfully added account to app');

            // Wait a bit for account to be fully added
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Refresh quota for all accounts in app
            try {
                logger.info('[AutoAddAccount] Refreshing quota for all accounts...');
                const refreshResponse = await GravityOrchestratorApi.refreshAllQuotas();
                if (refreshResponse.success) {
                    logger.info('[AutoAddAccount] Successfully refreshed quota');
                } else {
                    logger.warn('[AutoAddAccount] Quota refresh returned success=false');
                }
            } catch (error) {
                logger.error('[AutoAddAccount] Failed to refresh quota:', error);
            }

            // Status bar will be automatically updated via quotaService.onQuotaUpdate callback
            logger.info('[AutoAddAccount] Account added, status bar will update automatically');
        } else {
            logger.warn('[AutoAddAccount] Failed to add account to app');
        }
    } catch (error) {
        logger.error('[AutoAddAccount] Error during auto-add:', error);
    }
}

async function initializeGoogleApiMethod(
    context: vscode.ExtensionContext,
    config: Config,
    localizationService: LocalizationService,
    statusBarService: StatusBarService,
    googleAuthService: GoogleAuthService
): Promise<void> {
    logger.info('[Extension] Initializing GOOGLE_API method (no port detection needed)');
    statusBarService.showInitializing();

    quotaService = new QuotaService();
    quotaService.setApiMethod(QuotaApiMethod.GOOGLE_API);

    registerQuotaServiceCallbacks();

    const authState = googleAuthService.getAuthState();
    if (authState.state === AuthState.NOT_AUTHENTICATED) {
        if (hasAntigravityDb()) {
            logger.info('[Extension] Detected local Antigravity installation, checking for stored token...');
            const refreshToken = await extractRefreshTokenFromAntigravity();

            if (refreshToken) {
                logger.info('[Extension] Found local Antigravity token, prompting user...');

                statusBarService.showNotLoggedIn();
                statusBarService.show();
                startLocalTokenCheckTimer();
                logger.info('[Extension] Pre-set status to not logged in before showing prompt');

                const useLocalToken = localizationService.t('notify.useLocalToken');
                const manualLogin = localizationService.t('notify.manualLogin');
                const selection = await vscode.window.showInformationMessage(
                    localizationService.t('notify.localTokenDetected'),
                    useLocalToken,
                    manualLogin
                );

                if (selection === useLocalToken) {
                    logger.info('[Extension] User selected to use local token');
                    stopLocalTokenCheckTimer();
                    statusBarService.showLoggingIn();
                    const success = await googleAuthService.loginWithRefreshToken(refreshToken);
                    if (success) {
                        if (config.enabled && quotaService) {
                            logger.info('[Extension] GOOGLE_API: Starting quota polling after local token login...');
                            statusBarService.showFetching();
                            quotaService.startPolling(config.pollingInterval);
                        }
                        statusBarService.show();
                    } else {
                        logger.info('[Extension] Local token login failed, reverting to not logged in');
                        statusBarService.showNotLoggedIn();
                        statusBarService.show();
                        startLocalTokenCheckTimer();
                    }
                } else if (selection === manualLogin) {
                    logger.info('[Extension] User selected manual login');
                } else {
                    logger.info('[Extension] User dismissed the prompt (selection: undefined)');
                }
                
                return;
            }
        }

        statusBarService.showNotLoggedIn();
        statusBarService.show();
        startLocalTokenCheckTimer();
    } else if (authState.state === AuthState.TOKEN_EXPIRED) {
        statusBarService.showLoginExpired();
        statusBarService.show();
        startLocalTokenCheckTimer();

    } else if (config.enabled) {
        logger.info('[Extension] GOOGLE_API: Starting quota polling...');
        statusBarService.showFetching();
        quotaService.startPolling(config.pollingInterval);

        statusBarService.show();
    }
}


function startLocalTokenCheckTimer(): void {
    if (localTokenCheckTimer) {
        logger.info('[LocalTokenCheck] Timer already running');
        return;
    }

    const config = configService?.getConfig();
    if (config?.apiMethod !== 'GOOGLE_API') {
        return;
    }

    logger.info('[LocalTokenCheck] Starting local token check timer');
    const tokenSyncChecker = TokenSyncChecker.getInstance();

    localTokenCheckTimer = setInterval(async () => {
        logger.info('[LocalTokenCheck] Checking for local token...');
        await tokenSyncChecker.checkLocalTokenWhenNotLoggedIn(
            () => {
                logger.info('[LocalTokenCheck] Local token login successful');
                stopLocalTokenCheckTimer();
                const currentConfig = configService?.getConfig();
                if (currentConfig?.enabled && quotaService) {
                    statusBarService?.showFetching();
                    quotaService.startPolling(currentConfig.pollingInterval);
                }
            }
        );
    }, LOCAL_TOKEN_CHECK_INTERVAL_MS);
}

function stopLocalTokenCheckTimer(): void {
    if (localTokenCheckTimer) {
        logger.info('[LocalTokenCheck] Stopping local token check timer');
        clearInterval(localTokenCheckTimer);
        localTokenCheckTimer = undefined;
    }
}

function registerQuotaServiceCallbacks(): void {
    if (!quotaService || !statusBarService) {
        return;
    }

    quotaService.onQuotaUpdate((snapshot: QuotaSnapshot) => {
        lastQuotaSnapshot = snapshot;
        // Update status bar from app API instead of quota service, but provide snapshot as fallback
        statusBarService?.updateDisplayFromApp(snapshot);
        // Update sidebar
        sidebarProvider?.update(snapshot);

        const apiMethod = quotaService?.getApiMethod();
        if (apiMethod === QuotaApiMethod.GOOGLE_API) {
            const tokenSyncChecker = TokenSyncChecker.getInstance();
            tokenSyncChecker.checkAndHandle(
                () => {
                    quotaService?.quickRefresh();
                },
                () => {
                    quotaService?.stopPolling();
                    statusBarService?.clearStale();
                    statusBarService?.showNotLoggedIn();
                    startLocalTokenCheckTimer();
                },
                () => {
                    stopLocalTokenCheckTimer();
                    const config = configService?.getConfig();
                    if (config?.enabled) {
                        quotaService?.startPolling(config.pollingInterval);
                    }
                }
            );
        }
    });

    quotaService.onError((error: Error) => {
        logger.error('Quota fetch failed:', error);
        statusBarService?.showError(`Connection failed: ${error.message}`);


    });

    quotaService.onStatus((status: 'fetching' | 'retrying', retryCount?: number) => {
        if (status === 'fetching') {
            statusBarService?.showFetching();
        } else if (status === 'retrying' && retryCount !== undefined) {
            statusBarService?.showRetrying(retryCount, 3);
        }
    });

    quotaService.onAuthStatus((needsLogin: boolean, isExpired: boolean) => {
        if (needsLogin) {
            if (isExpired) {
                statusBarService?.showLoginExpired();
            } else {
                statusBarService?.showNotLoggedIn();
            }

            startLocalTokenCheckTimer();
        } else {
            stopLocalTokenCheckTimer();
        }
    });

    quotaService.onStaleStatus((isStale: boolean) => {
        if (isStale) {
            statusBarService?.showStale();
        } else {
            statusBarService?.clearStale();
        }
    });
}

function handleConfigChange(config: Config): void {
    if (configChangeTimer) {
        clearTimeout(configChangeTimer);
    }

    configChangeTimer = setTimeout(async () => {
        logger.info('Config updated (debounced)', config);

        const newApiMethod = getApiMethodFromConfig(config.apiMethod);
        const localizationService = LocalizationService.getInstance();

        if (quotaService) {
            quotaService.setApiMethod(newApiMethod);

            if (newApiMethod === QuotaApiMethod.GOOGLE_API && googleAuthService) {
                const authState = googleAuthService.getAuthState();
                if (authState.state === AuthState.NOT_AUTHENTICATED) {
                    quotaService.stopPolling();
                    if (hasAntigravityDb()) {
                        logger.info('[ConfigChange] Detected local Antigravity installation, checking for stored token...');
                        const refreshToken = await extractRefreshTokenFromAntigravity();

                        if (refreshToken) {
                            logger.info('[ConfigChange] Found local Antigravity token, prompting user...');
                            const useLocalToken = localizationService.t('notify.useLocalToken');
                            const manualLogin = localizationService.t('notify.manualLogin');
                            const selection = await vscode.window.showInformationMessage(
                                localizationService.t('notify.localTokenDetected'),
                                useLocalToken,
                                manualLogin
                            );

                            if (selection === useLocalToken) {
                                statusBarService?.showLoggingIn();
                                const success = await googleAuthService.loginWithRefreshToken(refreshToken);
                                if (success) {
                                    const userEmail = googleAuthService.getUserEmail();
                                    if (userEmail) {
                                        await syncAccountToApp(userEmail);
                                    }

                                    if (config.enabled) {
                                        quotaService.startPolling(config.pollingInterval);
                                    }
                                    statusBarService?.show();
                                    vscode.window.showInformationMessage(localizationService.t('notify.configUpdated'));
                                    return;
                                }
                            }

                        }
                    }

                    statusBarService?.showNotLoggedIn();
                    statusBarService?.show();
                    vscode.window.showInformationMessage(localizationService.t('notify.configUpdated'));
                    return;
                } else if (authState.state === AuthState.TOKEN_EXPIRED) {
                    quotaService.stopPolling();
                    statusBarService?.showLoginExpired();
                    statusBarService?.show();
                    vscode.window.showInformationMessage(localizationService.t('notify.configUpdated'));
                    return;
                }
            }


        }

        if (config.enabled) {
            quotaService?.startPolling(config.pollingInterval);
            statusBarService?.show();
        } else {
            quotaService?.stopPolling();
            statusBarService?.hide();
        }

        vscode.window.showInformationMessage(localizationService.t('notify.configUpdated'));
    }, 300);
}

/**
 * Helper to sync an account and its token to the Gravity Orchestrator app
 */
async function syncAccountToApp(email: string): Promise<boolean> {
    try {
        const { GravityOrchestratorApi } = await import('./api/gravityOrchestratorApi');
        const isApiReady = await GravityOrchestratorApi.isApiReady();

        if (!isApiReady) {
            logger.info('[SyncAccount] App API not ready, skipping sync');
            return false;
        }

        const googleAuthService = GoogleAuthService.getInstance();
        const refreshToken = await googleAuthService.getRefreshTokenForAccount(email);

        if (!refreshToken) {
            logger.warn('[SyncAccount] No refresh token found for account:', email);
            return false;
        }

        logger.info('[SyncAccount] Syncing account to app:', email);
        const addAccountResponse = await GravityOrchestratorApi.addAccount(refreshToken);

        if (addAccountResponse.success) {
            logger.info('[SyncAccount] Successfully added/updated account in app');

            // Refresh quota for all accounts in app
            try {
                await GravityOrchestratorApi.refreshAllQuotas();
                logger.info('[SyncAccount] Successfully refreshed quotas in app');
            } catch (error) {
                logger.error('[SyncAccount] Failed to refresh quotas:', error);
            }
            return true;
        } else {
            logger.warn('[SyncAccount] App returned failure:', addAccountResponse.message);
            return false;
        }
    } catch (error) {
        logger.error('[SyncAccount] Error syncing account to app:', error);
        return false;
    }
}

export function deactivate() {
    logger.info('Gravity Orchestrator deactivated');
    stopLocalTokenCheckTimer();
    quotaService?.dispose();
    statusBarService?.dispose();
}



function getApiMethodFromConfig(_apiMethod: string): QuotaApiMethod {
    // Always return GOOGLE_API since we no longer support GET_USER_STATUS
    return QuotaApiMethod.GOOGLE_API;
}
