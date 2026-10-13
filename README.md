# DSH Agent Control Center

Read-only browser dashboard Bundle for DeepSeek Harness Desktop `0.2.0-rc.2`.

## Development

```sh
npm install
npm run typecheck
npm test # automatically builds before running tests
```

The Bundle entry is `dist/host/index.js`; its browser entry is exported as `dsh-agent-control-center/client`. The Vite build writes the dashboard assets to `dist/web`.

## Current state

The source implements a loopback-only dashboard, pairing tokens, an authority-bound cookie, a live snapshot collector, and SSE updates. The detailed evidence and compatibility limits are in [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md).

The local Bundle was installed through the official Desktop Plugin Manager. After fixing the circular injection, the dashboard paired successfully with Desktop `0.2.0-rc.2`: the browser showed `Connected`, an initial one-agent snapshot, and token metrics. The connected indicator is driven by the SSE lifecycle, and the user confirmed that a live session update appeared on the dashboard. Build and unit tests pass. Reconnection after a stream interruption still needs live verification. See [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) for exact evidence.

The dashboard does not start, stop, or control agents. Task text is intentionally unavailable. Unknown metrics remain unavailable, and the collector marks its snapshot as partial.
