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
voice        |         |         |         |         |         |     
text          ▓                                                     
thinking              ▓▓                                            
toolarg                       ▓                                     
toolcall                              ▓▓▓                           
toolresult                                    ▓▓▓                   
turnend                                               ▓▓▓▓          
error                                                         ▓▓▓▓▓▓
             0.4s apart, ticks are 0.5s

   ▄▃▁▁          ▃▂▁▁▁         ▁▁            ▇▂▁▁▁         ▇▂▁▁▁         ▇▃▁▁▁▁▁▁▁    ▁█▄▂▁▁▁▁▁▁▁▁      
one column ≈ 30 ms · peak -10.4 dBFS
```

That is `/blips test`, rendered to audio and back into text by `npm run art`.

## Listen

- [`assets/blips-test.mp3`](assets/blips-test.mp3) — all seven voices, one after another
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
/blips                       status: device, mode, volume, counters
/blips on | off
/blips mode discrete|density
/blips volume 0-4
/blips test                  play all seven voices once, 2.8 s
```

Configuration is written to `~/.config/pi-blips.json`:

```json
{ "enabled": true, "mode": "discrete", "master": 1, "interactiveOnly": true }
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

## The numbers that matter

`pi` awaits `message_update` handlers *in stream order*, so anything that blocks in the handler delays token
consumption — a subprocess per token would fork 100 times a second. This extension only schedules Web Audio
nodes, which is a synchronous, O(1) call into the audio thread:

| case | cost |
|---|---|
| delta dropped by the rate gate (the common case) | **0.6 µs** |
| delta that actually sounds | **0.2-0.7 ms** |
| density mode | **0.4 µs** per delta + 12.5 flushes/s |

At the ≤22 blips/s the text floor allows, that is well under 1% of one core.

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
npm test     # 12 tests, no audio device required
```

Every test drives an `OfflineAudioContext` or a stub device, never a real output stream, so the suite runs
unchanged on a headless CI runner. Coverage is behavioural rather than decorative:

- a 100 token/s stream is throttled to the voice floor, and structural voices are never throttled
- density mode aggregates a tick into one blip instead of dropping it, gets louder and higher as throughput
  rises, and stays completely silent when idle
- a device that disappears mid-session reports one error and then goes permanently quiet, instead of throwing
  once per token
- voice peaks stay audible and below clipping; every blip fades in rather than starting at full level;
  continuous voices never step

Requires Node ≥ 22.19 (the engine is TypeScript, imported directly, so tests need native type stripping).

## Caveats

- **Output follows the system default sink.** If it is muted, nothing is audible: check `wpctl status` (Linux)
  and unmute. There is no sink selection: whatever the default is, that is where blips go.
- If the backend dies mid-session (device unplugged, sink removed), the engine reports one error, goes silent
  and closes the context. `/blips status` then shows `no device` and `/blips on` rebuilds it.
- `PI_BLIPS_VERBOSE=1` prints a per-turn counter line to stderr. It is off by default because stderr draws
  over the TUI input box; `/blips` shows the same counters on demand.
- `PI_BLIPS_LOG` appends `kind audio-clock-time weight` per blip, for debugging.

## License

MIT
