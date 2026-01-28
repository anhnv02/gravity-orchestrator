/**
 * Loading State Template
 */

import * as vscode from 'vscode';

/**
 * Generate loading state HTML
 */
export function getLoadingHtml(codiconUri: vscode.Uri | null): string {
    const codiconLink = codiconUri ? `<link rel="stylesheet" href="${codiconUri}">` : '';
    
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Gravity Orchestrator</title>
    ${codiconLink}
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif;
            height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            background: var(--vscode-editor-background, #FAFBFC);
            color: var(--vscode-foreground, #111827);
        }
        body[data-vscode-theme-kind="dark"] {
            background: var(--vscode-editor-background, #1d232a);
            color: var(--vscode-foreground, #e2e8f0);
        }
        .loading-container {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 20px;
        }
        .spinner {
            width: 48px;
            height: 48px;
            border: 4px solid var(--vscode-input-border, #e5e7eb);
            border-top-color: var(--vscode-button-background, #3b82f6);
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
        }
        body[data-vscode-theme-kind="dark"] .spinner {
            border-color: var(--vscode-input-border, #475569);
        }
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        .loading-text {
            font-size: 14px;
            color: var(--vscode-descriptionForeground, #6b7280);
        }
        body[data-vscode-theme-kind="dark"] .loading-text {
            color: var(--vscode-descriptionForeground, #9ca3af);
        }
    </style>
</head>
<body>
    <div class="loading-container">
        <div class="spinner"></div>
        <div class="loading-text">Loading Gravity Orchestrator...</div>
    </div>
</body>
</html>`;
}
