/**
 * Utility functions for time formatting
 */

/**
 * Format milliseconds until reset time into a human-readable string
 * @param ms Milliseconds until reset
 * @returns Formatted string (e.g., "2d3h from now", "5h 30m from now")
 */
export function formatTimeUntilReset(ms: number): string {
  if (ms <= 0) {return 'Expired';}

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {return `${days}d${hours % 24}h from now`;}
  if (hours > 0) {return `${hours}h ${minutes % 60}m from now`;}
  if (minutes > 0) {return `${minutes}m ${seconds % 60}s from now`;}
  return `${seconds}s from now`;
}

