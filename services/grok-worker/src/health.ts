// SPDX-License-Identifier: AGPL-3.0-only

import { createServer, type Server } from 'node:http';
import { renderPreviewHtml, type PreviewDraft } from './preview.ts';

export function startHealthServer(options: {
  host: string;
  port: number;
  preview: boolean;
  listDrafts?: () => Promise<PreviewDraft[]>;
}): Promise<Server> {
  const server = createServer((request, response) => {
    const path = request.url?.split('?')[0];
    if (path === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          status: 'ok',
          publishing: false,
          preview: options.preview,
        })
      );
      return;
    }
    if (!options.preview || !options.listDrafts) {
      response.writeHead(404);
      response.end();
      return;
    }
    if (path !== '/' && path !== '/drafts.json') {
      response.writeHead(404);
      response.end();
      return;
    }
    void options.listDrafts!()
      .then((drafts) => {
        if (path === '/drafts.json') {
          response.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          response.end(JSON.stringify({ preview: 'local-mock', publishing: false, drafts }));
          return;
        }
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        response.end(renderPreviewHtml(drafts));
      })
      .catch(() => {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Preview failed to read local drafts');
      });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => resolve(server));
  });
}
