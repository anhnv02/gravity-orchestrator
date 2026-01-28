import * as vscode from 'vscode';
import * as https from 'https';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_AUTH_ENDPOINT,
    GOOGLE_TOKEN_ENDPOINT,
    GOOGLE_SCOPES,
} from './constants';
import { TokenStorage, TokenData } from './tokenStorage';
import { CallbackServer } from './callbackServer';
import { LocalizationService } from '../i18n/localizationService';
import { logger } from '../utils/logger';

export enum AuthState {
    NOT_AUTHENTICATED = 'not_authenticated',
    AUTHENTICATING = 'authenticating',
    AUTHENTICATED = 'authenticated',
    TOKEN_EXPIRED = 'token_expired',
    REFRESHING = 'refreshing',
    ERROR = 'error',
}

export interface AuthStateInfo {
    state: AuthState;
    error?: string;
    email?: string;
}

interface TokenResponse {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    token_type: string;
    scope: string;
}

interface UserInfoResponse {
    id: string;
    email: string;
    verified_email: boolean;
    name?: string;
    picture?: string;
}

export class GoogleAuthService {
    private static instance: GoogleAuthService;
    private tokenStorage: TokenStorage;
    private callbackServer: CallbackServer | null = null;
    private context: vscode.ExtensionContext | null = null;
    private currentState: AuthState = AuthState.NOT_AUTHENTICATED;
    private lastError: string | undefined;
    private userEmail: string | undefined;
    private stateChangeListeners: Set<(state: AuthStateInfo) => void> = new Set();

    private constructor() {
        this.tokenStorage = TokenStorage.getInstance();
    }

    public static getInstance(): GoogleAuthService {
        if (!GoogleAuthService.instance) {
            GoogleAuthService.instance = new GoogleAuthService();
        }
        return GoogleAuthService.instance;
    }

    public async initialize(context: vscode.ExtensionContext): Promise<void> {
        logger.info('[GoogleAuth] Initializing auth service...');
        this.context = context;
        this.tokenStorage.initialize(context);

        const activeEmail = await this.tokenStorage.getActiveAccount();
        logger.info('[GoogleAuth] Active account:', activeEmail);

        if (activeEmail) {
            const hasToken = await this.tokenStorage.hasTokenForAccount(activeEmail);
            logger.info('[GoogleAuth] Has stored token for active account:', hasToken);

            if (hasToken) {
                const isExpired = await this.tokenStorage.isTokenExpiredForAccount(activeEmail);
                logger.info('[GoogleAuth] Token expired:', isExpired);

                if (isExpired) {
                    try {
                        logger.info('[GoogleAuth] Attempting to refresh expired token...');
                        await this.refreshToken();
                        logger.info('[GoogleAuth] Token refreshed successfully');
                    } catch (e) {
                        logger.warn('[GoogleAuth] Token refresh failed during init, will retry later:', e);
                    }
                }

                const token = await this.tokenStorage.getTokenForAccount(activeEmail);
                this.userEmail = token?.email || activeEmail;
                this.setState(AuthState.AUTHENTICATED);
                logger.info('[GoogleAuth] Set state to AUTHENTICATED (has refresh token)');
            } else {
                this.setState(AuthState.NOT_AUTHENTICATED);
                logger.info('[GoogleAuth] No stored token for active account');
            }
        } else {
            // Check for old format token
            const hasToken = await this.tokenStorage.hasToken();
            if (hasToken) {
                const isExpired = await this.tokenStorage.isTokenExpired();
                if (isExpired) {
                    try {
                        logger.info('[GoogleAuth] Attempting to refresh expired token...');
                        await this.refreshToken();
                        logger.info('[GoogleAuth] Token refreshed successfully');
                    } catch (e) {
                        logger.warn('[GoogleAuth] Token refresh failed during init, will retry later:', e);
                    }
                }
                this.setState(AuthState.AUTHENTICATED);
            } else {
                this.setState(AuthState.NOT_AUTHENTICATED);
                logger.info('[GoogleAuth] No stored token, user needs to login');
            }
        }
    }

    public isAuthenticated(): boolean {
        return this.currentState === AuthState.AUTHENTICATED;
    }

    public getAuthState(): AuthStateInfo {
        return {
            state: this.currentState,
            error: this.lastError,
            email: this.userEmail,
        };
    }

    public async login(): Promise<boolean> {
        logger.info('[GoogleAuth] Login initiated, current state:', this.currentState);

        if (this.currentState === AuthState.AUTHENTICATING) {
            logger.info('[GoogleAuth] Already authenticating, skipping');
            return false;
        }

        try {
            this.setState(AuthState.AUTHENTICATING);

            const state = crypto.randomBytes(32).toString('hex');
            logger.info('[GoogleAuth] Generated state for CSRF protection');

            const codeVerifier = crypto.randomBytes(32).toString('base64url');
            const codeChallenge = crypto
                .createHash('sha256')
                .update(codeVerifier)
                .digest('base64url');
            logger.info('[GoogleAuth] Generated PKCE code challenge');

            this.callbackServer = new CallbackServer();

            try {
                if (this.context) {
                    const iconPath = path.join(this.context.extensionPath, 'icon.png');
                    if (fs.existsSync(iconPath)) {
                        const iconBuffer = fs.readFileSync(iconPath);
                        const iconBase64 = `data:image/png;base64,${iconBuffer.toString('base64')}`;
                        this.callbackServer.setIcon(iconBase64);
                        logger.info('[GoogleAuth] Loaded plugin icon for callback page');
                    }
                }
            } catch (iconError) {
                logger.warn('[GoogleAuth] Failed to load icon for callback page:', iconError);
            }

            await this.callbackServer.startServer();

            const redirectUri = this.callbackServer.getRedirectUri();
            logger.info('[GoogleAuth] Callback server started, redirect URI:', redirectUri);

            const authUrl = this.buildAuthUrl(redirectUri, state, codeChallenge);
            logger.info('[GoogleAuth] Opening browser for authorization...');

            const callbackPromise = this.callbackServer.waitForCallback(state);

            await vscode.env.openExternal(vscode.Uri.parse(authUrl));

            logger.info('[GoogleAuth] Waiting for OAuth callback...');
            const result = await callbackPromise;
            logger.info('[GoogleAuth] Received authorization code, exchanging for token...');

            const tokenData = await this.exchangeCodeForToken(
                result.code,
                redirectUri,
                codeVerifier
            );
            logger.info('[GoogleAuth] Token exchange successful, expires at:', new Date(tokenData.expiresAt).toISOString());

            // Fetch user info to get email (required to avoid duplicates)
            let userEmail: string | undefined;
            try {
                const userInfo = await this.fetchUserInfo(tokenData.accessToken);
                userEmail = userInfo.email;
                tokenData.email = userEmail;
                logger.info('[GoogleAuth] User email fetched:', userEmail);
                
                // Check if account already exists
                if (userEmail) {
                    const existingToken = await this.tokenStorage.getTokenForAccount(userEmail);
                    if (existingToken) {
                        const sourceLabel = existingToken.source === 'manual' ? 'manual login' : 'imported token';
                        logger.info(`[GoogleAuth] Account ${userEmail} already exists with ${sourceLabel}. Updating token.`);
                    }
                }
            } catch (e) {
                logger.warn('[GoogleAuth] Failed to fetch user info:', e);
                logger.warn('[GoogleAuth] Proceeding without email - may cause duplicate accounts');
            }

            await this.tokenStorage.saveToken(tokenData);
            if (userEmail) {
                await this.tokenStorage.setActiveAccount(userEmail);
            }
            logger.info('[GoogleAuth] Token saved to secure storage');

            this.userEmail = userEmail;
            this.setState(AuthState.AUTHENTICATED);
            vscode.window.showInformationMessage(LocalizationService.getInstance().t('login.success.google'));
            return true;
        } catch (e) {
            const errorMessage = e instanceof Error ? e.message : String(e);
            logger.error('[GoogleAuth] Login failed:', errorMessage);
            if (e instanceof Error && e.stack) {
                logger.error('[GoogleAuth] Stack:', e.stack);
            }
            this.lastError = errorMessage;
            this.setState(AuthState.ERROR);
            vscode.window.showErrorMessage(LocalizationService.getInstance().t('login.error.google', { error: errorMessage }));
            return false;
        } finally {

            if (this.callbackServer) {
                this.callbackServer.stop();
                this.callbackServer = null;
                logger.info('[GoogleAuth] Callback server stopped');
            }
        }
    }

    public async logout(): Promise<boolean> {
        return await this.logoutAccount(this.userEmail);
    }

    public async logoutAccount(email?: string): Promise<boolean> {
        const wasAuthenticated = this.currentState === AuthState.AUTHENTICATED ||
                                  this.currentState === AuthState.TOKEN_EXPIRED ||
                                  this.currentState === AuthState.REFRESHING;

        if (email) {
            await this.tokenStorage.clearTokenForAccount(email);
            // If logging out active account, switch to another or set to null
            const activeEmail = await this.tokenStorage.getActiveAccount();
            if (activeEmail === email) {
                const accounts = await this.tokenStorage.getAllAccounts();
                const remainingAccounts = accounts.filter(acc => acc !== email);
                if (remainingAccounts.length > 0) {
                    await this.tokenStorage.setActiveAccount(remainingAccounts[0]);
                    const token = await this.tokenStorage.getTokenForAccount(remainingAccounts[0]);
                    this.userEmail = token?.email || remainingAccounts[0];
                    this.setState(AuthState.AUTHENTICATED);
                } else {
                    this.userEmail = undefined;
                    this.lastError = undefined;
                    this.setState(AuthState.NOT_AUTHENTICATED);
                }
            }
        } else {
            await this.tokenStorage.clearToken();
            this.userEmail = undefined;
            this.lastError = undefined;
            this.setState(AuthState.NOT_AUTHENTICATED);
        }

        return wasAuthenticated;
    }

    public async loginWithRefreshToken(refreshToken: string): Promise<boolean> {
        logger.info('[GoogleAuth] Attempting login with imported refresh_token');

        if (this.currentState === AuthState.AUTHENTICATING || this.currentState === AuthState.REFRESHING) {
            logger.info('[GoogleAuth] Already authenticating/refreshing, skipping');
            return false;
        }

        try {
            this.setState(AuthState.REFRESHING);

            const params = new URLSearchParams({
                client_id: GOOGLE_CLIENT_ID,
                client_secret: GOOGLE_CLIENT_SECRET,
                refresh_token: refreshToken,
                grant_type: 'refresh_token',
            });

            logger.info('[GoogleAuth] Sending token refresh request with imported refresh_token...');
            const response = await this.makeTokenRequest(params);
            logger.info('[GoogleAuth] Token refresh response received, expires_in:', response.expires_in);

            // Fetch user info to get email (required to avoid duplicates)
            let userEmail: string | undefined;
            try {
                const userInfo = await this.fetchUserInfo(response.access_token);
                userEmail = userInfo.email;
                logger.info('[GoogleAuth] User email fetched:', userEmail);
            } catch (e) {
                logger.warn('[GoogleAuth] Failed to fetch user info:', e);
                // Cannot import without email to avoid duplicates
                throw new Error('Failed to fetch user email. Cannot import token without email to avoid duplicates.');
            }

            if (!userEmail) {
                throw new Error('User email is required to import token');
            }

            // Check if account already exists
            const existingToken = await this.tokenStorage.getTokenForAccount(userEmail);
            if (existingToken) {
                // If existing token is manual, don't replace with imported
                if (existingToken.source === 'manual') {
                    logger.info(`[GoogleAuth] Account ${userEmail} already exists with manual login. Skipping import.`);
                    vscode.window.showInformationMessage(
                        `Account ${userEmail} already exists with manual login. Import skipped.`
                    );
                    this.userEmail = userEmail;
                    await this.tokenStorage.setActiveAccount(userEmail);
                    this.setState(AuthState.AUTHENTICATED);
                    return true;
                }
                // If existing token is also imported, update it
                logger.info(`[GoogleAuth] Account ${userEmail} already exists with imported token. Updating token.`);
            }

            const tokenData: TokenData = {
                accessToken: response.access_token,
                refreshToken: refreshToken,
                expiresAt: Date.now() + response.expires_in * 1000,
                tokenType: response.token_type,
                scope: response.scope,
                source: 'imported',
                email: userEmail,
            };

            await this.tokenStorage.saveToken(tokenData);
            await this.tokenStorage.setActiveAccount(userEmail);
            logger.info('[GoogleAuth] Token saved to secure storage');

            this.userEmail = userEmail;
            this.setState(AuthState.AUTHENTICATED);
            vscode.window.showInformationMessage(LocalizationService.getInstance().t('login.success.localToken'));
            return true;
        } catch (e) {
            const errorMessage = e instanceof Error ? e.message : String(e);
            logger.error('[GoogleAuth] Login with refresh_token failed:', errorMessage);
            this.lastError = errorMessage;
            this.setState(AuthState.ERROR);
            vscode.window.showErrorMessage(LocalizationService.getInstance().t('login.error.localToken', { error: errorMessage }));
            return false;
        }
    }

    public async convertToManualSource(): Promise<void> {
        try {
            await this.tokenStorage.updateTokenSource('manual');
            logger.info('[GoogleAuth] Token source converted to manual');
        } catch (e) {
            logger.error('[GoogleAuth] Failed to convert token source:', e);
        }
    }

    public async getTokenSource(): Promise<'manual' | 'imported'> {
        return await this.tokenStorage.getTokenSource();
    }

    public async getValidAccessToken(): Promise<string> {
        const activeEmail = await this.tokenStorage.getActiveAccount();
        if (!activeEmail) {
            throw new Error('No active account');
        }
        return this.getValidAccessTokenForAccount(activeEmail);
    }

    public async getValidAccessTokenForAccount(email: string): Promise<string> {
        logger.info(`[GoogleAuth] Getting valid access token for account: ${email}`);
        const token = await this.tokenStorage.getTokenForAccount(email);
        if (!token) {
            logger.info(`[GoogleAuth] No token found for account: ${email}`);
            throw new Error(`Not authenticated for account: ${email}`);
        }

        const isExpired = await this.tokenStorage.isTokenExpiredForAccount(email);
        if (isExpired) {
            logger.info(`[GoogleAuth] Token expired or expiring soon for ${email}, refreshing...`);
            await this.refreshTokenForAccount(email);
        }

        const accessToken = await this.tokenStorage.getAccessTokenForAccount(email);
        if (!accessToken) {
            logger.error(`[GoogleAuth] Failed to get access token for ${email} after refresh`);
            throw new Error('Failed to get access token');
        }
        logger.info(`[GoogleAuth] Access token obtained for ${email}: ${this.maskToken(accessToken)}`);
        return accessToken;
    }

    public onAuthStateChange(callback: (state: AuthStateInfo) => void): vscode.Disposable {
        this.stateChangeListeners.add(callback);
        return {
            dispose: () => {
                this.stateChangeListeners.delete(callback);
            }
        };
    }

    public getUserEmail(): string | undefined {
        return this.userEmail;
    }

    public async getAllAccounts(): Promise<string[]> {
        return await this.tokenStorage.getAllAccounts();
    }

    public async getActiveAccount(): Promise<string | null> {
        return await this.tokenStorage.getActiveAccount();
    }

    public async getRefreshTokenForAccount(email: string): Promise<string | null> {
        return await this.tokenStorage.getRefreshTokenForAccount(email);
    }

    public async switchAccount(email: string): Promise<boolean> {
        logger.info('[GoogleAuth] Switching to account:', email);
        
        // Try to use Antigravity Tools API first
        try {
            const { AntigravityToolsApi } = await import('../api/antigravityToolsApi');
            const isApiReady = await AntigravityToolsApi.isApiReady();
            
            if (isApiReady) {
                logger.info('[GoogleAuth] Using Antigravity Tools API to switch account');
                const accountsResponse = await AntigravityToolsApi.listAccounts();
                
                // Find account by email
                const account = accountsResponse.accounts.find(acc => acc.email === email);
                if (!account) {
                    logger.error('[GoogleAuth] Account not found in Antigravity Tools:', email);
                    return false;
                }
                
                // Switch using API
                const switchResponse = await AntigravityToolsApi.switchAccount(account.id);
                if (switchResponse.success) {
                    logger.info('[GoogleAuth] Account switched successfully via API:', email);
                    // Update local state
                    await this.tokenStorage.setActiveAccount(email);
                    this.userEmail = email;
                    this.setState(AuthState.AUTHENTICATED);
                    return true;
                } else {
                    logger.warn('[GoogleAuth] API switch returned success=false');
                    return false;
                }
            }
        } catch (error) {
            logger.warn('[GoogleAuth] Failed to use Antigravity Tools API, falling back to local switch:', error);
        }
        
        // Fallback to local token storage method
        const hasToken = await this.tokenStorage.hasTokenForAccount(email);
        if (!hasToken) {
            logger.error('[GoogleAuth] Account not found:', email);
            return false;
        }

        await this.tokenStorage.setActiveAccount(email);
        const token = await this.tokenStorage.getTokenForAccount(email);
        this.userEmail = token?.email || email;

        const isExpired = await this.tokenStorage.isTokenExpiredForAccount(email);
        if (isExpired) {
            try {
                logger.info('[GoogleAuth] Token expired, refreshing...');
                await this.refreshToken();
            } catch (e) {
                logger.warn('[GoogleAuth] Token refresh failed:', e);
                this.setState(AuthState.TOKEN_EXPIRED);
                return false;
            }
        }

        this.setState(AuthState.AUTHENTICATED);
        return true;
    }

    public async addAccount(): Promise<boolean> {
        // Same as login but doesn't clear current account
        logger.info('[GoogleAuth] Adding new account...');
        return await this.login();
    }

    public async fetchUserInfo(accessToken: string): Promise<UserInfoResponse> {
        logger.info('[GoogleAuth] Fetching user info...');
        return new Promise((resolve, reject) => {
            const options: https.RequestOptions = {
                hostname: 'www.googleapis.com',
                port: 443,
                path: '/oauth2/v2/userinfo',
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                },
            };

            const req = https.request(options, (res) => {
                let data = '';

                res.on('data', (chunk) => {
                    data += chunk;
                });

                res.on('end', () => {
                    try {
                        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                            const response = JSON.parse(data) as UserInfoResponse;
                            logger.info('[GoogleAuth] User info fetched, email:', response.email);

                            this.userEmail = response.email;
                            resolve(response);
                        } else {
                            reject(new Error(`Failed to fetch user info: ${res.statusCode} - ${data}`));
                        }
                    } catch (e) {
                        reject(new Error(`Failed to parse user info response: ${data}`));
                    }
                });
            });

            req.on('error', (e) => {
                reject(e);
            });

            req.end();
        });
    }

    private async refreshToken(): Promise<void> {
        const activeEmail = await this.tokenStorage.getActiveAccount();
        if (!activeEmail) {
            throw new Error('No active account');
        }
        return this.refreshTokenForAccount(activeEmail);
    }

    private async refreshTokenForAccount(email: string): Promise<void> {
        logger.info(`[GoogleAuth] Refreshing token for account: ${email}`);
        const isActive = (await this.tokenStorage.getActiveAccount()) === email;
        
        if (isActive) {
            this.setState(AuthState.REFRESHING);
        }

        try {
            const refreshToken = await this.tokenStorage.getRefreshTokenForAccount(email);
            if (!refreshToken) {
                logger.error('[GoogleAuth] No refresh token available for account:', email);
                throw new Error('No refresh token available');
            }
            logger.info('[GoogleAuth] Using refresh token:', this.maskToken(refreshToken));

            const params = new URLSearchParams({
                client_id: GOOGLE_CLIENT_ID,
                client_secret: GOOGLE_CLIENT_SECRET,
                refresh_token: refreshToken,
                grant_type: 'refresh_token',
            });

            logger.info('[GoogleAuth] Sending token refresh request to Google...');
            const response = await this.makeTokenRequest(params);
            logger.info('[GoogleAuth] Token refresh response received, expires_in:', response.expires_in);

            await this.tokenStorage.updateAccessTokenForAccount(
                email,
                response.access_token,
                response.expires_in
            );
            logger.info('[GoogleAuth] Access token updated successfully for:', email);

            if (isActive) {
                this.setState(AuthState.AUTHENTICATED);
            }
        } catch (e) {
            const errorMessage = e instanceof Error ? e.message : String(e);
            logger.error(`[GoogleAuth] Token refresh failed for ${email}:`, errorMessage);
            if (isActive) {
                this.lastError = errorMessage;
                this.setState(AuthState.TOKEN_EXPIRED);
            }
            throw e;
        }
    }

    private maskToken(token: string): string {
        if (token.length <= 14) {
            return '***';
        }
        return `${token.substring(0, 6)}***${token.substring(token.length - 4)}`;
    }

    private buildAuthUrl(redirectUri: string, state: string, codeChallenge: string): string {
        const params = new URLSearchParams({
            client_id: GOOGLE_CLIENT_ID,
            redirect_uri: redirectUri,
            response_type: 'code',
            scope: GOOGLE_SCOPES,
            state: state,
            code_challenge: codeChallenge,
            code_challenge_method: 'S256',
            access_type: 'offline',
            prompt: 'consent',
        });

        return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
    }

    private async exchangeCodeForToken(
        code: string,
        redirectUri: string,
        codeVerifier: string
    ): Promise<TokenData> {
        const params = new URLSearchParams({
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,
            code: code,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
            code_verifier: codeVerifier,
        });

        const response = await this.makeTokenRequest(params);

        if (!response.refresh_token) {
            throw new Error('No refresh token in response');
        }

        return {
            accessToken: response.access_token,
            refreshToken: response.refresh_token,
            expiresAt: Date.now() + response.expires_in * 1000,
            tokenType: response.token_type,
            scope: response.scope,
            source: 'manual',
        };
    }

    private makeTokenRequest(params: URLSearchParams): Promise<TokenResponse> {
        return new Promise((resolve, reject) => {
            const postData = params.toString();
            const url = new URL(GOOGLE_TOKEN_ENDPOINT);

            const options: https.RequestOptions = {
                hostname: url.hostname,
                port: 443,
                path: url.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(postData),
                },
            };

            const req = https.request(options, (res) => {
                let data = '';

                res.on('data', (chunk) => {
                    data += chunk;
                });

                res.on('end', () => {
                    try {
                        const response = JSON.parse(data);
                        if (response.error) {
                            reject(new Error(`Token error: ${response.error} - ${response.error_description}`));
                        } else {
                            resolve(response as TokenResponse);
                        }
                    } catch (e) {
                        reject(new Error(`Failed to parse token response: ${data}`));
                    }
                });
            });

            req.on('error', (e) => {
                reject(e);
            });

            req.write(postData);
            req.end();
        });
    }

    private setState(state: AuthState): void {
        const previousState = this.currentState;
        this.currentState = state;
        logger.info(`[GoogleAuth] State changed: ${previousState} -> ${state}`);

        const stateInfo = this.getAuthState();
        this.stateChangeListeners.forEach((listener) => {
            try {
                listener(stateInfo);
            } catch (e) {
                logger.error('[GoogleAuth] Auth state listener error:', e);
            }
        });
    }
}
