/**
 * Status utility functions for determining CSS classes and colors
 */

export type StatusClass = 'normal' | 'warning' | 'critical' | 'depleted';

/**
 * Get status class based on percentage and exhaustion state
 */
export function getStatusClass(percentage: number, isExhausted: boolean): StatusClass {
    if (isExhausted || percentage <= 0) {
        return 'depleted';
    }
    if (percentage < 20) {
        return 'critical';
    }
    if (percentage < 80) {
        return 'warning';
    }
    return 'normal';
}

/**
 * Get color information for a model based on its percentage
 */
export function getModelColorInfo(percentage: number, isExhausted: boolean, modelId: string): {
    colorClass: string;
    barGradient: string;
    textColor: string;
} {
    const isClaude = modelId.toLowerCase().includes('claude');

    if (isExhausted || percentage === 0) {
        return {
            colorClass: 'depleted',
            barGradient: 'linear-gradient(to right, #808080, #808080)',
            textColor: '#808080'
        };
    }

    if (percentage >= 50) {
        if (isClaude) {
            return {
                colorClass: 'normal-claude',
                barGradient: 'linear-gradient(to right, #22d3ee, #06b6d4)', // cyan
                textColor: '#0891b2'
            };
        }
        return {
            colorClass: 'normal',
            barGradient: 'linear-gradient(to right, #34d399, #10b981)', // emerald
            textColor: '#059669'
        };
    }

    if (percentage >= 20) {
        if (isClaude) {
            return {
                colorClass: 'warning-claude',
                barGradient: 'linear-gradient(to right, #fb923c, #f97316)', // orange
                textColor: '#ea580c'
            };
        }
        return {
            colorClass: 'warning',
            barGradient: 'linear-gradient(to right, #fbbf24, #f59e0b)', // amber
            textColor: '#d97706'
        };
    }

    // < 20%
    return {
        colorClass: 'critical',
        barGradient: 'linear-gradient(to right, #fb7185, #f43f5e)', // rose
        textColor: '#e11d48'
    };
}

/**
 * Get pill color class for account table
 */
export function getPillColorClass(percentage: number): 'green' | 'yellow' | 'red' {
    if (percentage <= 0) return 'red';
    if (percentage < 30) return 'yellow';
    return 'green';
}

/**
 * Get tier badge HTML based on tier name
 */
export function getTierBadgeHtml(tier: string): string {
    const tierLower = (tier || 'free').toLowerCase();

    if (tierLower.includes('ultra')) {
        return '<span class="badge-pro"><span class="codicon codicon-diamond" style="font-size: 10px;"></span> ULTRA</span>';
    }
    if (tierLower.includes('pro')) {
        return '<span class="badge-pro"><span class="codicon codicon-diamond" style="font-size: 10px;"></span> PRO</span>';
    }
    return '<span class="badge-outline">FREE</span>';
}
