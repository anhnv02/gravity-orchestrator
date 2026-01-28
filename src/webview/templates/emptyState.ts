/**
 * Empty State Template
 */

import * as vscode from 'vscode';

/**
 * Generate empty state HTML when API is not ready
 */
export function getEmptyStateHtml(codiconUri: vscode.Uri | null): string {
    const codiconLink = codiconUri ? `<link rel="stylesheet" href="${codiconUri}">` : '';
    
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Gravity Orchestrator</title>
    ${codiconLink}
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
        }
        .empty-state {
            text-align: center;
            padding: 60px 20px;
            color: var(--vscode-descriptionForeground);
        }
        .empty-state-title {
            font-size: 24px;
            font-weight: 600;
            margin-bottom: 16px;
            color: var(--vscode-foreground);
        }
        .empty-state-description {
            font-size: 14px;
            margin-bottom: 24px;
            line-height: 1.6;
        }
        .app-download-notice {
            background-color: var(--vscode-inputValidation-infoBackground);
            color: var(--vscode-inputValidation-infoForeground);
            padding: 16px;
            border-radius: 4px;
            margin: 20px auto;
            max-width: 600px;
            font-size: 14px;
        }
        .app-download-notice strong {
            display: block;
            margin-bottom: 8px;
            font-size: 16px;
        }
        .app-download-notice a {
            color: var(--vscode-textLink-foreground);
            text-decoration: underline;
        }
    </style>
</head>
<body>
    <div class="empty-state">
        <div class="empty-state-title">Gravity Orchestrator</div>
        <div class="empty-state-description">
            To use this extension, you need to install and run the Gravity Orchestrator application.
        </div>
        <div class="app-download-notice">
            <strong>📥 App Installation Required</strong>
            <p>Please download and install the <a href="https://github.com/anhnv02/gravity-orchestrator/releases">Gravity Orchestrator</a> application to manage and switch accounts.</p>
            <p>After installation, launch the application and reopen this panel.</p>
        </div>
    </div>
</body>
</html>`;
}
