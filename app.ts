// The forge as one process: an HTTP server routing the four surfaces — git smart HTTP,
// REST v3, GraphQL v4 and MCP — over one in-memory store. `createApp()` is what main.ts
// listens on; the lifecycle (ephemeral port, register, wait for done) stays in main.ts.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { buildIdentity } from './scenario.ts';
import { handleRest, type RestContext } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { executeMcp } from './mcp.ts';
import {
  advertiseReceivePack,
  advertiseUploadPack,
  dataLines,
  handleReceivePack,
  lsRefsV2,
  parseFetchArgs,
  parseLsRefsArgs,
  pushReportBytes,
  uploadPackV0,
  uploadPackV2,
} from './git.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

export function createApp(): ReturnType<typeof createServer> {
  const store = new Store(buildIdentity());
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let requestCounter = 0;
  const nextRequestId = (): string => {
    requestCounter += 1;
    return `req-${requestCounter}`;
  };
  const restContext: RestContext = { store, token: expectedToken, nextRequestId };

  const jsonHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
    'Content-Type': 'application/json; charset=utf-8',
    'X-GitHub-Request-Id': nextRequestId(),
    ...extra,
  });

  const sendJson = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void => {
    const data = body === null ? '' : JSON.stringify(body);
    res.writeHead(status, jsonHeaders(extra));
    res.end(data);
  };

  const sendJsonError = (res: ServerResponse, status: number, message: string): void => {
    sendJson(res, status, { message });
  };

  const bearerOk = (req: IncomingMessage): boolean => {
    const auth = req.headers.authorization ?? '';
    if (expectedToken !== '') return auth === `Bearer ${expectedToken}`;
    return auth.startsWith('Bearer ') && auth.length > 'Bearer '.length;
  };

  const readBody = (req: IncomingMessage): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let tooLarge = false;
      req.on('data', (chunk: Buffer) => {
        if (tooLarge) return;
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          tooLarge = true;
          reject(new Error('request body too large'));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
        const method = req.method ?? 'GET';
        const pathname = url.pathname;

        // Health: no auth; the runner exits 0 when this answers.
        if (pathname === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // REST v3 (auth and routing inside; every /api/v3/* path is handled).
        if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
          const body = method === 'GET' || method === 'HEAD' ? null : await readBody(req);
          await handleRest(req, res, restContext, url, body);
          return;
        }

        // GraphQL v4.
        if (pathname === '/api/graphql') {
          if (method !== 'POST') {
            sendJsonError(res, 404, 'Not Found');
            return;
          }
          if (!bearerOk(req)) {
            sendJsonError(res, 401, 'Requires authentication');
            return;
          }
          const raw = await readBody(req);
          let parsed: unknown;
          try {
            parsed = raw.length ? (JSON.parse(raw.toString('utf8')) as unknown) : null;
          } catch {
            sendJson(res, 400, { data: null, errors: [{ message: 'Problems parsing JSON' }] });
            return;
          }
          const outcome = executeGraphQL(store, parsed);
          sendJson(res, outcome.status, outcome.body);
          return;
        }

        // MCP over streamable HTTP.
        if (pathname === '/mcp') {
          if (method !== 'POST') {
            sendJsonError(res, 405, 'Method Not Allowed');
            return;
          }
          if (!bearerOk(req)) {
            sendJsonError(res, 401, 'Requires authentication');
            return;
          }
          const raw = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw.toString('utf8')) as unknown;
          } catch {
            sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
            return;
          }
          const outcome = executeMcp(store, parsed);
          if (outcome.body === null) {
            res.writeHead(outcome.status, jsonHeaders());
            res.end();
            return;
          }
          sendJson(res, outcome.status, outcome.body);
          return;
        }

        // Git smart HTTP: /<owner>/<repo>.git/info/refs, /git-upload-pack, /git-receive-pack.
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1] as string);
          const repoName = decodeURIComponent(gitMatch[2] as string);
          const endpoint = gitMatch[3] as string;
          if (!bearerOk(req)) {
            sendJsonError(res, 401, 'Requires authentication');
            return;
          }
          if (owner !== store.identity.viewer.login) {
            sendJsonError(res, 404, 'Not Found');
            return;
          }
          const repo = store.getRepo(owner, repoName);
          if (!repo) {
            sendJsonError(res, 404, 'Not Found');
            return;
          }
          const sendGit = (status: number, contentType: string, body: Buffer): void => {
            res.writeHead(status, { 'Content-Type': contentType, 'X-GitHub-Request-Id': nextRequestId() });
            res.end(body);
          };

          if (endpoint === 'info/refs') {
            if (method !== 'GET') {
              sendJsonError(res, 404, 'Not Found');
              return;
            }
            const service = url.searchParams.get('service');
            if (service === 'git-upload-pack') {
              const version = req.headers['git-protocol'] === 'version=2' ? 2 : 0;
              sendGit(200, 'application/x-git-upload-pack-advertisement', advertiseUploadPack(repo, version));
              return;
            }
            if (service === 'git-receive-pack') {
              sendGit(200, 'application/x-git-receive-pack-advertisement', advertiseReceivePack(repo));
              return;
            }
            sendJsonError(res, 404, 'Not Found');
            return;
          }

          if (method !== 'POST') {
            sendJsonError(res, 404, 'Not Found');
            return;
          }
          const body = await readBody(req);
          if (endpoint === 'git-upload-pack') {
            let lines: string[];
            try {
              lines = dataLines(body);
            } catch (error) {
              sendJsonError(res, 400, error instanceof Error ? error.message : 'Malformed pkt-line stream');
              return;
            }
            if (req.headers['git-protocol'] === 'version=2') {
              const command = lines.find((line) => line.startsWith('command='))?.slice('command='.length).trim();
              if (command === 'ls-refs') {
                sendGit(200, 'application/x-git-upload-pack-result', lsRefsV2(repo, parseLsRefsArgs(lines)));
                return;
              }
              if (command === 'fetch') {
                sendGit(200, 'application/x-git-upload-pack-result', uploadPackV2(repo, parseFetchArgs(lines)));
                return;
              }
              sendJsonError(res, 400, 'Unknown git-upload-pack command');
              return;
            }
            sendGit(200, 'application/x-git-upload-pack-result', uploadPackV0(repo, parseFetchArgs(lines)));
            return;
          }

          // git-receive-pack (push).
          try {
            const result = handleReceivePack(repo, store, body);
            sendGit(200, 'application/x-git-receive-pack-result', pushReportBytes(result));
          } catch (error) {
            sendJsonError(res, 400, error instanceof Error ? error.message : 'Malformed push');
          }
          return;
        }

        sendJsonError(res, 404, 'Not Found');
      } catch (error) {
        if (!res.headersSent) {
          sendJsonError(res, 500, error instanceof Error ? error.message : 'Internal Server Error');
        } else {
          res.end();
        }
      }
    })();
  });

  return server;
}
