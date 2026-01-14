import * as fs from 'fs';
import * as path from 'path';
import { logger } from './utils/logger';

export class SafePowerShellPath {
    private static readonly SYSTEM_ROOT: string = process.env.SystemRoot || 'C:\\Windows';

    private static readonly KNOWN_SAFE_PATHS: readonly string[] = [

        path.join(SafePowerShellPath.SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),

        'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        path.join(SafePowerShellPath.SYSTEM_ROOT, 'System32', 'pwsh.exe'),
        'C:\\Program Files\\PowerShell\\6\\pwsh.exe',
        'C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe',
        'C:\\Program Files (x86)\\PowerShell\\6\\pwsh.exe',
    ] as const;

    private static cachedPath: string | null = null;
    private static pathType: 'system32' | 'pwsh7' | 'path_fallback' | 'not_found' = 'not_found';

    public static getSafePath(): string {
        if (this.cachedPath !== null) {
            return this.cachedPath;
        }

        const result = this.findSafePath();
        this.cachedPath = result.path;
        this.pathType = result.type;

        logger.info(`[SafePowerShellPath] Using PowerShell from: ${result.path} (type: ${result.type})`);

        return this.cachedPath;
    }

    public static getPathInfo(): { path: string; type: 'system32' | 'pwsh7' | 'path_fallback' | 'not_found' } {
        if (this.cachedPath === null) {
            this.getSafePath();
        }
        return { path: this.cachedPath || '', type: this.pathType };
    }

    public static clearCache(): void {
        this.cachedPath = null;
        this.pathType = 'not_found';
    }

    private static findSafePath(): { path: string; type: 'system32' | 'pwsh7' | 'path_fallback' | 'not_found' } {

        for (let i = 0; i < this.KNOWN_SAFE_PATHS.length; i++) {
            const safePath = this.KNOWN_SAFE_PATHS[i];
            try {
                if (fs.existsSync(safePath)) {

                    const type = i === 0 ? 'system32' : 'pwsh7';

                    return { path: `"${safePath}"`, type };
                }
            } catch (e) {

                logger.info(`[SafePowerShellPath] Cannot access ${safePath}: ${e}`);
            }
        }

        logger.info('[SafePowerShellPath] Warning: No PowerShell found in trusted paths, falling back to PATH lookup');

        return { path: 'powershell', type: 'path_fallback' };
    }

    public static isUsingPathFallback(): boolean {
        this.getSafePath();
        return this.pathType === 'path_fallback';
    }

    public static getAvailableInstallations(): string[] {
        const available: string[] = [];

        for (const safePath of this.KNOWN_SAFE_PATHS) {
            try {
                if (fs.existsSync(safePath)) {
                    available.push(safePath);
                }
            } catch (e) {

            }
        }

        return available;
    }
}
