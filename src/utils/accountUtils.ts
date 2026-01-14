import { GoogleAuthService } from '../auth';
import { TokenStorage } from '../auth/tokenStorage';
import { GoogleCloudCodeClient, ModelQuotaFromApi } from '../api/googleCloudCodeClient';
import { logger } from './logger';

export interface AccountInfo {
  email: string;
  isActive: boolean;
  isExpired: boolean;
  usagePercentage?: number;
}

export interface MultiAccountInfo {
  accounts: AccountInfo[];
}

const usageCache = new Map<string, { percentage: number; timestamp: number }>();
const CACHE_TTL = 30000; // 30 seconds

/**
 * Clear the account usage cache
 */
export function clearAccountUsageCache(): void {
  usageCache.clear();
}

/**
 * Get information for all accounts
 */
export async function getMultiAccountInfo(): Promise<MultiAccountInfo> {
  const googleAuthService = GoogleAuthService.getInstance();
  const tokenStorage = TokenStorage.getInstance();
  const googleApiClient = GoogleCloudCodeClient.getInstance();
  
  const [allAccounts, activeAccount] = await Promise.all([
    googleAuthService.getAllAccounts(),
    googleAuthService.getActiveAccount()
  ]);

  const now = Date.now();
  const accountsInfoPromises = allAccounts.map(async (email) => {
    const isExpired = await tokenStorage.isTokenExpiredForAccount(email);
    let usagePercentage: number | undefined;

    // Try to get from cache first
    const cached = usageCache.get(email);
    if (cached && (now - cached.timestamp < CACHE_TTL)) {
      usagePercentage = cached.percentage;
    }

    if (usagePercentage === undefined && !isExpired) {
      try {
        const accessToken = await googleAuthService.getValidAccessTokenForAccount(email);
        const projectInfo = await googleApiClient.loadProjectInfo(accessToken);
        const modelsQuota = await googleApiClient.fetchModelsQuota(accessToken, projectInfo.projectId);
        
        if (modelsQuota.models.length > 0) {
          // Use minimum remaining quota as representative percentage
          const minRemaining = Math.min(...modelsQuota.models.map((m: ModelQuotaFromApi) => m.remainingQuota));
          // Convert remaining to used percentage
          usagePercentage = (1 - minRemaining) * 100;
          
          // Update cache
          usageCache.set(email, { percentage: usagePercentage, timestamp: now });
        }
      } catch (e) {
        logger.error(`[AccountUtils] Failed to fetch quota for ${email}:`, e);
      }
    }

    return {
      email,
      isActive: email === activeAccount,
      isExpired,
      usagePercentage
    };
  });

  const accountsInfo = await Promise.all(accountsInfoPromises);

  return {
    accounts: accountsInfo
  };
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
