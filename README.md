# Gravity Orchestrator

![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)

**Gravity Orchestrator** is a powerful VS Code extension designed to monitor and manage your AI model quotas for the Antigravity IDE ecosystem. It provides real-time status updates, multi-account management, and detailed usage insights directly within your editor.

## Features

- **Real-Time Quota Monitoring**: Instantly view the remaining quota for various AI models (Gemini, Claude, GPT-4, etc.) supported by Antigravity.
- **Status Bar Integration**: Get quick insights into your quota status with a glanceable status bar item. Hover for detailed per-model usage statistics.
- **Control Panel Dashboard**: A comprehensive webview interface to manage your accounts and view detailed quota breakdowns.
- **Multi-Account Support**: Seamlessly switch between multiple Google accounts, refresh quotas individually, and manage your sessions.
- **Auto Token Sync**: Automatically detects and syncs login tokens from your local Antigravity IDE installation.
- **Antigravity Tools Integration**: Optionally integrates with the Antigravity Tools app for enhanced account management.

## Usage

### Commands

Open the Command Palette (`Cmd+Shift+P` or `Ctrl+Shift+P`) and type `Gravity Orchestrator` to access the following commands:

- **Gravity Orchestrator: Show Control Panel**: Opens the main dashboard to view accounts and detailed quotas.
- **Gravity Orchestrator: Quick Refresh Quota**: Triggers an immediate refresh of your quota status.
- **Gravity Orchestrator: Login with Google**: Initiates the login process to add a new account.

### Status Bar

The status bar item displays the current extension status with color-coded indicators:
- 🟢 **Green**: All models have sufficient quota (>50%)
- 🟡 **Yellow**: Some models are running low (30-50%)
- 🟠 **Orange**: Critical quota level (<30%)
- 🔴 **Red**: Quota depleted

**Actions:**
- **Click**: Opens the Control Panel.
- **Hover**: Shows a tooltip with a detailed breakdown of your active models and their remaining quota/reset times.

### Control Panel

The Control Panel offers a rich interface to:
- View all connected accounts with tier information (Free/Pro/Ultra).
- See detailed quota usage (percentage bars, reset times) for each model.
- Switch active accounts.
- Refresh specific account data.
- Toggle between light/dark themes.

## Configuration

You can customize the extension behavior via VS Code Settings:

- **`gravityOrchestrator.theme`**: Sets the theme for the Control Panel interface.
  - `light` (default)
  - `dark`

## Requirements

- **Antigravity IDE** (recommended): For automatic token detection and seamless integration.
- **Google Account**: Required for authentication and quota access.
- **Antigravity Tools App** (optional): For enhanced multi-account management.

## License

MIT
