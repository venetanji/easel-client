# Easel Media MCP

Standalone TypeScript MCP server for Easel media tools. It uses the stdio transport so a local or headless agent can run the server as a child process. It does not expose an HTTP listener.

## Build and run

Requires Node.js 22+.

```sh
npm ci
npm run build --workspace=@easel/media-mcp
EASEL_BASE_URL=https://easel.ait4x.org EASEL_API_KEY=optional-secret node packages/media-mcp/dist/cli.js
```

Set `EASEL_BASE_URL` to an alternate HTTP(S) Easel endpoint if needed. `EASEL_API_KEY` is optional. Configure this command and the environment in your MCP host; stdio protocol output uses stdout and diagnostics use stderr.

Tools:
- `list_models` — list validated Easel models.
- `generate_image` — generate an image and return image content plus non-secret metadata.
- `capture_canvas_screenshot` — render offline HTML with local image assets and return a PNG.

Screenshot capture requires Playwright Chromium. Install it on the headless machine with:

```sh
npx playwright install chromium
```

The renderer caps markup at 1 MiB, accepts at most 8 local images/32 MiB, uses a fixed bounded viewport, blocks network requests, and times out after 10 seconds. Tool inputs do not accept filesystem paths or arbitrary hosts.
