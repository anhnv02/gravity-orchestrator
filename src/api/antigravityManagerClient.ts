import * as http from 'http';
import { logger } from '../utils/logger';

export interface ProjectInfo {
    projectId: string;
    tier: string;
}

export interface ModelQuotaFromApi {
    modelName: string;
    displayName: string;
    remainingQuota: number;
    resetTime: string;
    isExhausted: boolean;
}

export interface ModelsQuotaResponse {
    models: ModelQuotaFromApi[];
}

export interface AccountResponse {
    id: string;
    email: string;
    name: string | null;
    is_current: boolean;
    disabled: boolean;
    quota: QuotaResponse | null;
    device_bound: boolean;
    last_used: number;
}

export interface QuotaResponse {
    models: ModelQuota[];
    updated_at: number | null;
    subscription_tier: string | null;
}

export interface ModelQuota {
    name: string;
    percentage: number;
    reset_time: string;
}

export interface AccountListResponse {
    accounts: AccountResponse[];
    current_account_id: string | null;
}

export interface CurrentAccountResponse {
    account: AccountResponse | null;
}

export class AntigravityManagerError extends Error {
    constructor(
        message: string,
        public statusCode: number,
        public errorCode?: string
    ) {
        super(message);
        this.name = 'AntigravityManagerError';
    }

    public isRetryable(): boolean {
        return this.statusCode >= 500 || this.statusCode === 429;
    }

    public needsReauth(): boolean {
        return this.statusCode === 401;
    }
}

export class AntigravityManagerClient {
    private static instance: AntigravityManagerClient;
    private baseUrl: string;
    private port: number;

    private constructor(port: number = 19527) {
        this.port = port;
        this.baseUrl = `http://127.0.0.1:${port}`;
    }

    public static getInstance(port?: number): AntigravityManagerClient {
        if (!AntigravityManagerClient.instance) {
            AntigravityManagerClient.instance = new AntigravityManagerClient(port);
        }
        return AntigravityManagerClient.instance;
    }

    public setPort(port: number): void {
        this.port = port;
        this.baseUrl = `http://127.0.0.1:${port}`;
    }

    /**
     * Check if the API server is available
     */
    public async healthCheck(): Promise<boolean> {
        try {
            const response = await this.makeRequest<{ status: string; version: string }>('GET', '/health');
            return response.status === 'ok';
        } catch (error) {
            logger.warn('[AntigravityManager] Health check failed:', error);
            return false;
        }
    }

    /**
     * Get current account with quota information
     */
    public async getCurrentAccount(): Promise<CurrentAccountResponse> {
        logger.info('[AntigravityManager] Getting current account...');
        return await this.makeRequest<CurrentAccountResponse>('GET', '/accounts/current');
    }

    /**
     * Get all accounts with quota information
     */
    public async getAllAccounts(): Promise<AccountListResponse> {
        logger.info('[AntigravityManager] Getting all accounts...');
        return await this.makeRequest<AccountListResponse>('GET', '/accounts');
    }

    /**
     * Add a new account using refresh token
     */
    public async addAccount(refreshToken: string): Promise<void> {
        logger.info('[AntigravityManager] Adding new account...');
        await this.makeRequest('POST', '/accounts/add', { refresh_token: refreshToken });
    }

    /**
     * Switch to a different account
     */
    public async switchAccount(accountId: string): Promise<void> {
        logger.info(`[AntigravityManager] Switching to account: ${accountId}`);
        await this.makeRequest('POST', '/accounts/switch', { account_id: accountId });
    }

    /**
     * Refresh all account quotas
     */
    public async refreshAllQuotas(): Promise<void> {
        logger.info('[AntigravityManager] Refreshing all quotas...');
        await this.makeRequest('POST', '/accounts/refresh');
    }

    /**
     * Load project info from current account
     * This maps the current account's quota data to ProjectInfo format
     */
    public async loadProjectInfo(): Promise<ProjectInfo> {
        logger.info('[AntigravityManager] Loading project info...');
        const currentAccount = await this.getCurrentAccount();
        
        if (!currentAccount.account) {
            throw new AntigravityManagerError('No current account found', 404);
        }

        const tier = currentAccount.account.quota?.subscription_tier || 'FREE';
        const projectId = currentAccount.account.id; // Use account ID as project identifier

        return {
            projectId,
            tier,
        };
    }

    /**
     * Fetch models quota from current account
     */
    public async fetchModelsQuota(): Promise<ModelsQuotaResponse> {
        logger.info('[AntigravityManager] Fetching models quota...');
        const currentAccount = await this.getCurrentAccount();

        if (!currentAccount.account || !currentAccount.account.quota) {
            logger.warn('[AntigravityManager] No quota data available');
            return { models: [] };
        }

        const quota = currentAccount.account.quota;
        const models: ModelQuotaFromApi[] = quota.models
            .filter((model) => {
                // Filter out Gemini versions < 3.0 (to match IDE dropdown behavior)
                if (this.isGeminiModel(model.name) && !this.isGeminiVersionSupported(model.name)) {
                    logger.info(`[AntigravityManager] Model "${model.name}" filtered out (Gemini version < 3.0)`);
                    return false;
                }

                // Filter out image models (to match IDE dropdown behavior)
                if (model.name.toLowerCase().includes('image')) {
                    logger.info(`[AntigravityManager] Model "${model.name}" filtered out (Image model)`);
                    return false;
                }

                return true;
            })
            .map((model) => {
                const remainingQuota = model.percentage / 100; // Convert percentage to fraction
                const resetTime = new Date(model.reset_time);
                const now = new Date();
                const isExhausted = remainingQuota <= 0 || resetTime <= now;

                return {
                    modelName: model.name,
                    displayName: this.formatModelDisplayName(model.name),
                    remainingQuota,
                    resetTime: model.reset_time,
                    isExhausted,
                };
            });

        logger.info(`[AntigravityManager] Found ${models.length} models with quota (after filtering)`);
        return { models };
    }

    /**
     * Check if a model name is a Gemini model
     */
    private isGeminiModel(modelName: string): boolean {
        return modelName.toLowerCase().includes('gemini');
    }

    /**
     * Check if Gemini model version is supported (>= 3.0)
     * This matches the filter used in Google Cloud Code API
     */
    private isGeminiVersionSupported(modelName: string): boolean {
        const lowerName = modelName.toLowerCase();

        if (!lowerName.includes('gemini')) {
            return true; // Not a Gemini model, so it's "supported"
        }

        // Match patterns like "gemini-2.5", "gemini-3", "gemini-3.0", etc.
        const versionMatch = lowerName.match(/gemini-(\d+(?:\.\d+)?)/);

        if (versionMatch && versionMatch[1]) {
            const version = parseFloat(versionMatch[1]);
            return version >= 3.0;
        }

        // If we can't parse version, assume it's supported (e.g., "gemini-pro", "gemini-flash")
        return true;
    }

    private formatModelDisplayName(modelName: string): string {
        const fixedModelName = modelName.replace(/(\d+)-(\d+)/g, '$1.$2');
        return fixedModelName
            .split('-')
            .map(part => {
                if (/^\d/.test(part)) {
                    return part;
                }
                return part.charAt(0).toUpperCase() + part.slice(1);
            })
            .join(' ');
    }

    private async makeRequest<T = any>(
        method: string,
        path: string,
        body?: object
    ): Promise<T> {
        return new Promise((resolve, reject) => {
            const url = new URL(this.baseUrl + path);
            const postData = body ? JSON.stringify(body) : undefined;

            logger.info(`[AntigravityManager] ${method} ${url.pathname}`);

            const headers: http.OutgoingHttpHeaders = {
                'Content-Type': 'application/json',
            };

            if (postData) {
                headers['Content-Length'] = Buffer.byteLength(postData);
            }

            const options: http.RequestOptions = {
                hostname: url.hostname,
                port: url.port || this.port,
                path: url.pathname,
                method: method,
                timeout: 10000,
                headers: headers,
            };

            const req = http.request(options, (res) => {
                let data = '';
                logger.info(`[AntigravityManager] Response status: ${res.statusCode}`);

                res.on('data', (chunk) => {
                    data += chunk;
                });

                res.on('end', () => {
                    logger.info(`[AntigravityManager] Response body length: ${data.length} bytes`);

                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            const response = data ? JSON.parse(data) : {};
                            logger.info('[AntigravityManager] Request successful');
                            resolve(response as T);
                        } catch (e) {
                            logger.error('[AntigravityManager] Failed to parse JSON response');
                            reject(new Error(`Failed to parse API response: ${data}`));
                        }
                    } else {
                        let errorMessage = `API request failed with status ${res.statusCode}`;
                        let errorCode: string | undefined;

                        try {
                            const errorResponse = JSON.parse(data);
                            errorMessage = errorResponse.error?.message || errorResponse.message || errorMessage;
                            errorCode = errorResponse.error?.code || errorResponse.code;
                            logger.error(`[AntigravityManager] Error response:`, JSON.stringify(errorResponse));
                        } catch {
                            logger.error(`[AntigravityManager] Raw error response: ${data}`);
                        }

                        reject(new AntigravityManagerError(
                            errorMessage,
                            res.statusCode || 500,
                            errorCode
                        ));
                    }
                });
            });

            req.on('error', (e) => {
                logger.error(`[AntigravityManager] Network error: ${e.message}`);
                if (e.message.includes('ECONNREFUSED')) {
                    reject(new AntigravityManagerError(
                        `Cannot connect to Antigravity-Manager API at ${this.baseUrl}. Make sure Antigravity-Manager is running.`,
                        503,
                        'ECONNREFUSED'
                    ));
                } else {
                    reject(new Error(`Network error: ${e.message}`));
                }
            });

            req.on('timeout', () => {
                logger.error(`[AntigravityManager] Request timeout after 10000ms`);
                req.destroy();
                reject(new Error('Request timeout'));
            });

            if (postData) {
                req.write(postData);
            }
            req.end();
        });
    }
}
