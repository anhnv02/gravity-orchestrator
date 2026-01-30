import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from '../utils/logger';

const execAsync = promisify(exec);

function getAntigravityDbPath(): string {
    const platform = os.platform();
    const home = os.homedir();

    if (platform === 'darwin') {
        return path.join(home, 'Library/Application Support/Antigravity/User/globalStorage/state.vscdb');
    } else if (platform === 'win32') {
        return path.join(process.env.APPDATA || '', 'Antigravity/User/globalStorage/state.vscdb');
    } else {
        return path.join(home, '.config/Antigravity/User/globalStorage/state.vscdb');
    }
}

export function hasAntigravityDb(): boolean {
    const dbPath = getAntigravityDbPath();
    return fs.existsSync(dbPath);
}

export async function extractRefreshTokenFromAntigravity(): Promise<string | null> {
    try {
        const dbPath = getAntigravityDbPath();

        if (!fs.existsSync(dbPath)) {
            logger.info('[AntigravityTokenExtractor] Database not found:', dbPath);
            return null;
        }

        logger.info('[AntigravityTokenExtractor] Attempting to extract token from:', dbPath);

        const { stdout } = await execAsync(
            `sqlite3 "${dbPath}" "SELECT value FROM ItemTable WHERE key = 'jetskiStateSync.agentManagerInitState'"`,
            { timeout: 5000 }
        );

        if (!stdout.trim()) {
            logger.info('[AntigravityTokenExtractor] No login state found in database');
            return null;
        }

        const base64Data = stdout.trim();
        const buffer = Buffer.from(base64Data, 'base64');

        const refreshToken = parseProtobufForRefreshToken(buffer);

        if (refreshToken) {
            logger.info('[AntigravityTokenExtractor] Successfully extracted refresh_token');
        } else {
            logger.info('[AntigravityTokenExtractor] Failed to parse refresh_token from protobuf');
        }

        return refreshToken;
    } catch (error) {
        logger.info(`[AntigravityTokenExtractor] Failed to extract refresh_token: ${error}`);
        return null;
    }
}

function parseProtobufForRefreshToken(buffer: Buffer): string | null {
    try {

        const oauthData = findProtobufField(buffer, 6);
        if (!oauthData) {
            return null;
        }

        const refreshTokenBytes = findProtobufField(oauthData, 3);
        if (!refreshTokenBytes) {
            return null;
        }

        return refreshTokenBytes.toString('utf-8');
    } catch (error) {
        logger.info('[AntigravityTokenExtractor] Protobuf parse error:', error);
        return null;
    }
}

function findProtobufField(buffer: Buffer, fieldNumber: number): Buffer | null {
    let pos = 0;

    while (pos < buffer.length) {
        const { value: tag, newPos: tagEndPos } = readVarint(buffer, pos);
        if (tagEndPos >= buffer.length) {
            break;
        }

        const wireType = tag & 0x07;
        const field = tag >> 3;
        pos = tagEndPos;

        if (wireType === 2) {

            const { value: length, newPos: lenEndPos } = readVarint(buffer, pos);
            pos = lenEndPos;

            if (field === fieldNumber) {
                return buffer.slice(pos, pos + length);
            }
            pos += length;
        } else if (wireType === 0) {

            const { newPos } = readVarint(buffer, pos);
            pos = newPos;
        } else if (wireType === 1) {

            pos += 8;
        } else if (wireType === 5) {

            pos += 4;
        } else {

            break;
        }
    }

    return null;
}

function readVarint(buffer: Buffer, pos: number): { value: number; newPos: number } {
    let result = 0;
    let shift = 0;

    while (pos < buffer.length) {
        const byte = buffer[pos];
        result |= (byte & 0x7f) << shift;
        pos++;

        if ((byte & 0x80) === 0) {
            break;
        }
        shift += 7;
    }

    return { value: result, newPos: pos };
}
