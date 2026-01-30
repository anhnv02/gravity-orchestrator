import * as http from 'http';
import { logger } from '../utils/logger';

/**
 * API client for Antigravity Tools HTTP API
 * Default port: 19527
 */
export class GravityOrchestratorApi {
    private static readonly DEFAULT_PORT = 19527;
    private static readonly BASE_URL = 'http://127.0.0.1';
    private static readonly TIMEOUT = 5000;

    /**
     * Check if the API server is ready
     */
    public static async isApiReady(port: number = this.DEFAULT_PORT): Promise<boolean> {
        try {
            const response = await this.makeRequest('GET', '/health', port);
            return response.status === 'ok';
        } catch (error) {
            logger.debug(`[GravityOrchestratorApi] Health check failed on port ${port}:`, error);
            return false;
        }
    }

    /**
     * Get all accounts
     */
    public static async listAccounts(port: number = this.DEFAULT_PORT): Promise<AccountListResponse> {
        return await this.makeRequest('GET', '/accounts', port);
    }

    /**
     * Get the current account
     */
    public static async getCurrentAccount(port: number = this.DEFAULT_PORT): Promise<CurrentAccountResponse> {
        return await this.makeRequest('GET', '/accounts/current', port);
    }

    /**
     * Switch account
     */
    public static async switchAccount(accountId: string, port: number = this.DEFAULT_PORT): Promise<SwitchResponse> {
        return await this.makeRequest('POST', '/accounts/switch', port, {
            account_id: accountId
        });
    }

    /**
     * Add a new account
     */
    public static async addAccount(refreshToken: string, port: number = this.DEFAULT_PORT): Promise<AddAccountResponse> {
        return await this.makeRequest('POST', '/accounts/add', port, {
            refresh_token: refreshToken
        });
    }

    /**
     * Refresh quotas for all accounts
     */
    public static async refreshAllQuotas(port: number = this.DEFAULT_PORT): Promise<RefreshResponse> {
        return await this.makeRequest('POST', '/accounts/refresh', port);
    }

    /**
     * Refresh quota for a specific account
     */
    public static async refreshAccountQuota(email: string, accountId?: string, port: number = this.DEFAULT_PORT): Promise<SwitchResponse> {
        return await this.makeRequest('POST', '/accounts/refresh_single', port, {
            email: email,
            account_id: accountId
        });
    }

    /**
     * Remove account
     */
    public static async removeAccount(email: string, accountId?: string, port: number = this.DEFAULT_PORT): Promise<SwitchResponse> {
        return await this.makeRequest('POST', '/accounts/remove', port, {
            email: email,
            account_id: accountId
        });
    }

    /**
     * Get application configuration
     */
    public static async getConfig(port: number = this.DEFAULT_PORT): Promise<AppConfig> {
        return await this.makeRequest('GET', '/config', port);
    }

    /**
     * Save application configuration
     */
    public static async saveConfig(config: AppConfig, port: number = this.DEFAULT_PORT): Promise<SaveConfigResponse> {
        return await this.makeRequest('POST', '/config', port, config);
    }

    /**
     * Execute HTTP request
     */
    private static makeRequest(
        method: 'GET' | 'POST',
        path: string,
        port: number,
        body?: any
    ): Promise<any> {
        return new Promise((resolve, reject) => {
            const url = `${this.BASE_URL}:${port}${path}`;
            const postData = body ? JSON.stringify(body) : undefined;

            const options: http.RequestOptions = {
                hostname: '127.0.0.1',
                port: port,
                path: path,
                method: method,
                timeout: this.TIMEOUT,
                headers: {
                    'Content-Type': 'application/json',
                    ...(postData && { 'Content-Length': Buffer.byteLength(postData) })
                }
            };

            logger.info(`[GravityOrchestratorApi] ${method} ${url}`);

            const req = http.request(options, (res) => {
                let data = '';

                res.on('data', (chunk) => {
                    data += chunk;
                });

                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            const response = JSON.parse(data);
                            logger.info(`[GravityOrchestratorApi] Success: ${method} ${path}`);
                            resolve(response);
                        } catch (error) {
                            reject(new Error(`Failed to parse response: ${data}`));
                        }
                    } else {
                        let errorMessage = `HTTP ${res.statusCode}`;
                        try {
                            const errorResponse = JSON.parse(data);
                            errorMessage = errorResponse.error || errorMessage;
                        } catch {
                            errorMessage = data || errorMessage;
                        }
                        reject(new Error(`API request failed: ${errorMessage}`));
                    }
                });
            });

            req.on('error', (error) => {
                logger.error(`[GravityOrchestratorApi] Request error: ${error.message}`);
                reject(error);
            });

            req.on('timeout', () => {
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

// ============================================================================
// Response Types
// ============================================================================

export interface HealthResponse {
    status: string;
    version: string;
}

export interface AccountResponse {
    id: string;
    email: string;
    name?: string;
    is_current: boolean;
    disabled: boolean;
    proxy_disabled?: boolean;
    quota?: QuotaResponse;
    device_bound: boolean;
    last_used: number;
}

export interface QuotaResponse {
    models: ModelQuota[];
    updated_at?: number;
    subscription_tier?: string;
}

export interface ModelQuota {
    name: string;
    percentage: number;
    reset_time: string;
}

export interface AccountListResponse {
    accounts: AccountResponse[];
    current_account_id?: string;
}

export interface CurrentAccountResponse {
    account?: AccountResponse;
}

export interface SwitchResponse {
    success: boolean;
    message: string;
}

export interface AddAccountResponse {
    success: boolean;
    message: string;
    account?: AccountResponse;
}

export interface RefreshResponse {
    success: boolean;
    message: string;
    refreshed_count: number;
}

export interface AppConfig {
    refresh_interval?: number;
    auto_sync?: boolean;
    sync_interval?: number;
    scheduled_warmup?: {
        enabled: boolean;
        monitored_models: string[];
    };
    quota_protection?: {
        enabled: boolean;
        threshold_percentage: number;
        monitored_models: string[];
    };
    [key: string]: any; // Allow other config fields
}

export interface SaveConfigResponse {
    success: boolean;
}
