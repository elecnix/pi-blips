# pi-blips

[![CI](https://github.com/elecnix/pi-blips/actions/workflows/ci.yml/badge.svg)](https://github.com/elecnix/pi-blips/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.19-informational)](package.json)

**Hear your coding agent think.**

A [pi](https://pi.dev) extension that plays a short blip for every token the model streams, with a different
timbre per channel: output text, extended thinking, tool-call arguments, tool call, tool result, turn end and
error. You can hear when the model stops talking to itself and starts writing code, hear a tool call land, and
hear a turn end without looking at the screen.

```
            |    |    |    |    |    |    |
text        ▓
thinking      ▓
toolarg         ▓
toolcall          ▓
toolresult          ▓
turnend               ▓
error                   ▓
waitmodel                    ▓    ▓
waittool                               ▓    ▓
            one column = 0.2s, ticks are 1s, 6.4s total

 ▄▁   ▃▁▁  ▁▁    ▇▁   ▇▁   ▇▂▁▁ █▅▁▁▁        ▃▁           ▃▁           ▃▁           ▃▁
one column ≈ 77 ms · peak -10.4 dBFS
```

That is `/blips test`, rendered to audio and back into text by `npm run art`.

## Listen

- [`assets/blips-test.mp3`](assets/blips-test.mp3) — all nine voices: the seven stream blips, then the wait heartbeat at its real 1 Hz cadence
- [`assets/density-ramp.mp3`](assets/density-ramp.mp3) — density mode, with throughput climbing 5 → 100 tokens/s

## What you hear

| Channel | Trigger | Voice | Peak |
|---|---|---|---|
| `text` | `text_delta` | 740 Hz sine (≈F♯5), 50 ms | 0.30 |
| `thinking` | `thinking_delta` | 300 Hz triangle (≈D4), 90 ms | 0.22 |
| `toolarg` | `toolcall_delta` | 1250 Hz triangle rattle, 20 ms | 0.12 |
| `toolcall` | `tool_execution_start` | 500 → 800 Hz square chirp | 0.30 |
| `toolresult` | `tool_execution_end` | 900 → 450 Hz square chirp | 0.28 |
| `turnend` | `turn_end` | 1050 → 790 Hz sine, 220 ms | 0.30 |
| `error` | tool error, `stopReason` `error`/`aborted` | 170 Hz sawtooth grumble | 0.45 |
| `waitmodel` | waiting on the provider | 520/390 Hz triangle pulse, 1 Hz | 0.16 |
| `waittool` | waiting on a tool | 660/990 Hz square pulse, 1 Hz | 0.15 |

## Install

As a pi package:

```bash
pi install git:github.com/elecnix/pi-blips
```

By hand:

```bash
git clone https://github.com/elecnix/pi-blips
cp -r pi-blips/extensions/pi-blips ~/.pi/agent/extensions/
cd ~/.pi/agent/extensions/pi-blips && npm install
```

Do **one** of those, not both — two loaded copies means two blips per token, which sounds exactly as
pleasant as it sounds. Reload with `/reload` after installing or editing; pi reads extension code at startup.

`node-web-audio-api` is a native module (cpal → PipeWire/ALSA on Linux, CoreAudio on macOS, WASAPI on Windows).

## Commands

```
/blips                       status: device, mode, volume, heartbeat, counters
/blips on | off
/blips mode discrete|density
/blips volume 0-4
/blips wait on | off
/blips test                  seven voices, then the heartbeat, 6.4 s
```

Configuration is written to `~/.config/pi-blips.json`:

```json
{ "enabled": true, "mode": "discrete", "master": 1, "interactiveOnly": true, "waitBeats": true }
```

`interactiveOnly` keeps print, JSON and RPC runs silent — a headless run should not make noise.

## Why not simply one blip per token

Because token streams are much faster than ears. Measured on a real session, streaming from a cheap model:

| measured | value |
|---|---|
| median gap between `text_delta` events | **11 ms** (~90/s) |
| minimum gap between two deltas | **0 ms** (several per millisecond) |
| discrete events a human can resolve | ~20-30/s |
| blips/s the `text` floor permits | ≤22 |

At 11 ms apart, every envelope overlaps every other: a per-token blip is not a rhythm, it is a buzz. So the
voice floors are the design, not a limitation:

- **`discrete`** (default) — one blip per delta, rate limited per voice (text 45 ms, thinking 70 ms,
  tool-call arguments 50 ms). Sparse structural events are never limited: a tool call and its result can land
  a millisecond apart and both matter.
- **`density`** — a fixed 12.5 Hz clock. Each tick emits at most one aggregated blip per active streaming
  voice, with amplitude tracking the deltas since the last tick and pitch rising with throughput. In the
  ramp demo: RMS 0.0036 → 0.0071, dominant frequency 820 Hz → 1140 Hz.

## Waiting has a personality

The interesting part of a sonified agent is the silence: the seconds between submitting a prompt and the first
token, and the seconds a tool spends working. Both are now audible as a heartbeat, one beat per second,
alternating high and low — so a long wait has a pulse instead of a gap.

The two kinds of dead air get two personalities, distinguishable with your eyes closed:

| waiting on | voice | alternating | sounds like |
|---|---|---|---|
| the provider | falling triangle | 520 → 390 Hz | patient, a slow breath |
| a tool | rising square | 660 → 990 Hz | brisk, something is churning |

Details that make it behave:

- The heartbeat **starts on the beat that matters**: entering a wait state beats immediately rather than up to a
  second later, so you hear "tool started" as it happens. Redundant transitions (both `agent_start` and
  `turn_start` fire for the same wait) do not re-beat, and never arm a second pulse.
- The pulse is **anchored to the state change**, not run off a free clock. A free-running 1 Hz clock lands
  wherever it happens to be when the state changes — measured once at 22 ms after the change beat — and that
  pulse is then gated away as too close, leaving an audible hole. Anchored, the spacing inside one personality
  is a steady 1.00 s (measured 1.003 s live), and a personality switch beats immediately.
- Any streamed delta ends the wait — the provider answered. Tool calls are tracked as a **set**, because pi runs
  them in parallel: the heartbeat returns to the provider personality only when the last one has returned.
- Each personality owns its own voice, so switching between them is instant; but each has a **0.5 s floor**, so a
  tool that returns immediately cannot machine-gun over the provider's pulse.
- `agent_end` clears the pulse and leaves no pending timer, so an idle agent is genuinely silent — a tool
  cancelling late cannot resurrect a heartbeat that would then run until the next event.
- It rides the same mix bus as everything else, so `/blips volume` scales it, and `/blips wait off` disables it.

The state machine lives in `extensions/pi-blips/wait.ts`, separated from both audio and pi's event wiring. Its
clock is injectable, so the exact pulse schedule is tested with no device and no real time.

## The audio runs in a worker

`node-web-audio-api` sends every graph mutation — creating a node, connecting it, setting a parameter, calling
`start()` — over a bounded 256-slot control channel whose only drainer is the audio device callback. One blip
is about ten such messages, so when the sound card stops calling back the queue fills and the next blip blocks
its caller inside the addon, with no timeout (see
[#2](https://github.com/elecnix/pi-blips/issues/2)). On pi's main thread that call froze the agent loop and the
TUI with it.

The context, the engine and the density clock therefore live in a `worker_thread` (`worker.ts`), and the
extension only posts messages to it (`host.ts`). The token path never touches the native module, so no audio
call — however badly it behaves — can stall a stream or a repaint. If the worker does wedge, a watchdog notices
that it stopped answering, terminates it and starts a fresh context, so audio recovers when the device does. A
device that reports itself dead is not restarted into, because the failure is not the worker's.

## The numbers that matter

`pi` awaits `message_update` handlers *in stream order*, so anything that blocks in the handler delays token
consumption — a subprocess per token would fork 100 times a second. Now a handler only posts a message to the
audio worker: the per-voice rate gate and the node scheduling happen off the main thread, where a slow Web Audio
call costs a blip rather than a token. The old synchronous path measured **0.6 µs** for a delta dropped by the
gate, **0.2-0.7 ms** for one that sounded, and **0.4 µs** per delta in density mode plus 12.5 flushes/s; that
work is now the worker's.

## Levels, or: the bug that made this inaudible

Voice peaks sit around 0.3 (≈ **-10 dBFS**), deliberately in the same league as ordinary media, because a blip
competes with whatever is already playing on the output. The first version used peaks near 0.05 (-26 dBFS):
through a sink at 24% volume (-37 dB) that lands at about -63 dB, which is inaudible, and the extension was
reported broken before anyone suspected the gain. `test/voices.test.mjs` now fails if a voice peak leaves the
audible range. `/blips volume` scales the mix bus from 0 to 4, with a limiter (-10 dBFS, ratio 8) guarding the
sum of overlapping blips. Density mode sits deliberately ~4 dB below the discrete peak, since it is longer and
far more frequent.

## Tests

```bash
npm test     # 39 tests, no audio device required
```

Every test drives an `OfflineAudioContext` or a stub device, never a real output stream, so the suite runs
unchanged on a headless CI runner. Coverage is behavioural rather than decorative:

- a 100 token/s stream is throttled to the voice floor, and structural voices are never throttled
- density mode aggregates a tick into one blip instead of dropping it, gets louder and higher as throughput
  rises, and stays completely silent when idle
- a device that disappears mid-session reports one error and then goes permanently quiet, instead of throwing
  once per token
- the heartbeat is silent while nothing is pending, beats immediately on a state change without repeating,
  alternates 520 → 390 Hz (verified by DFT on the rendered audio) at one beat per second, and is rate limited
  against state flapping
- the wait state machine is tested with a recording sink and a manual clock: parallel tools hold the tool
  personality until the last one returns, redundant transitions neither re-beat nor arm a second pulse, the
  pulse is exactly 1 Hz within a personality and re-anchors on a switch, and `agent_end` leaves no pending timer
- audio runs in a worker: a wedged worker is terminated and replaced, blips are dropped once it goes quiet
  instead of piling up in its inbox, a reported-dead device is not restarted into, and the watchdog gives up
  after a bounded number of wedges
- voice peaks stay audible and below clipping; every blip fades in rather than starting at full level;
  continuous voices never step

Requires Node ≥ 22.19 (the engine is TypeScript, imported directly, so tests need native type stripping).

## Caveats

- **Output follows the system default sink.** If it is muted, nothing is audible: check `wpctl status` (Linux)
  and unmute. There is no sink selection: whatever the default is, that is where blips go.
- If the audio backend stops calling back, the worker wedges; the watchdog terminates and replaces it, so the
  session keeps running and audio comes back when the device does. If it wedges repeatedly the host gives up
  (after five replacements) and blips go silent; `/blips on` starts it again.
- `PI_BLIPS_VERBOSE=1` prints a per-turn counter line to stderr. It is off by default because stderr draws
  over the TUI input box; `/blips` shows the same counters on demand.
- `PI_BLIPS_LOG` appends `kind audio-clock-time weight` per blip, for debugging.

## License

MIT
