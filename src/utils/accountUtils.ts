import { TokenStorage } from '../auth/tokenStorage';
import { AntigravityToolsApi } from '../api/antigravityToolsApi';
import { logger } from './logger';

export interface AccountInfo {
  id: string;
  email: string;
  isActive: boolean;
  isExpired: boolean;
  tier?: string;
  usagePercentage?: number;
  models?: {
    name: string;
    percentage: number;
    reset_time: string;
  }[];
}

export interface MultiAccountInfo {
  accounts: AccountInfo[];
}

const usageCache = new Map<string, { percentage: number; timestamp: number; models?: any[] }>();
const CACHE_TTL = 30000; // 30 seconds

/**
 * Clear the account usage cache
 */
export function clearAccountUsageCache(): void {
  usageCache.clear();
}

/**
 * Get information for all accounts - Fetches from Antigravity Tools API for account list,
 * but uses Google API for usage percentage when possible.
 */
export async function getMultiAccountInfo(): Promise<MultiAccountInfo> {
  try {
    const isApiReady = await AntigravityToolsApi.isApiReady();

    if (!isApiReady) {
      logger.warn('[AccountUtils] Antigravity Tools API is not available');
      return { accounts: [] };
    }

    logger.info('[AccountUtils] Using Antigravity Tools API to get account info');
    const accountsResponse = await AntigravityToolsApi.listAccounts();
    const currentAccountId = accountsResponse.current_account_id;

    const now = Date.now();

    const accountsInfo = await Promise.all(accountsResponse.accounts.map(async acc => {
      let usagePercentage: number | undefined;
      let models: any[] | undefined;
      let rawTier = acc.quota?.subscription_tier || 'free';
      let tier = rawTier.toLowerCase();

      // Inference logic if tier is free but we see "premium" models
      // This helps when the API doesn't report the tier correctly but provides model data
      if (tier === 'free' && acc.quota?.models) {
        const models_list = acc.quota.models;
        const hasUltra = models_list.some(m => m.name.toLowerCase().includes('opus') || m.name.toLowerCase().includes('ultra'));
        const hasPro = models_list.some(m =>
          m.name.toLowerCase().includes('claude') ||
          m.name.toLowerCase().includes('gpt-oss') ||
          m.name.toLowerCase().includes('pro-high')
        );

        if (hasUltra) {
          tier = 'ultra';
        } else if (hasPro) {
          tier = 'pro';
        }
      }

      // Check cache first
      const cached = usageCache.get(acc.email);
      if (cached && (now - cached.timestamp < CACHE_TTL)) {
        usagePercentage = cached.percentage;
        models = cached.models;
      } else {
        // Get model information from app API quota data
        if (acc.quota?.models) {
          try {
            logger.info(`[AccountUtils] Using app API quota for ${acc.email}`);

            const ideModelPatterns = [
              /gemini-3-pro-high/i,
              /gemini-3-pro-low/i,
              /gemini-3-flash/i,
              /claude-sonnet-4-5(?!-thinking)/i,
              /claude-sonnet-4-5-thinking/i,
              /claude-opus-4-5-thinking/i,
              /gpt-oss-120b-medium/i
            ];

            const normalizeModelName = (name: string): string => {
              return name.toLowerCase()
                .replace(/\s+/g, '-')
                .replace(/[()]/g, '');
            };

            // Filter to IDE models only
            const filteredModels = acc.quota.models.filter(model => {
              const normalizedName = normalizeModelName(model.name);
              return ideModelPatterns.some(pattern => pattern.test(normalizedName));
            });

            if (filteredModels.length > 0) {
              models = filteredModels.map(m => ({
                name: m.name,
                percentage: m.percentage || 0,
                reset_time: m.reset_time
              }));

              const minPercentage = Math.min(...filteredModels.map(m => m.percentage || 0));
              usagePercentage = 100 - minPercentage;

              // Update cache
              usageCache.set(acc.email, {
                percentage: usagePercentage,
                timestamp: now,
                models: models
              });
            }
          } catch (error) {
            logger.warn(`[AccountUtils] Failed to process app API quota for ${acc.email}:`, error);
          }
        }
      }


      // Log for debugging
      console.log(`[AccountUtils] Account: ${acc.email}, disabled: ${acc.disabled}, proxy_disabled: ${acc.proxy_disabled}`);

      const proxyDisabled = acc.proxy_disabled === true;
      const isDisabled = acc.disabled === true;

      return {
        id: acc.id,
        email: acc.email,
        isActive: acc.id === currentAccountId,
        isExpired: isDisabled || proxyDisabled,
        tier,
        usagePercentage,
        models
      };
    }));

    // Sort accounts: active account first, then by email
    accountsInfo.sort((a, b) => {
      if (a.isActive && !b.isActive) return -1;
      if (!a.isActive && b.isActive) return 1;
      return a.email.localeCompare(b.email);
    });

    return {
      accounts: accountsInfo
    };
  } catch (error) {
    logger.error('[AccountUtils] Failed to get account info:', error);
    return { accounts: [] };
  }
}

/**
 * Clean up duplicate accounts before displaying
 */
export async function cleanupDuplicateAccounts(): Promise<void> {
  const tokenStorage = TokenStorage.getInstance();
  try {
    const removedCount = await tokenStorage.cleanupDuplicateAccounts();
    if (removedCount > 0) {
      logger.info(`Cleaned up ${removedCount} duplicate account(s)`);
    }
  } catch (e) {
    logger.error('Failed to cleanup duplicate accounts:', e);
  }
}
