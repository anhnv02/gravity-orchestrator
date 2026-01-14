import * as vscode from 'vscode';
import { QuotaService, QuotaApiMethod } from './quotaService';
import { StatusBarService } from './statusBar';
import { ConfigService } from './configService';
import { PortDetectionService, PortDetectionResult } from './portDetectionService';
import { Config, QuotaSnapshot } from './types';
import { LocalizationService } from './i18n/localizationService';
import { versionInfo } from './versionInfo';
import { registerDevCommands } from './devTools';
import { GoogleAuthService, AuthState, AuthStateInfo, extractRefreshTokenFromAntigravity, hasAntigravityDb, TokenSyncChecker } from './auth';
import { ControlPanel } from './controlPanel';
import { clearAccountUsageCache, getMultiAccountInfo, AccountInfo } from './utils/accountUtils';
import { logger } from './utils/logger';


const NON_AG_PROMPT_KEY = 'nonAgSwitchPromptDismissed';

let quotaService: QuotaService | undefined;
let statusBarService: StatusBarService | undefined;
let configService: ConfigService | undefined;
let portDetectionService: PortDetectionService | undefined;
let googleAuthService: GoogleAuthService | undefined;
let lastQuotaSnapshot: QuotaSnapshot | undefined;
let configChangeTimer: NodeJS.Timeout | undefined;
let localTokenCheckTimer: NodeJS.Timeout | undefined;
let lastFocusRefreshTime: number = 0;
let globalState: vscode.Memento | undefined;
const FOCUS_REFRESH_THROTTLE_MS = 3000;
const AUTO_REDETECT_THROTTLE_MS = 30000;
const LOCAL_TOKEN_CHECK_INTERVAL_MS = 30000;
let lastAutoRedetectTime: number = 0;
let isSwitchingAccount: boolean = false;

export async function activate(context: vscode.ExtensionContext) {
  logger.initialize(context);
  versionInfo.initialize(context);
  logger.info(`=== Gravity Orchestrator v${versionInfo.getExtensionVersion()} ===`);
  logger.info(`Running on: ${versionInfo.getIdeName()} v${versionInfo.getIdeVersion()}`);
  globalState = context.globalState;

  configService = new ConfigService();
  let config = configService.getConfig();

  const localizationService = LocalizationService.getInstance();

  const isAntigravityIde = versionInfo.isAntigravityIde();

  statusBarService = new StatusBarService();

  googleAuthService = GoogleAuthService.getInstance();
  await googleAuthService.initialize(context);

  const apiMethod = getApiMethodFromConfig(config.apiMethod);

  const suppressNonAgPrompt = globalState?.get<boolean>(NON_AG_PROMPT_KEY, false);
  if (!isAntigravityIde && apiMethod === QuotaApiMethod.GET_USER_STATUS && !suppressNonAgPrompt) {
    const switchLabel = localizationService.t('notify.switchToGoogleApi');
    const keepLabel = localizationService.t('notify.keepLocalApi');
    const neverLabel = localizationService.t('notify.neverShowAgain');
    const selection = await vscode.window.showInformationMessage(
      localizationService.t('notify.nonAntigravityDetected'),
      switchLabel,
      keepLabel,
      neverLabel
    );

    if (selection === switchLabel) {
      await vscode.workspace.getConfiguration('gravityOrchestrator').update('apiMethod', 'GOOGLE_API', true);
      config = configService.getConfig();
    } else if (selection === neverLabel) {
      await globalState?.update(NON_AG_PROMPT_KEY, true);
    }
  }

  const resolvedApiMethod = getApiMethodFromConfig(config.apiMethod);

  if (resolvedApiMethod === QuotaApiMethod.GOOGLE_API) {
    await initializeGoogleApiMethod(context, config, localizationService);
  } else {
    await initializeLocalApiMethod(context, config, localizationService);
  }

  const showControlPanelCommand = vscode.commands.registerCommand(
    'gravity-orchestrator.showControlPanel',
    () => {
      ControlPanel.createOrShow(context.extensionUri);
      if (lastQuotaSnapshot) {
        ControlPanel.update(lastQuotaSnapshot);
      }
    }
  );

  const quickRefreshQuotaCommand = vscode.commands.registerCommand(
    'gravity-orchestrator.quickRefreshQuota',
    async () => {
      logger.info('[Extension] quickRefreshQuota command invoked');
      if (!quotaService) {
        config = configService!.getConfig();
        const currentApiMethod = getApiMethodFromConfig(config.apiMethod);

        if (currentApiMethod === QuotaApiMethod.GOOGLE_API) {
          logger.info('[Extension] quotaService not initialized in GOOGLE_API mode, prompt login');
          vscode.window.showInformationMessage(
            localizationService.t('notify.pleaseLoginFirst')
          );
        } else {
          logger.info('[Extension] quotaService not initialized, delegating to detectPort command');
          await vscode.commands.executeCommand('gravity-orchestrator.detectPort');
        }
        return;
      }

      logger.info('User triggered quick quota refresh');

      statusBarService?.showQuickRefreshing();

      await quotaService.quickRefresh();
    }
  );

  const refreshQuotaCommand = vscode.commands.registerCommand(
    'gravity-orchestrator.refreshQuota',
    async () => {
      logger.info('[Extension] refreshQuota command invoked');
      if (!quotaService) {
        config = configService!.getConfig();
        const currentApiMethod = getApiMethodFromConfig(config.apiMethod);

        if (currentApiMethod === QuotaApiMethod.GOOGLE_API) {
          logger.info('[Extension] quotaService not initialized in GOOGLE_API mode, prompt login');
          vscode.window.showInformationMessage(
            localizationService.t('notify.pleaseLoginFirst')
          );
        } else {
          logger.info('[Extension] quotaService not initialized, delegating to detectPort command');
          await vscode.commands.executeCommand('gravity-orchestrator.detectPort');
        }
        return;
      }

      vscode.window.showInformationMessage(localizationService.t('notify.refreshingQuota'));
      config = configService!.getConfig();
      statusBarService?.showFetching();

      if (config.enabled) {
        quotaService.setApiMethod(getApiMethodFromConfig(config.apiMethod));

        await quotaService.retryFromError(config.pollingInterval);
      }
    }
  );

  const detectPortCommand = vscode.commands.registerCommand(
    'gravity-orchestrator.detectPort',
    async () => {
      logger.info('[Extension] detectPort command invoked');

      config = configService!.getConfig();
      const currentApiMethod = getApiMethodFromConfig(config.apiMethod);

      if (currentApiMethod === QuotaApiMethod.GOOGLE_API) {
        logger.info('[Extension] detectPort: GOOGLE_API method does not need port detection');
        vscode.window.showInformationMessage(
          localizationService.t('notify.googleApiNoPortDetection')
        );
        return;
      }

      if (!portDetectionService) {
        portDetectionService = new PortDetectionService(context);
      }

      statusBarService?.showDetecting();

      try {
        logger.info('[Extension] detectPort: invoking portDetectionService');
        const result = await portDetectionService?.detectPort();

        if (result && result.port && result.csrfToken) {
          logger.info('[Extension] detectPort command succeeded:', result);

          if (!quotaService) {
            quotaService = new QuotaService(result.port, result.csrfToken, result.httpPort);
            quotaService.setPorts(result.connectPort, result.httpPort);

            quotaService.onQuotaUpdate((snapshot: QuotaSnapshot) => {
              lastQuotaSnapshot = snapshot;
              statusBarService?.updateDisplay(snapshot);
              ControlPanel.update(snapshot);
            });

            quotaService.onError((error: Error) => {
              logger.error('Quota fetch failed:', error);
              statusBarService?.showError(`Connection failed: ${error.message}`);
            });

            quotaService.onAuthStatus((needsLogin: boolean, isExpired: boolean) => {
              if (needsLogin) {
                if (isExpired) {
                  statusBarService?.showLoginExpired();
                } else {
                  statusBarService?.showNotLoggedIn();
                }
              }
            });

          } else {
            quotaService.setPorts(result.connectPort, result.httpPort);
            quotaService.setAuthInfo(undefined, result.csrfToken);
            logger.info('[Extension] detectPort: updated existing QuotaService ports');
          }

          statusBarService?.clearError();

          quotaService.stopPolling();
          quotaService.setApiMethod(getApiMethodFromConfig(config.apiMethod));
          quotaService.startPolling(config.pollingInterval);

          vscode.window.showInformationMessage(localizationService.t('notify.detectionSuccess', { port: result.port }));
        } else {
          logger.warn('[Extension] detectPort command did not return valid ports');
          vscode.window.showErrorMessage(
            localizationService.t('notify.unableToDetectPort') + '\n' +
            localizationService.t('notify.unableToDetectPortHint1') + '\n' +
            localizationService.t('notify.unableToDetectPortHint2')
          );
        }
      } catch (error: any) {
        const errorMsg = error?.message || String(error);
        logger.error('Port detection failed:', errorMsg);
        if (error?.stack) {
          logger.error('Stack:', error.stack);
        }
        vscode.window.showErrorMessage(localizationService.t('notify.portDetectionFailed', { error: errorMsg }));
      }
    }
  );

  const configChangeDisposable = configService.onConfigChange((newConfig) => {
    handleConfigChange(newConfig as Config);
  });

  const windowFocusDisposable = vscode.window.onDidChangeWindowState((e) => {
    if (!e.focused) {
      return;
    }

    const currentConfig = configService?.getConfig();
    if (!currentConfig?.enabled) {
      return;
    }

    if (getApiMethodFromConfig(currentConfig.apiMethod) === QuotaApiMethod.GOOGLE_API) {
      logger.info('[FocusRefresh] GOOGLE_API mode, skip focus-triggered refresh');
      return;
    }

    if (!quotaService) {
      logger.info('[FocusRefresh] quotaService not initialized, skipping');
      return;
    }

    const now = Date.now();
    if (now - lastFocusRefreshTime < FOCUS_REFRESH_THROTTLE_MS) {
      logger.info('[FocusRefresh] Throttled, skipping refresh');
      return;
    }
    lastFocusRefreshTime = now;

    logger.info('[FocusRefresh] Window focused, triggering quota refresh');
    quotaService.quickRefresh();
  });

  const googleLoginCommand = vscode.commands.registerCommand(
    'gravity-orchestrator.googleLogin',
    async () => {
      logger.info('[Extension] googleLogin command invoked');
      if (!googleAuthService) {
        vscode.window.showErrorMessage(localizationService.t('login.error.serviceNotInitialized'));
        return;
      }

      statusBarService?.showLoggingIn();
      const success = await googleAuthService.login();
      if (success) {
        config = configService!.getConfig();
        if (config.apiMethod === 'GOOGLE_API' && quotaService) {
          if (config.enabled) {
            await quotaService.startPolling(config.pollingInterval);
          }
          await quotaService.quickRefresh();
        }
      } else {
        statusBarService?.showNotLoggedIn();
      }
    }
  );

  const googleLogoutCommand = vscode.commands.registerCommand(
    'gravity-orchestrator.googleLogout',
    async () => {
      logger.info('[Extension] googleLogout command invoked');
      if (!googleAuthService) {
        return;
      }

      const wasLoggedIn = await googleAuthService.logout();
      if (wasLoggedIn) {
        vscode.window.showInformationMessage(localizationService.t('logout.success'));
      }

      config = configService!.getConfig();
      if (config.apiMethod === 'GOOGLE_API') {
        lastQuotaSnapshot = undefined;
        clearAccountUsageCache();
        quotaService?.stopPolling();
        statusBarService?.clearStale();
        statusBarService?.showNotLoggedIn();
        ControlPanel.update(undefined);
      }

    }
  );

  const showAccountsCommand = vscode.commands.registerCommand(
    'gravity-orchestrator.showAccounts',
    () => {
      ControlPanel.createOrShow(context.extensionUri, 'account');
      if (lastQuotaSnapshot) {
        ControlPanel.update(lastQuotaSnapshot);
      }
    }
  );

  const googleAddAccountCommand = vscode.commands.registerCommand(
    'gravity-orchestrator.googleAddAccount',
    async () => {
      logger.info('[Extension] googleAddAccount command invoked');
      if (!googleAuthService) {
        vscode.window.showErrorMessage(localizationService.t('login.error.serviceNotInitialized'));
        return;
      }

      statusBarService?.showLoggingIn();
      const success = await googleAuthService.addAccount();
      if (success) {
        config = configService!.getConfig();
        if (config.apiMethod === 'GOOGLE_API' && quotaService) {
          if (config.enabled) {
            await quotaService.startPolling(config.pollingInterval);
          }
          await quotaService.quickRefresh();
        }
      } else {
        statusBarService?.showNotLoggedIn();
      }
    }
  );

  const googleSwitchAccountCommand = vscode.commands.registerCommand(
    'gravity-orchestrator.googleSwitchAccount',
    async (email: string) => {
      logger.info('[Extension] googleSwitchAccount command invoked for:', email);
      if (!googleAuthService) {
        vscode.window.showErrorMessage(localizationService.t('login.error.serviceNotInitialized'));
        return;
      }

      config = configService!.getConfig();
      
      // Check quota before switching
      try {
        const multiAccountInfo = await getMultiAccountInfo();
        const targetAccount = multiAccountInfo.accounts.find((a: AccountInfo) => a.email === email);
        
        if (targetAccount && targetAccount.usagePercentage !== undefined) {
          const remaining = 100 - targetAccount.usagePercentage;
          if (remaining <= config.switchThreshold) {
            vscode.window.showErrorMessage(
              localizationService.t('notify.lowQuotaError', { 
                email: email, 
                remaining: remaining.toFixed(1),
                threshold: config.switchThreshold
              })
            );
            logger.info(`[Extension] Manual switch blocked: Account ${email} quota (${remaining.toFixed(1)}%) is below threshold (${config.switchThreshold}%)`);
            return;
          }
        }
      } catch (e) {
        logger.warn('[Extension] Failed to check quota before switching:', e);
      }

      const success = await googleAuthService.switchAccount(email);
      if (success) {
        lastQuotaSnapshot = undefined;
        clearAccountUsageCache();
        statusBarService?.showFetching();
        ControlPanel.update(undefined);

        config = configService!.getConfig();
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
    async (email: string) => {
      logger.info('[Extension] googleLogoutAccount command invoked for:', email);
      if (!googleAuthService) {
        return;
      }

      const wasLoggedIn = await googleAuthService.logoutAccount(email);
      if (wasLoggedIn) {
        vscode.window.showInformationMessage(`Removed account: ${email}`);
      }

      config = configService!.getConfig();
      const activeAccount = await googleAuthService.getActiveAccount();
      if (config.apiMethod === 'GOOGLE_API') {
        if (!activeAccount) {
          lastQuotaSnapshot = undefined;
          clearAccountUsageCache();
          quotaService?.stopPolling();
          statusBarService?.clearStale();
          statusBarService?.showNotLoggedIn();
          ControlPanel.update(undefined);
        } else {
          // Refresh with new active account
          lastQuotaSnapshot = undefined;
          clearAccountUsageCache();
          if (config.enabled && quotaService) {
            await quotaService.startPolling(config.pollingInterval);
            await quotaService.quickRefresh();
          }
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
        ControlPanel.update(lastQuotaSnapshot);
        break;
      case AuthState.NOT_AUTHENTICATED:
        quotaService?.stopPolling();
        statusBarService?.clearStale();
        statusBarService?.showNotLoggedIn();
        startLocalTokenCheckTimer();
        ControlPanel.update(lastQuotaSnapshot);
        break;
      case AuthState.TOKEN_EXPIRED:
        quotaService?.stopPolling();
        statusBarService?.clearStale();
        statusBarService?.showLoginExpired();
        startLocalTokenCheckTimer();
        ControlPanel.update(lastQuotaSnapshot);
        break;
      case AuthState.AUTHENTICATING:
        statusBarService?.showLoggingIn();
        ControlPanel.update(lastQuotaSnapshot);
        break;
      case AuthState.ERROR:
        statusBarService?.showError(localizationService.t('login.error.authFailed'));
        ControlPanel.update(lastQuotaSnapshot);
        break;
    }
  });

  context.subscriptions.push(
    showControlPanelCommand,
    quickRefreshQuotaCommand,
    refreshQuotaCommand,
    detectPortCommand,
    googleLoginCommand,
    googleLogoutCommand,
    googleAddAccountCommand,
    googleSwitchAccountCommand,
    googleLogoutAccountCommand,
    showAccountsCommand,
    configChangeDisposable,
    windowFocusDisposable,
    authStateDisposable,
    { dispose: () => quotaService?.dispose() },
    { dispose: () => statusBarService?.dispose() }
  );

  registerDevCommands(context);

  logger.info('Gravity Orchestrator initialized');
}

async function initializeGoogleApiMethod(
  context: vscode.ExtensionContext,
  config: Config,
  localizationService: LocalizationService
): Promise<void> {
  logger.info('[Extension] Initializing GOOGLE_API method (no port detection needed)');
  statusBarService!.showInitializing();

  quotaService = new QuotaService(0, undefined, undefined);
  quotaService.setApiMethod(QuotaApiMethod.GOOGLE_API);

  registerQuotaServiceCallbacks();

  const authState = googleAuthService!.getAuthState();
  if (authState.state === AuthState.NOT_AUTHENTICATED) {
    if (hasAntigravityDb()) {
      logger.info('[Extension] Detected local Antigravity installation, checking for stored token...');
      const refreshToken = await extractRefreshTokenFromAntigravity();

      if (refreshToken) {
        logger.info('[Extension] Found local Antigravity token, prompting user...');

        statusBarService!.showNotLoggedIn();
        statusBarService!.show();
        startLocalTokenCheckTimer();
        logger.info('[Extension] Pre-set status to not logged in before showing prompt');

        const useLocalToken = localizationService.t('notify.useLocalToken');
        const manualLogin = localizationService.t('notify.manualLogin');
        vscode.window.showInformationMessage(
          localizationService.t('notify.localTokenDetected'),
          useLocalToken,
          manualLogin
        ).then(async (selection) => {
          if (selection === useLocalToken) {
            logger.info('[Extension] User selected to use local token');
            stopLocalTokenCheckTimer();
            statusBarService!.showLoggingIn();
            const success = await googleAuthService!.loginWithRefreshToken(refreshToken);
            if (success) {
              if (config.enabled) {
                logger.info('[Extension] GOOGLE_API: Starting quota polling after local token login...');
                statusBarService!.showFetching();
                quotaService!.startPolling(config.pollingInterval);
              }
              statusBarService!.show();
            } else {
              logger.info('[Extension] Local token login failed, reverting to not logged in');
              statusBarService!.showNotLoggedIn();
              statusBarService!.show();
              startLocalTokenCheckTimer();
            }
          } else if (selection === manualLogin) {
            logger.info('[Extension] User selected manual login');
          } else {
            logger.info('[Extension] User dismissed the prompt (selection: undefined)');
          }
        });

        return;
      }
    }

    statusBarService!.showNotLoggedIn();
    statusBarService!.show();
    startLocalTokenCheckTimer();
  } else if (authState.state === AuthState.TOKEN_EXPIRED) {
    statusBarService!.showLoginExpired();
    statusBarService!.show();
    startLocalTokenCheckTimer();
  } else if (config.enabled) {
    logger.info('[Extension] GOOGLE_API: Starting quota polling...');
    statusBarService!.showFetching();
    quotaService.startPolling(config.pollingInterval);
    statusBarService!.show();
  }
}

async function initializeLocalApiMethod(
  context: vscode.ExtensionContext,
  config: Config,
  localizationService: LocalizationService
): Promise<void> {
  logger.info('[Extension] Initializing local API method (port detection required)');

  portDetectionService = new PortDetectionService(context);

  statusBarService!.showDetecting();

  let detectedPort: number | null = null;
  let detectedCsrfToken: string | null = null;
  let detectionResult: PortDetectionResult | null = null;

  try {
    logger.info('[Extension] Starting initial port detection');
    const result = await portDetectionService.detectPort();
    if (result) {
      detectionResult = result;
      detectedPort = result.port;
      detectedCsrfToken = result.csrfToken;
      logger.info('[Extension] Initial port detection success:', detectionResult);
    }
  } catch (error) {
    logger.error('❌ Port/CSRF detection failed', error);
    if (error instanceof Error && error.stack) {
      logger.error('Stack:', error.stack);
    }
  }

  if (!detectedPort || !detectedCsrfToken) {
    logger.error('Missing port or CSRF Token, extension cannot start');
    logger.error('Please ensure Antigravity language server is running');
    statusBarService!.showError('Port/CSRF Detection failed, Please try restart.');
    statusBarService!.show();

    vscode.window.showWarningMessage(
      localizationService.t('notify.unableToDetectProcess'),
      localizationService.t('notify.retry'),
      localizationService.t('notify.cancel')
    ).then(action => {
      if (action === localizationService.t('notify.retry')) {
        vscode.commands.executeCommand('gravity-orchestrator.detectPort');
      }
    });
  } else {
    statusBarService!.showInitializing();
    quotaService = new QuotaService(detectedPort, undefined, detectionResult?.httpPort);
    quotaService.setPorts(detectionResult?.connectPort ?? detectedPort, detectionResult?.httpPort);
    quotaService.setApiMethod(getApiMethodFromConfig(config.apiMethod));

    registerQuotaServiceCallbacks();

    if (config.enabled) {
      logger.info('Starting quota polling after delay...');
      statusBarService!.showFetching();

      setTimeout(() => {
        quotaService?.setAuthInfo(undefined, detectedCsrfToken);
        quotaService?.startPolling(config.pollingInterval);
      }, 8000);

      statusBarService!.show();
    }
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



async function checkAndAutoSwitchAccount(snapshot: QuotaSnapshot) {
  if (!configService || isSwitchingAccount) {
    return;
  }

  const config = configService.getConfig();
  if (!config.autoSwitchAccount) {
    return;
  }

  // Determine current remaining percentage
  let currentPercentage: number | undefined;

  if (snapshot.promptCredits) {
    currentPercentage = snapshot.promptCredits.remainingPercentage;
  } else if (snapshot.models && snapshot.models.length > 0) {
    // Use minimum percentage from models that have a quota
    const percentages = snapshot.models
      .map(m => m.remainingPercentage)
      .filter((p): p is number => p !== undefined);
    
    if (percentages.length > 0) {
      currentPercentage = Math.min(...percentages);
    }
  }

  if (currentPercentage === undefined) {
    return;
  }

  if (currentPercentage <= config.switchThreshold) {
    logger.info(`[AutoSwitch] Quota low (${currentPercentage.toFixed(1)}% <= ${config.switchThreshold}%). Attempting to switch account...`);
    
    if (!googleAuthService) {
      return;
    }

    const multiAccountInfo = await getMultiAccountInfo();
    const activeAccount = await googleAuthService.getActiveAccount();
    
    if (multiAccountInfo.accounts.length <= 1) {
      logger.info('[AutoSwitch] Only one account available, cannot switch.');
      return;
    }

    // Find all accounts that are NOT expired and have quota ABOVE the threshold
    const validAccounts = multiAccountInfo.accounts.filter(acc => {
      if (acc.isExpired) return false;
      const remaining = acc.usagePercentage !== undefined ? 100 - acc.usagePercentage : 100;
      return remaining > config.switchThreshold;
    });

    if (validAccounts.length === 0) {
      logger.warn('[AutoSwitch] All available accounts have low quota. Stopping automatic switch.');
      vscode.window.showErrorMessage(
        LocalizationService.getInstance().t('notify.allAccountsLowQuota', { threshold: config.switchThreshold })
      );
      return;
    }

    // Find the next available valid account (circular)
    const activeIndex = activeAccount ? multiAccountInfo.accounts.findIndex(a => a.email === activeAccount) : -1;
    
    // Search for next valid account starting from (activeIndex + 1)
    let nextAccount: AccountInfo | undefined;
    for (let i = 1; i < multiAccountInfo.accounts.length; i++) {
        const idx = (activeIndex + i) % multiAccountInfo.accounts.length;
        const candidate = multiAccountInfo.accounts[idx];
        if (validAccounts.some(v => v.email === candidate.email)) {
            nextAccount = candidate;
            break;
        }
    }

    if (nextAccount && nextAccount.email !== activeAccount) {
      isSwitchingAccount = true;
      try {
        const nextEmail = nextAccount.email;
        logger.info(`[AutoSwitch] Switching from ${activeAccount} to ${nextEmail}`);
        const success = await googleAuthService.switchAccount(nextEmail);
        if (success) {
          lastQuotaSnapshot = undefined;
          clearAccountUsageCache();
          statusBarService?.showFetching();
          ControlPanel.update(undefined);

          vscode.window.showInformationMessage(`Auto-switched to account: ${nextEmail} (Current account quota was low: ${currentPercentage.toFixed(1)}%)`);
          
          if (quotaService) {
            await quotaService.quickRefresh();
          }
        }
      } catch (error) {
        logger.error('[AutoSwitch] Failed to switch account:', error);
      } finally {
        // Cooldown before allowing another switch
        setTimeout(() => {
          isSwitchingAccount = false;
        }, 60000); // 1 minute cooldown for auto-switch
      }
    }
  }
}

function registerQuotaServiceCallbacks(): void {
  if (!quotaService || !statusBarService) {
    return;
  }

  quotaService.onQuotaUpdate((snapshot: QuotaSnapshot) => {
    lastQuotaSnapshot = snapshot;
    statusBarService?.updateDisplay(snapshot);
    ControlPanel.update(snapshot);
    checkAndAutoSwitchAccount(snapshot);

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

    const apiMethod = quotaService?.getApiMethod();
    if (shouldAutoRedetectPort(error, apiMethod)) {
      const now = Date.now();
      if (now - lastAutoRedetectTime >= AUTO_REDETECT_THROTTLE_MS) {
        lastAutoRedetectTime = now;
        vscode.commands.executeCommand('gravity-orchestrator.detectPort');
      } else {
        logger.info('[AutoRedetect] Throttled; skip detectPort this time');
      }
    }
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
    const isAntigravityIde = versionInfo.isAntigravityIde();
    const suppressNonAgPrompt = globalState?.get<boolean>(NON_AG_PROMPT_KEY, false);

    const currentApiMethod = quotaService?.getApiMethod();
    if (
      !isAntigravityIde &&
      newApiMethod === QuotaApiMethod.GET_USER_STATUS &&
      currentApiMethod !== QuotaApiMethod.GET_USER_STATUS &&
      !suppressNonAgPrompt
    ) {
      const switchLabel = localizationService.t('notify.switchToGoogleApi');
      const keepLabel = localizationService.t('notify.keepLocalApi');
      const neverLabel = localizationService.t('notify.neverShowAgain');
      const selection = await vscode.window.showInformationMessage(
        localizationService.t('notify.nonAntigravityDetected'),
        switchLabel,
        keepLabel,
        neverLabel
      );

      if (selection === switchLabel) {
        await vscode.workspace.getConfiguration('gravityOrchestrator').update('apiMethod', 'GOOGLE_API', true);
        return;
      } else if (selection === neverLabel) {
        await globalState?.update(NON_AG_PROMPT_KEY, true);
      }
    }

    if (quotaService) {
      const currentApiMethod = quotaService.getApiMethod();
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

      if (currentApiMethod === QuotaApiMethod.GOOGLE_API && newApiMethod !== QuotaApiMethod.GOOGLE_API) {
        logger.info('[ConfigChange] Switching from GOOGLE_API to local API, need port detection');
        quotaService.stopPolling();
        statusBarService?.showDetecting();

        (async () => {
          try {
            if (!portDetectionService) {
              await vscode.commands.executeCommand('gravity-orchestrator.detectPort');
              return;
            }

            const result = await portDetectionService.detectPort();
            if (result && result.port && result.csrfToken) {
              logger.info('[ConfigChange] Port detection success:', result);
              quotaService!.setPorts(result.connectPort, result.httpPort);
              quotaService!.setAuthInfo(undefined, result.csrfToken);
              statusBarService?.clearError();

              if (config.enabled) {
                quotaService!.startPolling(config.pollingInterval);
              }
              vscode.window.showInformationMessage(localizationService.t('notify.configUpdated'));
            } else {
              logger.warn('[ConfigChange] Port detection failed, no valid result');
              statusBarService?.showError('Port/CSRF Detection failed');
              vscode.window.showWarningMessage(
                localizationService.t('notify.unableToDetectPort'),
                localizationService.t('notify.retry')
              ).then(action => {
                if (action === localizationService.t('notify.retry')) {
                  vscode.commands.executeCommand('gravity-orchestrator.detectPort');
                }
              });
            }
          } catch (error: any) {
            logger.error('[ConfigChange] Port detection error:', error);
            statusBarService?.showError(`Detection failed: ${error.message}`);
          }
        })();
        return;
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

export function deactivate() {
  logger.info('Gravity Orchestrator deactivated');
  stopLocalTokenCheckTimer();
  quotaService?.dispose();
  statusBarService?.dispose();
}

function shouldAutoRedetectPort(error: Error, apiMethod: QuotaApiMethod | undefined): boolean {
  if (!apiMethod || apiMethod === QuotaApiMethod.GOOGLE_API) {
    return false;
  }

  const msg = (error?.message || '').toLowerCase();
  if (!msg) {
    return false;
  }

  return (
    error.name === 'QuotaInvalidCodeError' ||
    msg.includes('missing csrf') ||
    msg.includes('csrf token') ||
    msg.includes('connection refused') ||
    msg.includes('econnrefused') ||
    msg.includes('socket') ||
    msg.includes('port') ||
    (msg.includes('http error') && msg.includes('403')) ||
    msg.includes('invalid response code')
  );
}

function getApiMethodFromConfig(apiMethod: string): QuotaApiMethod {
  switch (apiMethod) {
    case 'GOOGLE_API':
      return QuotaApiMethod.GOOGLE_API;
    case 'GET_USER_STATUS':
    default:
      return QuotaApiMethod.GET_USER_STATUS;
  }
}
