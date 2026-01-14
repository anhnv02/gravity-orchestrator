import * as vscode from 'vscode';
import { GoogleAuthService } from './googleAuthService';
import { extractRefreshTokenFromAntigravity, hasAntigravityDb } from './antigravityTokenExtractor';
import { TokenStorage } from './tokenStorage';
import { LocalizationService } from '../i18n/localizationService';
import { logger } from '../utils/logger';

export enum TokenSyncStatus {

    SKIP = 'skip',

    IN_SYNC = 'in_sync',

    TOKEN_CHANGED = 'token_changed',

    TOKEN_REMOVED = 'token_removed',

    LOCAL_TOKEN_AVAILABLE = 'local_token_available',

    ERROR = 'error',
}

export class TokenSyncChecker {
    private static instance: TokenSyncChecker;
    private lastCheckTime: number = 0;
    private lastPromptTime: number = 0;
    private lastNotLoggedInCheckTime: number = 0;
    private isPromptShowing: boolean = false;

    private readonly CHECK_INTERVAL_MS = 30 * 1000;

    private readonly NOT_LOGGED_IN_CHECK_INTERVAL_MS = 20 * 1000;

    private readonly PROMPT_COOLDOWN_MS = 5 * 60 * 1000;

    private constructor() {}

    public static getInstance(): TokenSyncChecker {
        if (!TokenSyncChecker.instance) {
            TokenSyncChecker.instance = new TokenSyncChecker();
        }
        return TokenSyncChecker.instance;
    }

    public async checkSync(): Promise<TokenSyncStatus> {
        const tokenStorage = TokenStorage.getInstance();

        const hasToken = await tokenStorage.hasToken();

        if (!hasToken) {

            if (hasAntigravityDb()) {
                try {
                    const localToken = await extractRefreshTokenFromAntigravity();
                    if (localToken) {
                        logger.info('[TokenSyncChecker] Not logged in but local token available');
                        return TokenSyncStatus.LOCAL_TOKEN_AVAILABLE;
                    }
                } catch (e) {
                    logger.info('[TokenSyncChecker] Error checking local token:', e);
                }
            }
            return TokenSyncStatus.SKIP;
        }

        const source = await tokenStorage.getTokenSource();
        if (source !== 'imported') {
            return TokenSyncStatus.SKIP;
        }

        if (!hasAntigravityDb()) {

            logger.info('[TokenSyncChecker] Antigravity database not found');
            return TokenSyncStatus.TOKEN_REMOVED;
        }

        try {

            const currentRefreshToken = await tokenStorage.getRefreshToken();
            if (!currentRefreshToken) {
                return TokenSyncStatus.ERROR;
            }

            const localRefreshToken = await extractRefreshTokenFromAntigravity();

            if (!localRefreshToken) {

                logger.info('[TokenSyncChecker] Local Antigravity token removed');
                return TokenSyncStatus.TOKEN_REMOVED;
            }

            if (localRefreshToken !== currentRefreshToken) {

                logger.info('[TokenSyncChecker] Local Antigravity token changed');
                return TokenSyncStatus.TOKEN_CHANGED;
            }

            return TokenSyncStatus.IN_SYNC;
        } catch (e) {
            logger.error('[TokenSyncChecker] Check failed:', e);
            return TokenSyncStatus.ERROR;
        }
    }

    public async checkAndHandle(
        onTokenChanged?: () => void,
        onLogout?: () => void,
        onLocalTokenLogin?: () => void
    ): Promise<boolean> {
        const now = Date.now();

        if (this.isPromptShowing) {
            return false;
        }

        const status = await this.checkSync();

        if (status === TokenSyncStatus.LOCAL_TOKEN_AVAILABLE) {
            if (now - this.lastNotLoggedInCheckTime < this.NOT_LOGGED_IN_CHECK_INTERVAL_MS) {
                return false;
            }
            this.lastNotLoggedInCheckTime = now;

            if (now - this.lastPromptTime < this.PROMPT_COOLDOWN_MS) {
                logger.info('[TokenSyncChecker] Prompt cooldown for local token, skipping');
                return true;
            }

            await this.showLocalTokenPrompt(onLocalTokenLogin);
            return true;
        }

        if (now - this.lastCheckTime < this.CHECK_INTERVAL_MS) {
            return false;
        }
        this.lastCheckTime = now;

        if (status === TokenSyncStatus.SKIP || status === TokenSyncStatus.IN_SYNC) {
            return true;
        }

        if (status === TokenSyncStatus.ERROR) {
            logger.warn('[TokenSyncChecker] Check returned error, skipping prompt');
            return true;
        }

        if (now - this.lastPromptTime < this.PROMPT_COOLDOWN_MS) {
            logger.info('[TokenSyncChecker] Prompt cooldown, skipping');
            return true;
        }

        await this.showSyncPrompt(status, onTokenChanged, onLogout);
        return true;
    }

    public async checkLocalTokenWhenNotLoggedIn(
        onLocalTokenLogin?: () => void
    ): Promise<boolean> {
        const now = Date.now();

        if (this.isPromptShowing) {
            return false;
        }

        if (now - this.lastNotLoggedInCheckTime < this.NOT_LOGGED_IN_CHECK_INTERVAL_MS) {
            return false;
        }
        this.lastNotLoggedInCheckTime = now;

        if (!hasAntigravityDb()) {
            return true;
        }

        try {
            const localToken = await extractRefreshTokenFromAntigravity();
            if (!localToken) {
                return true;
            }

            logger.info('[TokenSyncChecker] Local token detected while not logged in');

            if (now - this.lastPromptTime < this.PROMPT_COOLDOWN_MS) {
                logger.info('[TokenSyncChecker] Prompt cooldown for local token, skipping');
                return true;
            }

            await this.showLocalTokenPrompt(onLocalTokenLogin);
            return true;
        } catch (e) {
            logger.info('[TokenSyncChecker] Error checking local token:', e);
            return true;
        }
    }

    private async showLocalTokenPrompt(
        onLocalTokenLogin?: () => void
    ): Promise<void> {
        this.isPromptShowing = true;
        const localizationService = LocalizationService.getInstance();
        const googleAuthService = GoogleAuthService.getInstance();

        try {
            const useLocalToken = localizationService.t('notify.useLocalToken') || 'Use local token to login';
            const manualLogin = localizationService.t('notify.manualLogin') || 'Manual login';

            const selection = await vscode.window.showInformationMessage(
                localizationService.t('notify.localTokenDetected') || 'Detected local Antigravity login. Use this account?',
                useLocalToken,
                manualLogin
            );

            if (selection === useLocalToken) {
                const refreshToken = await extractRefreshTokenFromAntigravity();
                if (refreshToken) {
                    const success = await googleAuthService.loginWithRefreshToken(refreshToken);
                    if (success && onLocalTokenLogin) {
                        onLocalTokenLogin();
                    }
                }
            } else if (selection === manualLogin) {

                vscode.commands.executeCommand('gravity-orchestrator.googleLogin');
            }

        } finally {
            this.isPromptShowing = false;
            this.lastPromptTime = Date.now();
        }
    }

    private async showSyncPrompt(
        status: TokenSyncStatus,
        onTokenChanged?: () => void,
        onLogout?: () => void
    ): Promise<void> {
        this.isPromptShowing = true;
        const localizationService = LocalizationService.getInstance();
        const googleAuthService = GoogleAuthService.getInstance();

        try {
            if (status === TokenSyncStatus.TOKEN_CHANGED) {

                const syncLabel = localizationService.t('notify.syncToken') || 'Sync';
                const keepLabel = localizationService.t('notify.keepCurrentToken') || 'Keep current';

                const selection = await vscode.window.showInformationMessage(
                    localizationService.t('notify.tokenChanged') || 'Antigravity account changed. Sync now?',
                    { modal: true },
                    syncLabel,
                    keepLabel
                );

                if (selection === syncLabel) {

                    const newToken = await extractRefreshTokenFromAntigravity();
                    if (newToken) {
                        const success = await googleAuthService.loginWithRefreshToken(newToken);
                        if (success && onTokenChanged) {
                            onTokenChanged();
                        }
                    }
                } else if (selection === keepLabel) {

                    await googleAuthService.convertToManualSource();
                }

            } else if (status === TokenSyncStatus.TOKEN_REMOVED) {

                const syncLogoutLabel = localizationService.t('notify.syncLogout') || 'Sync logout';
                const keepLoginLabel = localizationService.t('notify.keepLogin') || 'Keep login';

                const selection = await vscode.window.showInformationMessage(
                    localizationService.t('notify.tokenRemoved') || 'Antigravity logged out. Sync logout?',
                    { modal: true },
                    syncLogoutLabel,
                    keepLoginLabel
                );

                if (selection === syncLogoutLabel) {

                    const wasLoggedIn = await googleAuthService.logout();
                    if (wasLoggedIn) {
                        vscode.window.showInformationMessage(localizationService.t('logout.success'));
                    }
                    if (onLogout) {
                        onLogout();
                    }
                } else if (selection === keepLoginLabel) {

                    await googleAuthService.convertToManualSource();
                }

            }
        } finally {
            this.isPromptShowing = false;
            this.lastPromptTime = Date.now();
        }
    }

    public reset(): void {
        this.lastCheckTime = 0;
        this.lastPromptTime = 0;
        this.lastNotLoggedInCheckTime = 0;
        this.isPromptShowing = false;
    }
}
