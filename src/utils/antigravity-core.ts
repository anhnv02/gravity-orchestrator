import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// External dependency: sql.js
// Consumers of this module need to ensure sql.js is installed: `npm install sql.js`
// Using require to avoid TypeScript definition issues with current sql.js version
const initSqlJs = require('sql.js');

/**
 * Interface representing Antigravity user account information
 */
export interface AccountInfo {
    name: string;
    email: string;
    apiKey?: string;
    tier?: string;
    status?: string;
}

/**
 * Core client for interacting with Antigravity IDE local database
 */
export class AntigravityClient {
    private dbPath: string;
    private customDbPath: string | undefined;

    // Static singleton for SQL engine to avoid reloading heavy binary on every instance
    private static sqlEngine: any = null;
    private static initPromise: Promise<void> | null = null;

    private static readonly MODEL_PATTERNS = [
        'Gemini 3 Flash',
        'Gemini 3 Pro (High)',
        'Gemini 3 Pro (Low)',
        'Claude Sonnet 4.5',
        'Claude Sonnet 4.5 (Thinking)',
        'Claude Opus 4.5 (Thinking)',
        'GPT-OSS 120B (Medium)'
    ];

    /**
     * Create a new AntigravityClient instance
     * @param customDbPath Optional custom path to the Antigravity User Data directory
     */
    constructor(customDbPath?: string) {
        this.customDbPath = customDbPath;
        this.dbPath = this.getDefaultDbPath();
        // Trigger static init in background if not ready
        AntigravityClient.initializeSqlEngine();
    }

    /**
     * Statically initialize the SQL.js library once
     */
    private static async initializeSqlEngine(): Promise<void> {
        if (AntigravityClient.sqlEngine) {return;}

        if (!AntigravityClient.initPromise) {
            AntigravityClient.initPromise = (async () => {
                try {
                    AntigravityClient.sqlEngine = await initSqlJs();
                } catch (error) {
                    console.error('AntigravityClient: Failed to initialize SQL.js:', error);
                    AntigravityClient.initPromise = null;
                    throw error;
                }
            })();
        }
        await AntigravityClient.initPromise;
    }

    /**
     * Ensure SQL.js is initialized before performing operations
     */
    private async ensureSqlReady(): Promise<void> {
        await AntigravityClient.initializeSqlEngine();
        if (!AntigravityClient.sqlEngine) {
            throw new Error('SQL.js failed to initialize');
        }
    }

    /**
     * Resolve the default database path based on the operating system
     */
    private getDefaultDbPath(): string {
        if (this.customDbPath) {
            return this.customDbPath;
        }

        const platform = os.platform();
        const home = os.homedir();

        switch (platform) {
            case 'darwin':
                return path.join(home, 'Library', 'Application Support', 'Antigravity');
            case 'win32':
                return path.join(process.env.APPDATA || '', 'Antigravity');
            default:
                return path.join(home, '.config', 'Antigravity');
        }
    }

    /**
     * Get the currently resolved base path
     */
    public getBasePath(): string {
        return this.dbPath;
    }

    /**
     * Check if the database path exists
     */
    public isValid(): boolean {
        return fs.existsSync(this.dbPath);
    }

    /**
     * Internal method to execute a query on a specific SQLite database file
     */
    private async queryDatabase(dbFile: string, query: string): Promise<any[]> {
        await this.ensureSqlReady();

        try {
            // Check file existence asynchronously
            await fs.promises.access(dbFile);
        } catch {
            return [];
        }

        let db: any = null;
        try {
            // Read file asynchronously to prevent blocking the event loop
            const buffer = await fs.promises.readFile(dbFile);
            db = new AntigravityClient.sqlEngine.Database(buffer);
            const result = db.exec(query);

            if (result.length === 0) {
                return [];
            }

            // Convert result format (columns + values) to array of objects
            const { columns, values } = result[0];
            return values.map((row: any[]) => {
                const obj: any = {};
                columns.forEach((col: string, idx: number) => {
                    obj[col] = row[idx];
                });
                return obj;
            });
        } catch (error) {
            console.error(`AntigravityClient: Error querying database ${dbFile}:`, error);
            return [];
        } finally {
            if (db) {
                db.close();
            }
        }
    }

    /**
     * Parse raw value from database (which might be Buffer, string, or JSON-string)
     */
    private parseValue(value: any): any {
        if (!value) { return null; }

        let str: string;
        if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
            str = Buffer.from(value).toString('utf8');
        } else if (typeof value === 'string') {
            str = value;
        } else {
            return value;
        }

        try {
            return JSON.parse(str);
        } catch {
            return str;
        }
    }

    /**
     * Get a raw state value from the Global State database
     */
    public async getGlobalStateValue(key: string): Promise<any> {
        const dbFile = path.join(this.dbPath, 'User', 'globalStorage', 'state.vscdb');
        const escapedKey = key.replace(/'/g, "''");
        const rows = await this.queryDatabase(dbFile, `SELECT value FROM ItemTable WHERE key = '${escapedKey}'`);

        if (rows.length === 0) {
            return null;
        }

        return this.parseValue(rows[0].value);
    }

    /**
     * Retrieve user account information
     */
    public async getAccountInfo(): Promise<AccountInfo | null> {
        try {
            const data = await this.getGlobalStateValue('antigravityAuthStatus');

            if (!data || typeof data !== 'object') {
                return null;
            }

            return {
                name: data.name || 'Unknown',
                email: data.email || 'Unknown',
                apiKey: data.apiKey ? `${data.apiKey.substring(0, 20)}...` : undefined,
                tier: this.extractTier(data.userStatusProtoBinaryBase64),
                status: 'Active'
            };
        } catch (error) {
            console.error('AntigravityClient: Error reading account info:', error);
            return null;
        }
    }

    /**
     * Extract tier information from Protocol Buffers binary data
     */
    private extractTier(protoBase64?: string): string {
        if (!protoBase64) { return 'Unknown'; }

        try {
            const decoded = Buffer.from(protoBase64, 'base64').toString('utf8');

            if (decoded.includes('ultra-tier')) {return 'Ultra';}
            if (decoded.includes('pro-tier') || decoded.includes('standard-tier')) {return 'Pro';}
            if (decoded.includes('free-tier') || decoded.includes('Free')) {return 'Free';}

            return 'Unknown';
        } catch {
            return 'Unknown';
        }
    }

    /**
     * Retrieve list of authorized/available AI models
     */
    public async getAvailableModels(): Promise<string[]> {
        try {
            const data = await this.getGlobalStateValue('antigravityAuthStatus');

            if (!data || !data.userStatusProtoBinaryBase64) {
                return [];
            }

            const decoded = Buffer.from(data.userStatusProtoBinaryBase64, 'base64').toString('utf8');

            return AntigravityClient.MODEL_PATTERNS.filter(pattern => decoded.includes(pattern));
        } catch (error) {
            console.error('AntigravityClient: Error reading models:', error);
            return [];
        }
    }
}
