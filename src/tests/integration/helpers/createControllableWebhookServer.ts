import http from 'http';

export interface WebhookServerControl {
  server: http.Server;
  url: string;
  receivedMessages: string[];
  setShouldFail: (shouldFail: boolean) => void;
  getShouldFail: () => boolean;
  clearMessages: () => void;
  close: () => Promise<void>;
}

/**
 * Creates a controllable HTTP server for testing webhook scenarios
 * Allows toggling between success/failure modes during tests
 */
export async function createControllableWebhookServer(): Promise<WebhookServerControl> {
  const receivedMessages: string[] = [];
  let shouldFail = false;

  const server = http.createServer((req, res) => {
    console.log(`[Webhook Server] Received ${req.method} request, shouldFail=${shouldFail}`);
    
    if (shouldFail) {
      // Simulate service down - return 503
      console.log('[Webhook Server] Returning 503 (service down)');
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Service Unavailable' }));
      return;
    }

    // Service is up - collect message
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      receivedMessages.push(body);
      console.log(`[Webhook Server] Returning 200 (received ${body.length} bytes)`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    
    req.on('error', (err) => {
      console.error('[Webhook Server] Request error:', err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, () => resolve());
  });

  const address = server.address();
  if (typeof address !== 'object' || !address?.port) {
    throw new Error('Failed to start controllable webhook server');
  }

  const url = `http://127.0.0.1:${address.port}`;

  return {
    server,
    url,
    receivedMessages,
    setShouldFail: (fail: boolean) => { shouldFail = fail; },
    getShouldFail: () => shouldFail,
    clearMessages: () => { receivedMessages.length = 0; },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
