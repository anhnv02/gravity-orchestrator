import * as http from 'http';
import { CALLBACK_HOST, CALLBACK_PATH, AUTH_TIMEOUT_MS } from './constants';
import { escapeHtml } from '../utils/htmlUtils';
import { logger } from '../utils/logger';

export interface CallbackResult {
  code: string;
  state?: string;
}

export class CallbackServer {
  private server: http.Server | null = null;
  private port: number = 0;
  private iconBase64: string | null = null;

  public setIcon(base64: string): void {
    this.iconBase64 = base64;
  }

  public getRedirectUri(): string {
    if (this.port === 0) {
      throw new Error('Server not started');
    }
    return `http://${CALLBACK_HOST}:${this.port}${CALLBACK_PATH}`;
  }

  public startServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer();

      this.server.listen(0, CALLBACK_HOST, () => {
        const address = this.server!.address();
        if (typeof address === 'object' && address !== null) {
          this.port = address.port;
          logger.info(`OAuth callback server listening on port ${this.port}`);
          resolve();
        } else {
          reject(new Error('Failed to get server address'));
        }
      });

      this.server.on('error', (err) => {
        reject(err);
      });
    });
  }

  public waitForCallback(expectedState: string): Promise<CallbackResult> {
    if (this.port === 0) {
      return Promise.reject(new Error('Server not started. Call startServer() first.'));
    }

    return new Promise((resolve, reject) => {

      const timeout = setTimeout(() => {
        this.stop();
        reject(new Error('OAuth callback timeout'));
      }, AUTH_TIMEOUT_MS);

      this.server!.on('request', (req, res) => {
        const url = new URL(req.url || '', `http://${CALLBACK_HOST}`);

        if (url.pathname !== CALLBACK_PATH) {
          res.writeHead(404);
          res.end('Not Found');
          return;
        }

        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const error = url.searchParams.get('error');
        const errorDescription = url.searchParams.get('error_description');

        clearTimeout(timeout);

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(this.getErrorHtml(error, errorDescription || 'Unknown error'));
          this.stop();
          reject(new Error(`OAuth error: ${error} - ${errorDescription}`));
          return;
        }

        if (!code) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(this.getErrorHtml('missing_code', 'No authorization code received'));
          this.stop();
          reject(new Error('No authorization code received'));
          return;
        }

        if (state !== expectedState) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(this.getErrorHtml('invalid_state', 'Invalid state parameter'));
          this.stop();
          reject(new Error('Invalid state parameter (CSRF protection)'));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(this.getSuccessHtml());

        this.stop();
        resolve({ code, state });
      });
    });
  }

  public stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
      this.port = 0;
    }
  }

  private getSuccessHtml(): string {
    return `
<!DOCTYPE html>
<html lang="vi" class="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login Successful - Gravity Orchestrator</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          fontFamily: {
            sans: ['Inter', 'sans-serif'],
          },
          colors: {
            border: "hsl(var(--border))",
            input: "hsl(var(--input))",
            ring: "hsl(var(--ring))",
            background: "hsl(var(--background))",
            foreground: "hsl(var(--foreground))",
            primary: {
              DEFAULT: "hsl(var(--primary))",
              foreground: "hsl(var(--primary-foreground))",
            },
            muted: {
              DEFAULT: "hsl(var(--muted))",
              foreground: "hsl(var(--muted-foreground))",
            },
            card: {
              DEFAULT: "hsl(var(--card))",
              foreground: "hsl(var(--card-foreground))",
            },
          },
        },
      },
    }
  </script>
  <style>
    :root {
      --background: 240 10% 3.9%;
      --foreground: 0 0% 98%;
      --card: 240 10% 3.9%;
      --card-foreground: 0 0% 98%;
      --primary: 0 0% 98%;
      --primary-foreground: 240 5.9% 10%;
      --muted: 240 3.7% 15.9%;
      --muted-foreground: 240 5% 64.9%;
      --border: 240 3.7% 15.9%;
    }
  </style>
</head>
<body class="bg-background text-foreground flex items-center justify-center min-h-screen antialiased selection:bg-primary/20">
  <div class="w-full max-w-md p-4 animate-in fade-in zoom-in duration-500">
    <div class="bg-card border border-border rounded-xl shadow-2xl p-8 text-center relative overflow-hidden">
      <div class="absolute top-0 left-1/2 -translate-x-1/2 w-48 h-48 bg-primary/10 blur-[50px] rounded-full -z-10"></div>

      <div class="flex flex-col items-center mb-8">
        ${this.iconBase64 ? `<img src="${this.iconBase64}" class="h-20 w-auto drop-shadow-xl" alt="Logo">` : ''}
      </div>

      <h3 class="text-sm font-medium text-muted-foreground tracking-wider mb-2">Gravity Orchestrator</h3>
      <h1 class="text-3xl font-bold tracking-tight mb-4">Login Successful</h1>
      <p class="text-muted-foreground leading-relaxed">
        You can close this page and return to <span class="font-semibold text-foreground">Antigravity</span>.
      </p>
    </div>
  </div>
</body>
</html>`;
  }

  private getErrorHtml(error: string, description: string): string {
    return `
<!DOCTYPE html>
<html lang="vi" class="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login Failed - Gravity Orchestrator</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          fontFamily: {
            sans: ['Inter', 'sans-serif'],
          },
          colors: {
            border: "hsl(var(--border))",
            input: "hsl(var(--input))",
            ring: "hsl(var(--ring))",
            background: "hsl(var(--background))",
            foreground: "hsl(var(--foreground))",
            destructive: {
              DEFAULT: "hsl(var(--destructive))",
              foreground: "hsl(var(--destructive-foreground))",
            },
            muted: {
              DEFAULT: "hsl(var(--muted))",
              foreground: "hsl(var(--muted-foreground))",
            },
            card: {
              DEFAULT: "hsl(var(--card))",
              foreground: "hsl(var(--card-foreground))",
            },
          },
        },
      },
    }
  </script>
  <style>
    :root {
      --background: 240 10% 3.9%;
      --foreground: 0 0% 98%;
      --card: 240 10% 3.9%;
      --card-foreground: 0 0% 98%;
      --destructive: 0 62.8% 30.6%;
      --destructive-foreground: 0 0% 98%;
      --muted: 240 3.7% 15.9%;
      --muted-foreground: 240 5% 64.9%;
      --border: 240 3.7% 15.9%;
    }
  </style>
</head>
<body class="bg-background text-foreground flex items-center justify-center min-h-screen antialiased selection:bg-destructive/20">
  <div class="w-full max-w-md p-4 animate-in fade-in zoom-in duration-500">
    <div class="bg-card border border-border rounded-xl shadow-2xl p-8 text-center relative overflow-hidden">
      <div class="absolute top-0 left-1/2 -translate-x-1/2 w-48 h-48 bg-destructive/10 blur-[50px] rounded-full -z-10"></div>

      <div class="flex flex-col items-center mb-8">
        ${this.iconBase64 ? `<img src="${this.iconBase64}" class="h-20 w-auto mb-6 drop-shadow-xl opacity-50 grayscale" alt="Logo">` : ''}
        <div class="w-16 h-16 bg-destructive/10 rounded-full flex items-center justify-center text-destructive">
          <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x"><path d="M18 6 6 18"/><path d="m6 6 18 18"/></svg>
        </div>
      </div>

      <h3 class="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-2">Gravity Orchestrator</h3>
      <h1 class="text-3xl font-bold tracking-tight mb-4">Login Failed</h1>
      <p class="text-muted-foreground leading-relaxed mb-4">
        ${escapeHtml(description)}
      </p>
      <div class="bg-muted/50 rounded-lg p-3 text-xs font-mono text-muted-foreground border border-border/50">
        Error code: ${escapeHtml(error)}
      </div>
    </div>
  </div>
</body>
</html>`;
  }

}
