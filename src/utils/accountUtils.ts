import { GoogleAuthService } from '../auth';
import { TokenStorage } from '../auth/tokenStorage';
import { AntigravityManagerClient } from '../api/antigravityManagerClient';
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
  const antigravityManagerClient = AntigravityManagerClient.getInstance();
  
  try {
    // Get all accounts from Antigravity-Manager
    const accountsResponse = await antigravityManagerClient.getAllAccounts();
    const currentAccountId = accountsResponse.current_account_id;

    const now = Date.now();
    const accountsInfoPromises = accountsResponse.accounts.map(async (account) => {
      const email = account.email;
      const isExpired = account.disabled || !account.quota;
      let usagePercentage: number | undefined;

      // Try to get from cache first
      const cached = usageCache.get(email);
      if (cached && (now - cached.timestamp < CACHE_TTL)) {
        usagePercentage = cached.percentage;
      }

      if (usagePercentage === undefined && account.quota && account.quota.models.length > 0) {
        try {
          // Use minimum remaining quota as representative percentage
          const minRemaining = Math.min(...account.quota.models.map((m) => m.percentage / 100));
          // Convert remaining to used percentage
          usagePercentage = (1 - minRemaining) * 100;
          
          // Update cache
          usageCache.set(email, { percentage: usagePercentage, timestamp: now });
        } catch (e) {
          logger.error(`[AccountUtils] Failed to calculate usage for ${email}:`, e);
        }
      }

      return {
        email,
        isActive: account.id === currentAccountId,
        isExpired,
        usagePercentage
      };
    });

    const accountsInfo = await Promise.all(accountsInfoPromises);

    return {
      accounts: accountsInfo
    };
  } catch (e) {
    logger.error('[AccountUtils] Failed to fetch accounts from Antigravity-Manager, falling back to GoogleAuthService:', e);
    
    // Fallback to original method if Antigravity-Manager API is not available
    const [allAccounts, activeAccount] = await Promise.all([
      googleAuthService.getAllAccounts(),
      googleAuthService.getActiveAccount()
    ]);

    const accountsInfo = allAccounts.map((email) => {
      return {
        email,
        isActive: email === activeAccount,
        isExpired: false, // Can't determine from fallback
        usagePercentage: undefined
      };
    });

    return {
      accounts: accountsInfo
    };
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
