/**
 * Formatting utility functions for webview
 */

/**
 * Format time until reset in a human-readable format
 */
export function formatTimeUntilReset(ms: number): string {
    if (ms <= 0) {
        return 'Expired';
    }

    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
        const remainingHours = hours % 24;
        if (remainingHours > 0) {
            return `${days}d ${remainingHours}h`;
        }
        return `${days}d`;
    } else if (hours > 0) {
        const remainingMinutes = minutes % 60;
        if (remainingMinutes > 0) {
            return `${hours}h ${remainingMinutes}m`;
        }
        return `${hours}h`;
    } else if (minutes > 0) {
        return `${minutes}m`;
    }
    return `${seconds}s`;
}

/**
 * Format reset time from a time string (e.g., "2d 5h from now")
 */
export function formatResetTime(timeString: string): string {
    if (!timeString || timeString === 'Expired') {
        return 'Expired';
    }

    const cleanTime = timeString.replace(/\s+from now$/, '');
    const parts: string[] = [];

    const timeUnits: Array<{ pattern: RegExp; unit: string; condition?: (val: number) => boolean; stopAfter?: boolean }> = [
        { pattern: /(\d+)d/, unit: 'day' },
        { pattern: /(\d+)h/, unit: 'hour' },
        { pattern: /(\d+)m/, unit: 'minute', condition: (val: number) => parts.length === 0 || val >= 30, stopAfter: true },
        { pattern: /(\d+)s/, unit: 'second', condition: () => parts.length === 0, stopAfter: true }
    ];

    for (const { pattern, unit, condition, stopAfter } of timeUnits) {
        const match = cleanTime.match(pattern);
        if (match) {
            const value = parseInt(match[1], 10);
            if (!condition || condition(value)) {
                parts.push(`${value} ${unit}${value !== 1 ? 's' : ''}`);
                if (stopAfter) {break;}
            }
        }
    }

    return parts.length > 0 ? parts.join(' ') : timeString;
}

/**
 * Mask email for privacy display
 */
export function maskEmail(email: string): string {
    if (!email) {return '';}
    const parts = email.split('@');
    if (parts.length !== 2) {return email;}

    const [name, domain] = parts;
    if (name.length <= 4) {return email;} // Too short to mask nicely

    const start = name.substring(0, 5);
    const end = name.substring(name.length > 4 ? name.length - 4 : 0);

    // Check if domain is too long and truncate
    let displayDomain = domain;
    if (domain.length > 10) {
        displayDomain = domain.substring(0, 8) + '...';
    }

    return `${start}*****${end}@${displayDomain}`;
}

/**
 * Get a random "last used" timestamp for display
 */
export function getRandomLastUsed(): string {
    const now = new Date();
    return `Last Used: ${now.getDate()}/${now.getMonth() + 1}/${now.getFullYear()} • ${now.getHours()}:${now.getMinutes().toString().padStart(2, '0')}`;
}
