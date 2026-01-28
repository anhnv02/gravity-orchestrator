/**
 * Webview Styles Module
 * Combines all CSS styles for the webview
 */

import * as fs from 'fs';
import * as path from 'path';

// Read CSS files synchronously at module load time
const stylesDir = path.join(__dirname, 'styles');

/**
 * Get all combined CSS styles as a string
 */
export function getAllStyles(): string {
    const cssFiles = [
        'base.css',
        'components.css',
        'tabs.css',
        'models.css',
        'accounts.css',
        'filters.css'
    ];

    return cssFiles.map(file => {
        try {
            return fs.readFileSync(path.join(stylesDir, file), 'utf-8');
        } catch (error) {
            console.error(`Failed to read CSS file: ${file}`, error);
            return '';
        }
    }).join('\n');
}

/**
 * Generate inline <style> tag with all styles
 */
export function getStyleTag(): string {
    return `<style>\n${getAllStyles()}\n</style>`;
}
