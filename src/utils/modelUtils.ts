/**
 * Utility functions for model filtering and formatting
 */

/**
 * Filter models based on Google Cloud Code criteria
 * 1. Must be gemini, claude, or gpt
 * 2. Gemini version must be >= 3.0
 * 3. No image models
 */
export function filterModelsForDisplay(modelName: string): boolean {
    const lowerName = modelName.toLowerCase();

    // 1. Must be gemini, claude, or gpt
    if (!/gemini|claude|gpt/i.test(lowerName)) {
        return false;
    }

    // 2. Gemini version must be >= 3.0
    if (lowerName.includes('gemini')) {
        const versionMatch = lowerName.match(/gemini-(\d+(?:\.\d+)?)/);
        if (versionMatch && versionMatch[1]) {
            const version = parseFloat(versionMatch[1]);
            if (version < 3.0) {return false;}
        }
    }

    // 3. No image models
    if (lowerName.includes('image')) {
        return false;
    }

    return true;
}

/**
 * Format model display name to match Google Cloud Code style
 * Example: gemini-3-pro-high -> Gemini 3 Pro High
 * Example: claude-sonnet-4-5 -> Claude Sonnet 4.5
 * Example: claude-opus-4-5-thinking -> Claude Opus 4.5 (Thinking)
 */
export function formatModelDisplayName(modelName: string): string {
    // Handle thinking models specially
    let name = modelName;
    let suffix = '';
    if (name.toLowerCase().endsWith('-thinking')) {
        name = name.substring(0, name.length - '-thinking'.length);
        suffix = ' (Thinking)';
    }

    // Replace hyphen between digits with dot (e.g., 4-5 -> 4.5)
    name = name.replace(/(\d+)-(\d+)/g, '$1.$2');

    const formattedBase = name
        .split('-')
        .map(part => {
            // If part starts with a digit, keep it as is (e.g., "3", "4.5")
            if (/^\d/.test(part)) {
                return part;
            }
            // Capitalize first letter
            return part.charAt(0).toUpperCase() + part.slice(1);
        })
        .join(' ');

    return formattedBase + suffix;
}
