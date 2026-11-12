# Cappy's Tdarr plugins

This is a collection of my plugins for [Tdarr](https://tdarr.io) that I created for my own personal use.

Most of these are forked from the original plugins and modified to suit my needs.

## Installation

Copy the contents of the `plugins` folder to your Tdarr plugins folder, maybe in the `Local` folder so
it gets picked up by Tdarr. That's it!

You may also simply create a file with the same name as the plugin and then just edit the file in the webapp.

## Plugins

All plugins are classic (v2) `Tdarr_Plugin_*` plugins, loaded as `Local` plugins
from `Tdarr/Plugins/Local/` on the tdarr server.

- **Cappy's HEVC Transcode/Optimization** (`Tdarr_Plugin_korewaChino_HEVC_Transcode_Optimize`)
  — Transcodes to HEVC (NVENC, CPU x265, or VAAPI) or AV1 (CPU SVT-AV1)
  based on resolution and bitrate, and optimizes existing HEVC files to conform
  to its standards. Preserves non-video streams and can transcode audio
  alongside. The encoder is selected with the `video_encoder` input
  (`nvenc_hevc` / `cpu_x265` / `vaapi_hevc` / `cpu_av1`); a single plugin covers
  what used to be the separate CPU variant.

### AV1 output (0.6.0)

`video_encoder: cpu_av1` uses SVT-AV1 with `av1_preset` (0-13, default 8) and
`av1_crf` (default 40). AV1 is CRF-only, so `-b:v`/`-maxrate` are omitted and
`disable_bitrate_reduction` is ignored. Leave `force_8bit` off for 10-bit AV1
(`yuv420p10le`); it defaults on for the HEVC encoders.

`force_reencode` bypasses the existing HEVC/AV1 skip logic so a batch can
re-encode sources that are already below the bitrate target. Without it, AV1
sources are skipped and HEVC sources keep the old behaviour. Use
`force_reencode: true` with `video_encoder: cpu_av1` for a full-library AV1
conversion.

> **Removed in 0.5.x:** the standalone `..._HEVC_Transcode_Optimize_CPU` and
> `..._korewaChino_Standardize_Audio_Codecs` plugins. CPU encoding is now
> `video_encoder: cpu_x265` on the main plugin, and audio standardization is its
> `transcode_audio`/`audio_codec` inputs. Nothing referenced either one.

### Opus mapping family (0.5.4)

Opus audio transcoding used to hardcode `-mapping_family 1` for any stream with
more than two channels. That fails the whole ffmpeg run — exit 234, "Invalid
channel layout" — on **height-based layouts** like 7.1.4 Atmos, because family 1
has no entry that carries height channels: its 8-channel slot is 7.1 rear
surrounds only.

Measured on ffmpeg 7.1.4 against a real E-AC3 8ch file
`FL+FR+FC+LFE+SL+SR+TFL+TFR`:

| layout | `-mapping_family 1` | `-mapping_family 255` |
|---|---|---|
| 7.1.4 (height) | **FAIL, exit 234** | OK, round-trips as 7.1.4 |
| 7.1 | OK | OK |
| 7.1(wide) | OK (→ `7.1`) | OK |
| 6.1 / 5.1 / 5.1(side) / 5.0 / quad / 2.1 | OK | OK |

The plugin now picks the family per stream: **1** only when the layout is exactly
one of family 1's fixed table entries, **255** (discrete) otherwise, which
accepts any channel count and preserves every channel — including the heights
that a downmix would silently drop. Matching is exact, not substring, because
`7.1(wide)` contains `7.1`.
