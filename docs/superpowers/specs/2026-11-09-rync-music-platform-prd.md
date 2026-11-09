# Rync — Music Player & Listen Together PRD

**Status:** Draft for product/build review
**Owner:** Rync
**Product:** `rync.zafir.my`
**Last updated:** 2026-11-09

## 1. Product summary

Rync is a browser-first music player for finding and playing music, then turning that same session into a shared listening room. A person can listen alone, search YouTube music, use local files or supported audio URLs, manage a personal library and queue, and invite friends to sync playback on their own devices. Every connected device is also an independently controllable speaker in the room.

The product should feel like one player with a social mode—not a speaker dashboard that happens to play tracks. The shared link opens the same Rync interface directly into the room. The host controls playback by default; room members can contribute to the queue, and the room makes the current playback state and device readiness visible.

### Product promise

> Find a track, press play, invite friends. Rync keeps the player and the room together.

### Product principles

1. **Playback first:** the current track and the next useful action are always easy to find.
2. **One queue:** personal playback and room playback use the same queue model and controls.
3. **Fast feedback:** search, add-to-queue, room join and player controls respond immediately and explain background work.
4. **Honest sync:** show measured readiness/quality; do not promise perfect synchronization across arbitrary networks, browsers or Bluetooth devices.
5. **Progressive complexity:** common listening actions stay visible; device tuning, connection diagnostics and source details stay one level deeper.
6. **Rync has a voice:** use Kuro's restraint as a reference, while giving Rync its own signal color, room identity and music-led layouts.

## 2. Problem and opportunity

Rync already has the foundations of audio playback, YouTube search/streaming, a collaborative queue, room links, signaling and WebRTC. The current product presents these as separate technical surfaces. The result is a user who has to understand connection mode, choose a source, wait for it to resolve, then figure out whether the queue or the room owns playback.

The largest experience risks are:

- Users do not know whether a track is searching, resolving, buffering, ready or failed.
- Queue changes may feel delayed or appear inconsistent across devices.
- A room can be joined before the playback path is ready, leaving members waiting without useful progress feedback.
- P2P and server fallback behavior are hard to distinguish and recover from.
- The UI's existing Spotify-inspired control surface competes with the intended clean Rync identity.
- Existing product notes contain claims such as sub-millisecond sync, “zero drift” and inaudible hardware keep-alive that are not valid universal web guarantees.

Rync can stand out by making **personal playback and multi-device listening the same continuous flow**, while being explicit about source and network constraints.

## 3. Goals and measurable success

### User goals

- Search and start a supported track without learning the streaming architecture.
- Keep a personal library, playlists, likes, history and queue available across visits on that device.
- Share a room with one link or short code and see who is ready.
- Let friends add tracks without the queue jumping or losing changes.
- Know when audio is being prepared, when playback starts, and what to do if a source or peer fails.
- Use the core player comfortably on a phone, tablet and desktop.

### Product success criteria for the first public-ready release

These are proposed acceptance targets; validate on the homeserver and representative phones before claiming them publicly.

| Measure | Target |
| --- | ---: |
| Search response, cached or provider response | p95 ≤ 2.5 s |
| Search response, uncached provider fallback | p95 ≤ 6 s, with progress and cancel available |
| Add-to-queue local feedback | ≤ 100 ms |
| Queue convergence among connected room members | p95 ≤ 1 s after server acknowledgement |
| Room join to visible room state | p95 ≤ 3 s on a healthy network |
| Room start with 2–5 devices | ≥ 95% start successfully on the supported test matrix |
| Start skew, two devices on same Wi-Fi, wired/headphone output | p95 ≤ 100 ms; publish measured results, not a guarantee |
| Recovery after a peer disconnect | state remains usable; reconnect or explicit error within 10 s |
| Core flows | 100% pass for search → play, add/reorder/remove queue, create/join/leave room, reconnect, and provider error recovery |
| Accessibility | keyboard operable, visible focus, WCAG 2.2 AA contrast for text and controls, reduced-motion support |

Performance measures must report browser/device, output type, network type, sample size and percentile. Bluetooth and backgrounded mobile tabs are separate cohorts because the platform controls their output latency and scheduling.

## 4. Non-goals and guardrails

### Not in the first release

- Building a native Android/iOS app, Android Auto, CarPlay, home-screen widgets or system media controls beyond browser support.
- Replacing a licensed music subscription or promising offline downloads from YouTube.
- Account-based cloud library sync, public profiles, social feed, chat, reactions or payments.
- A full DJ mixer, multi-room spatial audio product or room-acoustic microphone calibration.
- Automatic recommendation models that require sending personal listening history to a third party.
- Unlimited room size or an all-to-all peer topology.

### Product and provider guardrails

- YouTube search, metadata and playback must be implemented through a provider adapter with explicit source status and documented operational constraints. Do not promise indefinite availability of undocumented endpoints or extraction behavior.
- Do not bypass provider access controls, authentication, rate limits, DRM or other technical restrictions. No rotating identities, proxy rotation to evade blocks, or hidden failure suppression.
- The product must be able to disable one provider without breaking local-file playback, queue controls or room state.
- Show source attribution and link back to the provider where required. Do not describe Rync as affiliated with YouTube/Google.
- Any persistence, logging, analytics and content caching must minimize data and have a stated retention/clear-data path.

## 5. Users and primary scenarios

### Personas

1. **Solo listener:** opens Rync on a phone or laptop, finds a track, queues more, and returns to their library later.
2. **Room host:** starts a room from the current player and invites friends without rebuilding the queue.
3. **Room member:** opens a shared link, enters a display name if needed, becomes a speaker, and can add songs to the shared queue.
4. **Troubleshooter:** sees a peer has weak connectivity or a source failed and needs a direct next action, not a raw network error.

### Core journeys

#### A. First visit → first playback

1. Open `rync.zafir.my`; land on Home with prominent search and an unobstructed mini-player area.
2. Search by title/artist or paste a supported YouTube link.
3. Results show title, artist/channel, duration, source and a clear play/add action.
4. Tap Play. The row responds immediately; the player shows `Finding audio…`, then `Buffering…`, then `Playing` or a useful failure with Retry/Open source.
5. Keep browsing while the bottom mini-player remains available.

#### B. Create room from the player

1. Tap **Listen together** from the player or mini-player.
2. Rync creates the room and retains the current track, queue and play position.
3. Room sheet shows the share link/code, host role, connected device count and a clear **Copy invite** action.
4. Host can start immediately or wait for peers; no blocking countdown is required.
5. Every peer sees `Connecting → Preparing track → Ready / Needs attention` with a concise recovery action.

#### C. Join room from a shared link

1. Open `rync.zafir.my/?room=CODE`.
2. Join directly or enter a lightweight display name; do not require Google login.
3. Show room name/code, current track, who controls playback, and the member's own output status.
4. Prepare current audio in parallel with room state and signaling; do not block the UI on provider resolution.
5. If browser autoplay requires a gesture, show one **Tap to enable audio** control and preserve the pending room state.

#### D. Collaborative queue

1. Any room member can add a track and receives instant local confirmation.
2. The queue marks the current track and identifies who added each item.
3. Additions, reorder and removal converge from a server-authoritative revision; stale writes never resurrect deleted entries.
4. Host-only playback actions are clear. If queue editing is open to all, the UI must still distinguish permission for skip/reorder/removal if product policy later narrows those actions.

#### E. Failure and recovery

- Search fails: retain query; show retry and source status.
- Track resolution fails: keep queue item; offer retry or open source; do not silently skip.
- Peer connection fails: attempt relay fallback, show the chosen path, allow reconnect, and keep controls usable.
- Host disconnects: freeze new playback commands at the last acknowledged position. Transfer authority only after a candidate has the latest room revision and confirms the current source is playable (locally resolved or transferred); otherwise keep the room visible as `Host disconnected`, allow the old host to rejoin during room TTL, and let members leave/create a new room. Never silently elect an unready peer or fork room state.
- Browser suspends audio: on return, show the real playback state and offer one-tap resume/resync.

## 6. Product scope and requirements

### P0 — public-ready core

#### 6.1 Player and transport

- One shared player state model for solo and room listening: current track, play state, position, duration, repeat, shuffle, volume and source readiness.
- Play/pause, seek, previous/next, repeat, shuffle, volume/mute, like, add to queue and open full player.
- Queue actions: play now, play next, add to end, reorder, remove, clear upcoming (with undo), and empty state.
- Mini-player persists across tabs/routes and can expand to Now Playing.
- Support current server-recognized sources: YouTube search/link, supported direct audio URL, uploaded/local audio as the existing app allows. Each item has a `sourceType` and stable source ID.
- Keep output volume local to each device; the room's track/position/play state is shared.
- User playback must begin only after browser policy permits audio. Preserve the requested track and explain the single required tap.
- Add idempotency to queue mutations; repeated taps/retries must not add duplicates accidentally.

#### 6.2 Search and discovery

- Search by title, artist/channel and pasted link.
- Debounce network requests enough to protect providers while showing immediate input and cancellable in-flight state.
- Cache repeated search results briefly with provider/source metadata and a clear stale/refresh path.
- Preserve recent searches locally; allow clear.
- Search result states: idle, loading, results, empty, rate-limited, offline, provider unavailable and generic failure.
- Each result exposes source and duration; no false “official” or quality claims.
- Provide keyboard submit/escape and mobile keyboard-friendly controls.

#### 6.3 Library

- Local-first likes/favorites, playlists, recently played and queue history.
- Create/rename/delete playlist; add/remove tracks; reorder; play/shuffle all.
- Store metadata and lightweight state locally; cache audio only where permitted and with user-controlled storage limits.
- Library survives reload on the same browser profile. Account/cloud sync is out of P0.
- If storage is unavailable or cleared, explain that local library is device/browser scoped.

#### 6.4 Room and audio mesh

- Anonymous room create/join via share URL and short code.
- A room contains a stable room ID, ordered queue with revision, current source/track, authoritative playback state, host/control role, and peer readiness/status.
- One playback authority at a time. Host transfer is explicit and observable.
- Signaling/control plane: existing WebSocket/HTTP room service is authoritative for room and queue events; reconnect obtains a full snapshot plus revision before accepting mutations.
- Media plane: use WebRTC peer connection for low-latency audio transport when it can be established. Prefer a host-to-peer star topology for the first release; avoid all-to-all full mesh. If a source is reachable by each peer, let each peer resolve it and prebuffer locally; if a source is device-local or not reachable (including a local file), the host sends bounded encoded media chunks with sequence/timestamp metadata, not decoded PCM by default. Local file playback remains solo-capable; room sync requires the host to remain connected while it is the only source.
- Fallback: if WebRTC is unavailable, use the existing server audio relay/stream URL where supported; clearly indicate fallback and any expected delay. The fallback must not wait forever for P2P.
- Peer status states: joining, signaling, connecting, preparing, ready, playing, reconnecting, fallback, blocked-by-autoplay, failed and left.
- Joining peer receives a current snapshot, then only newer ordered events. Detect gaps and resync from snapshot.
- Define room expiry/cleanup and limits in configuration. P0 target: 2–5 active devices; test 2, 3 and 5. Do not imply arbitrary scale.
- Protect room operations against malformed IDs, oversized payloads, unauthorized control changes and unbounded signaling/audio buffers.

#### 6.5 YouTube and provider behavior

- Encapsulate search, metadata and stream resolution behind `MusicSource` adapters; UI and queue do not depend on yt-dlp/Innertube implementation details.
- Stream resolution is lazy: only resolve the selected/current track and a small configurable prefetch window. Never resolve every queue item at once.
- Return structured failure classes (unavailable, rate-limited, region restricted, unsupported, timeout, invalid link) and retryability.
- Show meaningful progress and allow cancellation. Use request timeouts, bounded retries with jitter, short provider caches and per-provider circuit breaking.
- Do not retry permanent errors or show success until the playable media is ready.
- Source policy and implementation must be reviewed before public launch; technical convenience is not evidence of permission.

### P1 — after core is stable

- Synced lyrics if a reliable, permitted provider is selected; allow hide/show and manual offset per device.
- Smart radio/related tracks with explicit user opt-in and clear queue insertion behavior.
- Share playlist links and import supported playlist formats.
- Installable PWA enhancements and limited playback continuity, gated by browser capabilities.
- Optional account-backed library sync after a privacy and auth design.
- Moderation controls: host can remove a peer, lock queue edits, or transfer host role.

### P2 — only after evidence of demand

- Advanced equalizer, audio normalization, crossfade, offline downloads, listening history insights, public profiles, social feed, multi-room output, acoustic calibration and native apps.
- These features must not delay reliable P0 playback, queue convergence or room recovery.

## 7. Information architecture and screen design

### Primary navigation

- **Home** — continue listening, recently played, quick picks (only where data exists), and start/resume a room.
- **Search** — search field, recent queries, result list and source indicators.
- **Library** — liked tracks, playlists, recent items and local uploads.
- **Room** — visible only while connected; device roster, room controls and shared queue access.

Persistent bottom mini-player on mobile and compact bottom playback bar on desktop. Desktop uses a left navigation rail/sidebar, central content canvas and optional right queue panel. Mobile uses a compact bottom navigation and full-screen Now Playing sheet. The room is a mode in the player, not a separate product shell.

### Screen requirements

#### Home

- Search is the strongest entry point.
- A single hero track or “Continue listening” block only appears when there is real recent playback; no filler statistic cards.
- Show a concise room CTA that starts from the current player state.

#### Search

- Results prioritize readability and one-tap actions. Artwork is optional content, not a giant repeated card grid.
- `Play` starts the item. `+` adds it to queue. Overflow contains playlist/like/open source actions.
- Result list remains stable while loading more; preserve typed query after failures.

#### Now Playing

- Large but bounded artwork, track title and artist, progress, primary transport controls and clear queue/lyrics entry points.
- The room action and output/device entry are nearby but secondary to play/pause.
- Show `source`, `buffering`, `live room` and sync-quality status as compact contextual labels.
- Queue and lyrics open as drawers/sheets anchored to their trigger. On desktop, they can occupy the side panel.

#### Queue

- Current item, upcoming items, who added them in a room, and clear separation between **Play next** and **Add to queue**.
- Reorder must work with touch and pointer; keyboard users can move an item using explicit controls.
- Optimistic state is immediate; rollback keeps the item and reports the rejected mutation rather than losing the user's intent.
- Empty queue offers search/add action. End-of-queue behavior is explicit: stop or start radio only if enabled.

#### Room / devices

- Room code/link and invite action first.
- Host badge/control ownership visible without a separate settings screen.
- Device list shows friendly name, readiness, route (P2P/relay), and concise issue/retry action.
- Advanced diagnostics show RTT, estimated skew and last sync time; label them as estimates and avoid false precision.

### Design direction — Rync

**Mood:** quiet focus with a live signal. A music-first, monochrome foundation takes Kuro's visual restraint; Rync adds a distinctive “signal” accent, room presence and tactile playback controls. It should feel considered and warm, not like a generic admin dashboard or a Spotify reskin.

**Color system:** deep ink surfaces and warm paper text in dark mode; a true light theme with soft neutral surfaces. Use one Rync signal accent (proposed: acid chartreuse) for the active playback state, live room/connection and primary action. Reserve coral/red for destructive or error states. Avoid using color alone to communicate status. Do not apply blur/glass to every surface; use it only for persistent player/navigation chrome where it separates controls from scrolling content.

**Typography:** use a high-quality system sans/variable system stack by default; compact labels in a neutral medium weight; track title gets a deliberate display scale with tight leading and optical tracking; metadata uses relaxed line height. Use tabular numerals for elapsed/remaining time. Keep titles readable at 200% zoom and dynamic text scaling.

**Layout:** content-first, generous but not wasteful spacing, aligned artwork and text, one dominant action per surface. Avoid excessive rounded cards, decorative gradients, fake metrics and oversized empty hero areas. Use the album artwork as a bounded emotional anchor in Now Playing, not a full-screen background that harms contrast.

**Interaction and motion:** press feedback begins on pointer/touch down. Sheets and player transitions are interruptible and start from their current visible position. Prefer critically damped motion; reserve slight spring for a user-driven drag release. Queue drag tracks the pointer 1:1 and supports keyboard alternatives. Under reduced-motion, replace movement with short fades; under reduced-transparency, use opaque surfaces. No perpetual visualizer animation while paused.

**Accessibility and responsive behavior:** minimum 44×44 CSS px touch targets; visible focus; semantic labels; keyboard support; captions/lyrics not color-only; safe-area padding; no horizontal overflow at 320px; test portrait/landscape, desktop resize, 200% zoom and reduced motion. Keep the mini-player above the bottom navigation and safe area.

### Interaction state table

| Situation | Required visible state | Required action |
| --- | --- | --- |
| No track / empty queue | Empty player, search CTA, no fake progress | Search or choose supported source |
| Searching | Query preserved, spinner/status, cancel if in flight | Wait, cancel, or retry |
| Resolving audio | Track metadata + `Finding audio…` | Cancel/retry/open source |
| Buffering | Progress/status and play state; do not claim playing early | Wait, cancel or switch source |
| Playing solo | Accurate controls and time; mini-player visible | Pause, seek, queue, start room |
| Room joining | Room code, peer count and step-by-step status | Retry/leave; continue browsing |
| Peer preparing | Per-device readiness list | Enable audio / retry peer |
| Room playing | Shared track/position, host, each peer status | Host controls; members queue actions |
| Reconnecting | Keep current snapshot and mark stale state | Retry / leave; avoid duplicate writes |
| Provider or peer error | Plain-language cause, retryability and source/path | Retry, alternate source or continue solo |
| Reloaded | Restore solo library and reconnect room from URL/session if valid | Rejoin/resync or discard stale session |

## 8. Technical product architecture

### Existing system to retain and rationalize

Current repository is a Node.js + vanilla JavaScript web app with a WebSocket server, room API, `CloudMesh`, `AudioEngine`, `ClockSync`, source adapters, YouTube search/stream endpoints and Vitest. Keep this stack for P0 unless a measured blocker is found. Do not rewrite the app as native or replace its core components just to match the reference app's platform.

Relevant existing entry points include `public/js/audio/AudioEngine.js`, `public/js/audio/ClockSync.js`, `public/js/network/CloudMesh.js`, `public/js/music/MusicSourceManager.js`, `public/js/music/sources/YouTubeSource.js`, `api/room.js`, `api/yt-search.js`, `api/yt-stream.js` and `server/server.js`.

### Proposed boundaries

1. **UI:** screens/components render state and dispatch user intents. They do not call provider endpoints directly.
2. **Player controller:** single state machine owns queue selection, transport, source readiness, seek and repeat/shuffle.
3. **Source adapters:** YouTube, direct URL, local/upload source implement a shared search/resolve contract with bounded retries and typed errors.
4. **Audio engine:** owns decode/buffer/playback and device-local output controls. It reports actual readiness/play state to the controller.
5. **Room service:** authoritative snapshot + revisioned queue/playback commands, peer membership and WebRTC signaling.
6. **Media transport:** WebRTC P2P where available, bounded server relay fallback. The room/control plane remains separate from audio media bytes.
7. **Persistence:** IndexedDB/local browser storage for local library and preferences; server room state expires after a documented TTL. No account requirement for P0.

### State and protocol rules

- Stable IDs: `trackId` is source-scoped; `queueItemId` is unique per queue insertion; `peerId` is ephemeral; `roomId` is non-secret and unguessable enough to reduce accidental collisions but not an access-control substitute.
- Every queue mutation includes `clientMutationId`, actor and expected revision. Server returns accepted revision or conflict snapshot. UI deduplicates mutation acknowledgements.
- Playback state contains `trackId`, `isPlaying`, `positionAtUpdateMs`, `serverTimestampMs`, `revision`, and optional scheduled start time. Peers compute position from monotonic elapsed time and resync on meaningful drift.
- Schedule a start with enough lead time for the measured connection/prebuffer state; do not use one magic delay for every network.
- Keep command/event payloads small and validate shape/size. Do not pass arbitrary provider URLs into unrestricted proxy fetches.
- Reconnection obtains the latest snapshot first, then subscribes to events after its revision. Gap means resnapshot.
- Audio data uses bounded chunks/buffers with backpressure. Drop stale media rather than allowing memory growth or audible multi-second lag.
- Telemetry default: aggregate timings and error classes, never raw search text, full URLs, audio, or personally identifying names. Any optional analytics needs explicit decision and retention policy.

### Loading and latency strategy

- Search may use a short input debounce (proposed 250 ms); submitting is immediate.
- Resolve current track immediately; prefetch at most the next 1–2 items only after current playback is stable and provider rules allow it.
- Keep source resolution, room signaling and player rendering concurrent. A failed resolver must not block queue display or room join.
- Use short bounded timeouts and retry only transient network errors. Every retry updates status and is cancellable.
- Cache metadata/search briefly; use conditional/revision-based room state rather than refetching large data on every poll.
- Instrument time-to-search-results, time-to-audio-ready, room-join time, queue propagation, WebRTC establishment, fallback rate, start skew and reconnect time.

## 9. Reliability, security, privacy and compatibility

### Reliability

- Network state is explicit: online, reconnecting, offline, stale, recovered.
- Errors are typed and handled at provider, room, signaling, audio decode and browser permission boundaries.
- No unhandled promise rejections for user-triggered actions. No indefinite spinner: all async states have timeout/cancel/retry or a clear terminal state.
- Queue ordering stays stable under concurrent additions/removals/reorders, reconnect, duplicate acknowledgement and late responses.
- Disconnect/leave is idempotent; room teardown cleans peer mappings, timers and media tracks.

### Security and privacy

- Room code/link is an invite capability, not proof of authorization to change host-only controls. Add control checks server-side.
- Sanitize titles/names and render as text. Validate all room actions and source IDs server-side.
- Protect stream proxy against SSRF, private IPs, redirect revalidation and unbounded responses; reuse existing URL security checks.
- Limit room size, request frequency, message size, provider concurrency and media buffer memory.
- Avoid exposing secrets/provider API keys to browser code. Rotate any development/example keys before public deployment.
- Explain local-only storage and provide clear history/library deletion.
- Apply YouTube/API provider policies and source attribution before public deployment.

### Supported browser baseline

- Current stable Safari iOS, Chrome Android, Chrome/Edge desktop, Firefox desktop and Safari macOS (test exact versions at release time).
- WebRTC, Web Audio and autoplay capabilities vary. Capability detection must select a supported path rather than silently failing.
- Background playback, lockscreen media controls, output device selection and wake behavior are best-effort web capabilities; do not advertise native-level guarantees.
- Network classes: same Wi-Fi, mobile data, NAT-restricted, packet loss, offline/reconnect.
- Audio outputs: built-in speakers/wired headset in P0. Bluetooth is supported as best-effort and evaluated separately in sync measurement.

## 10. Release plan and gates

### Phase 0 — foundation and product contract

- Consolidate player, queue, source and room state definitions.
- Add instrumentation and repeatable local two-browser validation.
- Document source/provider compatibility, data retention, browser support and room limits.
- **Gate:** no unsupported sync or licensing claims; critical error paths have a visible recovery state.

### Phase 1 — single-device player

- Implement responsive Home/Search/Library/Now Playing/Queue using current source adapters.
- Persist local favorites/playlists/recently played.
- Stabilize source readiness, autoplay unlock, play/pause/seek/next and queue actions.
- **Gate:** 100% core solo-flow acceptance suite; p95 targets captured for search and time-to-audio-ready.

### Phase 2 — shared room

- Create/join by share link; room snapshot and revisioned queue; member roster; playback authority; P2P media path and relay fallback; reconnect and host-drop behavior.
- **Gate:** 2–5 device matrix passes 20 consecutive runs per primary network scenario with no queue divergence or indefinite waits. Report measured sync distribution and failure categories.

### Phase 3 — public-ready polish

- Accessibility, small-screen layout, error copy, permission states, security limits, source policy, deploy/rollback notes, homeserver runbook and support diagnostics.
- **Gate:** no P0 security or data-loss issues; WCAG/accessibility review; 7-day soak or equivalent monitored test; known provider caveats documented.

### Phase 4 — optional differentiators

- Lyrics, playlist share/import, improved radio and account sync only after P0 reliability metrics are met.

## 11. Acceptance criteria

### Solo player

- A user can search, select, start, pause, seek, change volume, add next/upcoming, reorder and remove without leaving the player flow.
- Search/provider failure preserves the query and shows retryability.
- Audio only reports `Playing` once actual playback begins; buffering and browser autoplay states are distinct.
- Reload restores local library and playlist metadata on the same browser profile.
- Queue operations are deterministic, idempotent and keyboard/touch operable.

### Room and mesh

- Host creates a room and can copy a URL that joins directly to that room.
- Guest joins anonymously, sees host/current track/queue, can add a queue item, and hears playback after explicit browser unlock if required.
- All clients converge on identical queue order/revision after concurrent add, remove, reorder and reconnect scenarios.
- Starting a track does not wait for every peer to be connected; each peer joins as ready and reports its own state.
- If P2P fails, fallback starts within a bounded timeout or exposes an actionable failure; it never hangs indefinitely.
- A room started from a device-local file streams it from the host over the room media path; host transfer is offered only to a peer that independently has the same playable source, otherwise the room freezes at its last acknowledged position and reports `Host disconnected`.
- Host disconnect follows the documented transfer/freeze rule and does not create two playback authorities.
- 2, 3 and 5 devices are tested on same Wi-Fi and mixed networks; sync results include p50/p95/max and device/output details.

### Design and accessibility

- Search and player are reachable within one tap from any primary tab.
- The mini-player never overlaps bottom navigation or phone safe area.
- No horizontal scroll at 320 px width; room and queue actions remain reachable at 200% zoom.
- All interactive controls have accessible names, visible focus, minimum touch target, and a non-color status cue.
- Reduced motion/transparency/contrast preferences produce usable states.
- Every button/action in the spec has a working outcome; no decorative dead controls.

## 12. Open decisions for implementation

These do not block this PRD; resolve before the relevant phase:

1. **YouTube playback method and policy:** verify permitted/operational provider mechanism and whether the public service can support it. Keep adapter boundary so provider can be disabled or replaced.
2. **Audio media topology:** validate host-to-peer encoded WebRTC delivery against bandwidth, mobile browser and room-size targets; use existing server relay only as explicit fallback.
3. **Room lifetime:** choose default TTL, cleanup policy and whether host can lock room/queue.
4. **Identity:** decide whether members use random display names by default or are prompted to pick one; auth remains optional for P0.
5. **Sync bar:** confirm the proposed ≤100 ms same-Wi-Fi p95 target on real hardware before public wording.
6. **Theme preference:** proposed dual dark/light themes with a Rync signal accent; exact palette and wordmark should be validated in an interactive prototype before implementation.

## 13. Reference notes

- **Kuro** is used as a reference for a restrained monochrome music player, large artwork, thoughtful player/queue/lyrics layout and low-noise controls. Rync should not copy Kuro's Android-specific UI, colors, wording, claims or implementation. [Kuro repository](https://github.com/ayashiiiyo/kuro)
- **Metrolist** is used as a reference for music discovery/library breadth and listen-together as part of the player. It is an Android product; Rync is a browser-first homeserver app. [Metrolist repository](https://github.com/MetrolistGroup/Metrolist)
- YouTube API quotas and permitted access methods are operational constraints, not an implementation detail; public launch needs a verified source plan. The YouTube Data API documents a default `search.list` quota of 100 calls/day per project, while YouTube terms restrict some automated access and circumvention. [YouTube Data API quota](https://developers.google.com/youtube/data/determine_quota_cost), [YouTube Terms](https://www.youtube.com/t/terms)

## 14. Repository baseline observed while drafting

- Current app is vanilla JS + Node/WebSocket, not a native app.
- Existing code includes `AudioEngine`, `ClockSync`, `CloudMesh`, source adapters, `/api/room`, `/api/yt-search` and `/api/yt-stream`.
- Existing docs overstate universal precision and include design/architecture assumptions not proven for all clients.
- Workspace has unrelated uncommitted changes in `public/css/style.css`, `public/js/audio/AudioEngine.js` and `public/js/network/CloudMesh.js`; this PRD does not modify or reset them.
