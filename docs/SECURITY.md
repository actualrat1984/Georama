# Security model

Ge'orama opens community-made map files and asset packs, and the renderer parses them. A parser bug can therefore run untrusted script in the page. This document states what the shell guarantees when that happens, which layer provides each guarantee, how it is verified, and what is deliberately left open.

## Threat model

**Assumed attacker:** script running inside the renderer (the page at `georama://app/`), reached through a malicious map or pack.
**Protected:** the network, the main process and everything it can touch (filesystem, processes), and the IPC channel that main exposes.
**Out of scope:** a compromised main process, a local user who passes debugging flags (those exist only in tests), and kernel- or GPU-driver-level escapes.

**The app has no legitimate network use at all.** Every layer below can therefore be a flat "no", and a new network capability is a security decision (see "Changing the boundary").

## Layers

Defence in depth: each layer is meant to hold on its own. Code is in `electron/`.

| # | Layer | File | What it stops |
|---|---|---|---|
| 1 | Request allow-list: `session.webRequest.onBeforeRequest` cancels everything except credential-free `georama://app/…` (plus same-origin `blob:` and image `data:` URLs the CSP already permits; `devtools:` only with `GEORAMA_DEVTOOLS=1`). A session cancels all requests until its lockdown has completed. | `network.ts` | page, worker and shared-worker requests, subresources, preconnect |
| 2 | Fail-closed proxy: `fixed_servers` to `socks5://offline.invalid:9` with `proxyBypassRules: '<-loopback>'`, then `closeAllConnections()`. The target is a reserved unresolvable name, so no local port is ever contacted. | `network.ts` | anything that escapes layer 1, including loopback |
| 3 | WebRTC: `disable_non_proxied_udp` as a command-line switch and on every WebContents. | `network.ts` | STUN/ICE over UDP, TURN over TCP |
| 4 | Names: `host-resolver-rules` ends in `MAP * ~NOTFOUND`. A rule given on the command line stays first (first match wins), which lets the tests stand in for a DNS answer of `127.0.0.1`. | `network.ts` | hostname resolution |
| 5 | CSP on **every** response (HTML, scripts, styles, JSON, fonts, images): `default-src 'none'`, `connect-src 'self'`, `worker-src 'self' blob:`, `frame-ancestors 'none'`, … so self-hosted worker scripts carry the policy too. | `protocol.ts`, `security.ts` | script, eval, inline code, framing |
| 6 | Navigation: `will-navigate` is prevented for anything but the app, and an app document other than the editor is refused **before commit**: it never loads, the window keeps its unsaved state, and the attempt counts toward the rate limit. A guard also watches the main frame's **committed** navigations (such as `about:blank`) and every child-frame navigation **attempt**; a violation there closes that window and opens a fresh editor. Popups are denied, `<webview>` is refused. Only the editor document may ever commit in the main frame, and the app has no frames at all. Three violations per 60 s are recovered from; the fourth exits the process. | `security.ts`, `navigation-guard.ts`, `main.ts` | a second app document, `about:blank`, `srcdoc`/URL frames |
| 7 | IPC authority is evaluated per call: the sender must be the WebContents the app created, the frame must be its main frame, and the frame URL must be exactly `georama://app/index.html` (hash ignored). | `ipc.ts` | other documents, other WebContents, subframes |
| 8 | Protocol handler: GET/HEAD only, realpath containment inside the renderer build, single-descriptor open (`O_NONBLOCK\|O_NOFOLLOW`) with stat and a bounded read from the same handle, aggregate in-flight budget (64 MiB / 16 reads, 503 when exhausted), path-free errors, `nosniff`, `no-store`, bounded URL and path lengths (414), UI files capped at 16 MiB (413), `Range` deliberately ignored. | `protocol.ts` | traversal, symlink escape, FIFO stall, post-stat growth, concurrent-read exhaustion |
| 9 | Permissions and spellcheck: every permission request and check is denied; the spellchecker has no language, so no dictionary is ever downloaded. | `security.ts` | prompts, a start-up request to a CDN |

Why the main frame is judged on *commits*: `did-start-navigation` also fires for attempts that `will-navigate` then cancels (a dropped file, an external link). Recovering from those would throw away unsaved editor state for something already harmless. Child frames are judged on attempts, because only the page itself can create one and the app has none; CSP (`default-src 'none'`) blocks URL frames, while `about:blank` and `srcdoc` frames, which CSP does not cover, commit and are caught.


## Native Windows filesystem support — staged guarantee

Windows selected-map and configuration reads are separate from Georama's root-confined asset reading. The asset and PCK readers still require Linux descriptor-relative filesystem semantics and explicitly refuse native Windows before performing filesystem I/O. Recognizing a configured Windows Wonderdraft folder does not authorize asset reads.

Windows path validation accepts only normalized drive-qualified absolute paths, rejecting ambiguous device, share, stream and relative forms. It provides path syntax screening, not filesystem confinement.

The selected-file reader is intended for trusted explicit local selections. It keeps a single open file handle during bounded reads, checks file type and metadata, and performs a preliminary Windows symbolic-link leaf check. That preliminary check does **not** provide the same atomic no-follow guarantee as the Linux version. This limitation is acceptable only for the current direct-selected-file use, which is not available to untrusted renderer IPC. It is not sufficient for implementing confined asset-pack reads.

A subsequent Windows asset backend requires independent security review and native tests for links, junctions, path replacement, archive consistency, size limits, concurrent reads and cleanup. The existing Linux backend remains unchanged.

## How it is verified

* `npm test`: unit tests for the allow-list (table of 25+ URLs), the ordering of the network lockdown against window creation, the navigation guard (fake clock, rate limit, hash changes), `isTrustedSender`, the protocol core (traversal variants, symlinks, HEAD without a body read, 405/413/414, headers on every response), and the **wiring** of `registerIpc` and `installSecurity` with Electron mocked, so removing a check turns a test red.
* `npm run build && node tests/e2e/boundary.mjs`: launches the real hidden app from a **disposable copy** of the build under `$TMPDIR` and attacks it from a same-origin external script, with loopback HTTP, TCP and UDP listeners that count what reaches them. It never touches the repo, writes its report to `$TMPDIR`, and exits 0 only when no probe fails. A positive control proves the listeners count; afterwards their counters must read zero. NetLog is captured for every launched app and analysed at the end.
* `node tests/e2e/smoke.mjs` (via `npm run e2e`) and `node tests/e2e/cleanup.mjs` cover the baseline hardening and process cleanup.

Last measured on the commit that introduced this file: 105 boundary probes, all passing in three consecutive runs (one of them, `WebRTC closed UDP/TCP ports`, is an observation that asserts only that the app survives; it counts toward the 105 but proves no denial); the fixture counters read 0 HTTP requests, 0 TCP connections and 0 UDP datagrams from any of the ten launches; across those launches NetLog (201 events) shows 0 non-app URL requests that reached the network stack, 0 TCP connect attempts and 0 name resolutions, plus 3 `connect()` calls on a UDP socket to Chromium's IPv6 reachability probe address (`[2001:4860:4860::8888]`), which sends no packet. The idle NetLog of a freshly started app has 12 events and no URL request, socket or resolver activity, so Chromium's background-networking switches are deliberately **not** added; before the spellchecker was given an empty language list it asked a CDN for a dictionary at start-up, which is how that was found. Revisit if a NetLog ever shows otherwise.

## Changing the boundary

A new permission, ambient global (see `docs/DEV.md`), URL scheme, network capability, IPC channel, window or frame needs a recorded decision before it lands: what it is for, what an attacker in the page could do with it, which layer limits that, and a boundary-suite probe that fails without the limit. Extend the allow-list or the guard in the same change, never around it.

## Accepted risks and limits

* **In-process checks cannot prove that no DNS packet leaves the machine** (other Chromium subsystems, OS resolvers). The layers above deny names and sockets and the NetLog shows none, but an absolute guarantee needs OS-level isolation, for example a network namespace or a firewall rule that denies egress for the app. That is an optional future hardening and is not implemented.
* **A violating document lives briefly.** Navigations to `about:blank` or a frame are observed when they commit, not prevented; the guard destroys the window within milliseconds. A second app document is refused before it commits, so it never gets a document at all. In that time the page still has no network (layers 1–4) and no IPC authority (layer 7).
* **Any frame destroys the window.** The editor has no frames. A future feature that needs one must extend the guard with a recorded decision.
* **Rate limit:** a fourth violation within 60 seconds exits the app with status 1. This prefers availability of the guarantee over availability of the window.
* The protocol handler serves UI resources only. Large assets will get a separate, bounded reader.
* **Renderer tree trust:** the installed renderer tree is assumed immutable to the local user. Realpath containment does not cover hard links into the tree, and a local writer racing file replacement (including the parent-directory symlink window) is out of scope.
* **Read budget scope:** the aggregate budget bounds concurrent asset reads, not the lifetime of response bodies: a served `Response` retains its buffer until the renderer consumes it.
