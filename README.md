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
  — Transcodes to HEVC (NVENC, CPU x265, or VAAPI) based on resolution and
  bitrate, and optimizes existing HEVC files to conform to its standards.
  Preserves non-video streams and can transcode audio alongside. The encoder is
  selected with the `video_encoder` input (`nvenc_hevc` / `cpu_x265` /
  `vaapi_hevc`); a single plugin covers what used to be the separate CPU variant.

> **Removed in 0.5.x:** the standalone `..._HEVC_Transcode_Optimize_CPU` and
> `..._korewaChino_Standardize_Audio_Codecs` plugins. CPU encoding is now
> `video_encoder: cpu_x265` on the main plugin, and audio standardization is its
> `transcode_audio`/`audio_codec` inputs. Nothing referenced either one.
