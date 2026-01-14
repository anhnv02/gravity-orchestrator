import * as vscode from 'vscode';
import { TOKEN_STORAGE_KEY } from './constants';
import { logger } from '../utils/logger';

export type TokenSource = 'manual' | 'imported';

export interface TokenData {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    tokenType: string;
    scope: string;
    source?: TokenSource;
    email?: string; // Add email to token data
}

interface AccountsData {
    accounts: { [email: string]: TokenData };
    activeAccount: string | null;
}

export class TokenStorage {
    private static instance: TokenStorage;
    private secretStorage: vscode.SecretStorage | null = null;
    private globalState: vscode.Memento | null = null;

    private constructor() { }

    public static getInstance(): TokenStorage {
        if (!TokenStorage.instance) {
            TokenStorage.instance = new TokenStorage();
        }
        return TokenStorage.instance;
    }

    public initialize(context: vscode.ExtensionContext): void {
        this.secretStorage = context.secrets;
        this.globalState = context.globalState;
        // Migrate old single token to multi-account format (fire and forget)
        this.migrateOldToken().catch(e => {
            logger.error('[TokenStorage] Migration failed:', e);
        });
    }

    private async migrateOldToken(): Promise<void> {
        if (!this.secretStorage) return;
        
        try {
            const oldTokenJson = await this.secretStorage.get(TOKEN_STORAGE_KEY);
            if (oldTokenJson) {
                const oldToken = JSON.parse(oldTokenJson) as TokenData;
                // Check if we already have accounts data
                const accountsData = await this.getAccountsData();
                if (!accountsData || Object.keys(accountsData.accounts).length === 0) {
                    // Migrate old token to new format
                    if (oldToken.email) {
                        await this.saveTokenForAccount(oldToken.email, oldToken);
                        await this.setActiveAccount(oldToken.email);
                    } else {
                        // Try to get email from user info or use a placeholder
                        const email = 'migrated@account.local';
                        await this.saveTokenForAccount(email, oldToken);
                        await this.setActiveAccount(email);
                    }
                    // Clear old token
                    await this.secretStorage.delete(TOKEN_STORAGE_KEY);
                    logger.info('[TokenStorage] Migrated old token to multi-account format');
                }
            }
        } catch (e) {
            logger.error('[TokenStorage] Migration error:', e);
        }
    }

    private async getAccountsData(): Promise<AccountsData> {
        if (!this.globalState) {
            throw new Error('TokenStorage not initialized. Call initialize() first.');
        }
        
        const data = this.globalState.get<AccountsData>('gravity-orchestrator.accounts', {
            accounts: {},
            activeAccount: null
        });
        return data;
    }

    private async saveAccountsData(data: AccountsData): Promise<void> {
        if (!this.globalState) {
            throw new Error('TokenStorage not initialized. Call initialize() first.');
        }
        await this.globalState.update('gravity-orchestrator.accounts', data);
    }

    private ensureInitialized(): void {
        if (!this.secretStorage || !this.globalState) {
            throw new Error('TokenStorage not initialized. Call initialize() first.');
        }
    }

    public async saveToken(token: TokenData): Promise<void> {
        // For backward compatibility, also save to old location if no email
        if (!token.email) {
            this.ensureInitialized();
            const tokenJson = JSON.stringify(token);
            await this.secretStorage!.store(TOKEN_STORAGE_KEY, tokenJson);
            return;
        }
        await this.saveTokenForAccount(token.email, token);
    }

    public async saveTokenForAccount(email: string, token: TokenData): Promise<void> {
        this.ensureInitialized();
        const accountsData = await this.getAccountsData();
        token.email = email;
        
        // Check if account already exists
        const existingToken = accountsData.accounts[email];
        if (existingToken) {
            // Manual login always replaces imported token
            if (existingToken.source === 'imported' && token.source === 'manual') {
                logger.info(`[TokenStorage] Replacing imported token with manual login for account: ${email}`);
            } 
            // If existing is manual and new is imported, keep manual (don't replace with imported)
            else if (existingToken.source === 'manual' && token.source === 'imported') {
                logger.info(`[TokenStorage] Keeping existing manual token, ignoring imported token for account: ${email}`);
                return;
            } 
            // Same source, update token (refresh or new login)
            else {
                logger.info(`[TokenStorage] Updating existing ${existingToken.source} token for account: ${email}`);
            }
        }
        
        // Store token in secret storage with email as key (this will overwrite existing token)
        const tokenKey = `${TOKEN_STORAGE_KEY}.${email}`;
        const tokenJson = JSON.stringify(token);
        await this.secretStorage!.store(tokenKey, tokenJson);
        
        // Update accounts data (this will overwrite existing token)
        accountsData.accounts[email] = token;
        if (!accountsData.activeAccount) {
            accountsData.activeAccount = email;
        }
        await this.saveAccountsData(accountsData);
    }

    public async getToken(): Promise<TokenData | null> {
        const activeEmail = await this.getActiveAccount();
        if (!activeEmail) {
            // Try old format for backward compatibility
            if (!this.secretStorage) {
                return null;
            }
            const tokenJson = await this.secretStorage.get(TOKEN_STORAGE_KEY);
            if (!tokenJson) {
                return null;
            }
            try {
                return JSON.parse(tokenJson) as TokenData;
            } catch (e) {
                logger.error('[TokenStorage] Failed to parse stored token:', e);
                return null;
            }
        }
        return await this.getTokenForAccount(activeEmail);
    }

    public async getTokenForAccount(email: string): Promise<TokenData | null> {
        this.ensureInitialized();
        const tokenKey = `${TOKEN_STORAGE_KEY}.${email}`;
        const tokenJson = await this.secretStorage!.get(tokenKey);
        if (!tokenJson) {
            return null;
        }
        try {
            return JSON.parse(tokenJson) as TokenData;
        } catch (e) {
            logger.error('[TokenStorage] Failed to parse stored token for account:', email, e);
            return null;
        }
    }

    public async getAllAccounts(): Promise<string[]> {
        const accountsData = await this.getAccountsData();
        // Return unique emails (in case of any duplicates)
        return Array.from(new Set(Object.keys(accountsData.accounts)));
    }

    public async hasAccount(email: string): Promise<boolean> {
        const accountsData = await this.getAccountsData();
        return email in accountsData.accounts;
    }


    public async cleanupDuplicateAccounts(): Promise<number> {
        // Clean up duplicate accounts by email
        // Priority: manual > imported, newer token > older token
        this.ensureInitialized();
        const accountsData = await this.getAccountsData();
        
        // Early return if no accounts
        if (Object.keys(accountsData.accounts).length === 0) {
            return 0;
        }

        const emailMap = new Map<string, { email: string; token: TokenData; key: string }[]>();
        let removedCount = 0;

        // Group accounts by email (normalize email to lowercase for comparison)
        for (const [email, token] of Object.entries(accountsData.accounts)) {
            const normalizedEmail = email.toLowerCase().trim();
            if (!emailMap.has(normalizedEmail)) {
                emailMap.set(normalizedEmail, []);
            }
            emailMap.get(normalizedEmail)!.push({
                email, // Keep original email
                token,
                key: `${TOKEN_STORAGE_KEY}.${email}`
            });
        }

        // Build new accounts object with duplicates removed
        const newAccounts: { [email: string]: TokenData } = {};
        const emailsToRemove: string[] = [];

        // Process each email group
        for (const [normalizedEmail, entries] of emailMap.entries()) {
            if (entries.length <= 1) {
                // No duplicates, keep as is
                entries.forEach(entry => {
                    newAccounts[entry.email] = entry.token;
                });
                continue;
            }

            logger.info(`[TokenStorage] Found ${entries.length} duplicate accounts for email: ${normalizedEmail}`);

            // Sort by priority: manual > imported, then by newer expiresAt
            entries.sort((a, b) => {
                // Manual has higher priority than imported
                if (a.token.source === 'manual' && b.token.source !== 'manual') {
                    return -1;
                }
                if (a.token.source !== 'manual' && b.token.source === 'manual') {
                    return 1;
                }
                // If same source, prefer newer token (higher expiresAt)
                return b.token.expiresAt - a.token.expiresAt;
            });

            // Keep the first one (highest priority), mark the rest for removal
            const keepEntry = entries[0];
            const removeEntries = entries.slice(1);

            // Keep the best entry
            newAccounts[keepEntry.email] = keepEntry.token;

            // Mark duplicates for removal
            removeEntries.forEach(entry => {
                emailsToRemove.push(entry.email);
            });

            // Update active account if it was removed
            if (accountsData.activeAccount && 
                removeEntries.some(e => e.email === accountsData.activeAccount)) {
                accountsData.activeAccount = keepEntry.email;
                logger.info(`[TokenStorage] Updated active account to: ${keepEntry.email}`);
            }
        }

        // Remove duplicate tokens from secret storage (parallel deletion)
        const deletePromises = emailsToRemove.map(async (email) => {
            try {
                const tokenKey = `${TOKEN_STORAGE_KEY}.${email}`;
                await this.secretStorage!.delete(tokenKey);
                logger.info(`[TokenStorage] Removed duplicate account: ${email}`);
                return true;
            } catch (e) {
                logger.error(`[TokenStorage] Failed to remove duplicate account ${email}:`, e);
                return false;
            }
        });
        
        const deleteResults = await Promise.all(deletePromises);
        removedCount = deleteResults.filter(r => r).length;

        // Update accounts data
        if (removedCount > 0) {
            accountsData.accounts = newAccounts;
            await this.saveAccountsData(accountsData);
            logger.info(`[TokenStorage] Cleanup completed. Removed ${removedCount} duplicate account(s)`);
        }

        return removedCount;
    }

    public async getActiveAccount(): Promise<string | null> {
        const accountsData = await this.getAccountsData();
        return accountsData.activeAccount;
    }

    public async setActiveAccount(email: string | null): Promise<void> {
        const accountsData = await this.getAccountsData();
        accountsData.activeAccount = email;
        await this.saveAccountsData(accountsData);
    }

    public async clearToken(): Promise<void> {
        const activeEmail = await this.getActiveAccount();
        if (activeEmail) {
            await this.clearTokenForAccount(activeEmail);
        } else {
            // Clear old format for backward compatibility
            this.ensureInitialized();
            await this.secretStorage!.delete(TOKEN_STORAGE_KEY);
        }
    }

    public async clearTokenForAccount(email: string): Promise<void> {
        this.ensureInitialized();
        const tokenKey = `${TOKEN_STORAGE_KEY}.${email}`;
        await this.secretStorage!.delete(tokenKey);
        
        const accountsData = await this.getAccountsData();
        delete accountsData.accounts[email];
        if (accountsData.activeAccount === email) {
            // Set another account as active, or null if none
            const remainingAccounts = Object.keys(accountsData.accounts);
            accountsData.activeAccount = remainingAccounts.length > 0 ? remainingAccounts[0] : null;
        }
        await this.saveAccountsData(accountsData);
    }

    public async hasToken(): Promise<boolean> {
        const token = await this.getToken();
        return token !== null;
    }

    public async hasTokenForAccount(email: string): Promise<boolean> {
        const token = await this.getTokenForAccount(email);
        return token !== null;
    }

    public async isTokenExpired(bufferMs: number = 5 * 60 * 1000): Promise<boolean> {
        const token = await this.getToken();
        if (!token) {
            return true;
        }
        return Date.now() + bufferMs >= token.expiresAt;
    }

    public async isTokenExpiredForAccount(email: string, bufferMs: number = 5 * 60 * 1000): Promise<boolean> {
        const token = await this.getTokenForAccount(email);
        if (!token) {
            return true;
        }
        return Date.now() + bufferMs >= token.expiresAt;
    }

    public async getAccessTokenForAccount(email: string): Promise<string | null> {
        const token = await this.getTokenForAccount(email);
        if (!token) {
            return null;
        }

        if (await this.isTokenExpiredForAccount(email)) {
            return null;
        }
        return token.accessToken;
    }

    public async getAccessToken(): Promise<string | null> {
        const activeEmail = await this.getActiveAccount();
        if (!activeEmail) {
            return null;
        }
        return this.getAccessTokenForAccount(activeEmail);
    }

    public async getRefreshToken(): Promise<string | null> {
        const token = await this.getToken();
        return token?.refreshToken ?? null;
    }

    public async getRefreshTokenForAccount(email: string): Promise<string | null> {
        const token = await this.getTokenForAccount(email);
        return token?.refreshToken ?? null;
    }

    public async updateAccessToken(accessToken: string, expiresIn: number): Promise<void> {
        const activeEmail = await this.getActiveAccount();
        if (!activeEmail) {
            throw new Error('No active account');
        }
        await this.updateAccessTokenForAccount(activeEmail, accessToken, expiresIn);
    }

    public async updateAccessTokenForAccount(email: string, accessToken: string, expiresIn: number): Promise<void> {
        const token = await this.getTokenForAccount(email);
        if (!token) {
            throw new Error(`No existing token for account: ${email}`);
        }
        token.accessToken = accessToken;
        token.expiresAt = Date.now() + expiresIn * 1000;
        await this.saveTokenForAccount(email, token);
    }

    public async getTokenSource(): Promise<TokenSource> {
        const token = await this.getToken();
        return token?.source ?? 'manual';
    }

    public async getTokenSourceForAccount(email: string): Promise<TokenSource> {
        const token = await this.getTokenForAccount(email);
        return token?.source ?? 'manual';
    }

    public async updateTokenSource(source: TokenSource): Promise<void> {
        const activeEmail = await this.getActiveAccount();
        if (!activeEmail) {
            throw new Error('No active account');
        }
        await this.updateTokenSourceForAccount(activeEmail, source);
    }

    public async updateTokenSourceForAccount(email: string, source: TokenSource): Promise<void> {
        const token = await this.getTokenForAccount(email);
        if (!token) {
            throw new Error(`No existing token for account: ${email}`);
        }
        token.source = source;
        await this.saveTokenForAccount(email, token);
    }
}
