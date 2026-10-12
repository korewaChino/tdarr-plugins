/* eslint-disable */

const details = () => ({
  id: "Tdarr_Plugin_korewaChino_HEVC_Transcode_Optimize",
  Name: "Transcode to HEVC or optimize existing HEVC files - Tiered based on resolution and bitrate (HW/SW)",
  Type: "Video",
  Operation: "Transcode",
  Description:
    "Transcode to HEVC (NVENC or CPU x265) based on resolution & bitrate; preserves non-video streams and can optimize existing HEVC.",
  Version: "0.5.3",
  Link: "https://github.com/korewaChino/tdarr-plugins",
  Inputs: [
    {
      name: "transcode_preset",
      type: "string",
      defaultValue: "slow",
      inputUI: {
        type: "dropdown",
        options: [
          "veryslow",
          "slower",
          "slow",
          "medium",
          "fast",
          "faster",
          "veryfast",
          "superfast",
          "ultrafast",
        ],
      },
      tooltip:
        "Choose the encoder speed/quality preset (passed to selected encoder).",
    },
    {
      name: "video_encoder",
      type: "string",
      defaultValue: "nvenc_hevc",
      inputUI: {
        type: "dropdown",
        options: [
          "nvenc_hevc", // hevc_nvenc
          "cpu_x265", // libx265 fallback
          "vaapi_hevc", // hevc_vaapi
        ],
      },
      tooltip: "Select HEVC encoder implementation (NVENC GPU or CPU x265).",
    },
    {
      name: "hardware_decode_mode",
      type: "string",
      defaultValue: "auto",
      inputUI: {
        type: "dropdown",
        options: ["auto", "off", "force"],
      },
      tooltip:
        "Hardware decoding mode. NVENC: auto = use CUVID/CUDA if available, off = software decode, force = always attempt. VAAPI: auto = software decode + hwupload (recommended), off = pure software decode with no VAAPI device context initialised (use if hwupload causes artifacts), force = use VAAPI hardware decoder.",
    },
    {
      name: "vaapi_device",
      type: "string",
      defaultValue: "/dev/dri/renderD128",
      tooltip:
        "VAAPI device path (e.g., /dev/dri/renderD128). Used when video_encoder is vaapi_hevc.",
    },
    {
      name: "nvenc_safe_mode",
      type: "boolean",
      defaultValue: false,
      tooltip:
        "Enable conservative NVENC settings (omit advanced AQ flags) for older / limited GPUs or when encountering 'Temporal AQ not supported'.",
    },
    {
      name: "keep_attached_pics",
      type: "boolean",
      defaultValue: false,
      tooltip:
        "Copy embedded cover art / attached picture streams instead of dropping them. Disable to skip them for leaner outputs. Note: Some attached pictures with invalid parameters may be automatically skipped to prevent encoding errors.",
    },
    {
      name: "transcode_audio",
      type: "boolean",
      defaultValue: true,
      tooltip:
        "Transcode all audio streams instead of copying them (uses audio_codec target).",
    },
    {
      name: "audio_codec",
      type: "string",
      defaultValue: "libopus",
      inputUI: {
        type: "dropdown",
        // Use FFmpeg encoder names
        options: [
          "libopus",
          "aac",
          "ac3",
          "eac3",
          "flac",
          "libvorbis",
          "libmp3lame",
        ],
      },
      tooltip: "Target codec for audio transcoding when enabled.",
    },
    {
      name: "audio_vbr",
      type: "boolean",
      defaultValue: true,
      tooltip:
        "Enable Variable Bitrate (VBR) for audio where supported. Opus: -vbr on. AAC/MP3/Vorbis: use VBR quality (qscale). AC3/EAC3/FLAC ignore this.",
    },
    {
      name: "preserve_chroma",
      type: "boolean",
      defaultValue: false,
      tooltip:
        "If source pixel format uses higher chroma subsampling (4:4:4 or 4:2:2), attempt to preserve it instead of forcing 4:2:0. Conservative approach for NVENC (8-bit 4:4:4 only), full support for x265. May cause encoding failures on some systems. Ignored when force_8bit is enabled.",
    },
    {
      name: "force_8bit",
      type: "boolean",
      defaultValue: true,
      tooltip:
        "Force 8-bit output regardless of source bit depth. Recommended: standardizes output to 8-bit (yuv420p for x265/NVENC, nv12 for VAAPI) and avoids encoder failures on hardware that lacks 10-bit HEVC encoding support (e.g. VAProfileHEVCMain10 not available). Overrides preserve_chroma. Disable only if your hardware supports 10-bit HEVC encoding and you want to preserve bit depth.",
    },
    {
      name: "vaapi_align16",
      type: "boolean",
      defaultValue: true,
      tooltip:
        "Pad frame height to the next multiple of 16 before VAAPI hwupload, then crop back in the encoded stream. Required for AMD VCE/VCE2 hardware which silently pads frames to a 16-pixel boundary and leaves the padding rows as green/garbage. Safe to leave on for all VAAPI hardware — Intel ignores the no-op pad and AMD needs it. Disable only if you observe padding artefacts introduced by the crop itself.",
    },
    {
      name: "vaapi_qp",
      type: "string",
      defaultValue: "32",
      tooltip:
        "VAAPI quantizer. Higher values produce smaller files at lower quality. Only used when video_encoder is vaapi_hevc. Default 32 is very aggressive for VAAPI while still looking acceptable on this workflow; set 29 or 27 if you want to retain more detail.",
    },
    {
      name: "vaapi_bitrate_multiplier",
      type: "string",
      defaultValue: "0.70",
      tooltip:
        "Multiplier applied to the computed VAAPI target bitrate and maxrate after the normal resolution-tier logic. Lower values compress more aggressively. 1.0 keeps the old generic bitrate tiers; default 0.70 is tuned to improve VAAPI size reduction while keeping acceptable quality.",
    },
    {
      name: "disable_bitrate_reduction",
      type: "boolean",
      defaultValue: false,
      tooltip:
        "When enabled, the plugin will not reduce video bitrate below the original file's bitrate. Useful when transcoding from codecs like AV1 (which have different compression efficiency than HEVC) where bitrate reduction would cause quality loss. The original bitrate will be used as the target, with maxrate set to 1.5x.",
    },
  ],
});

// Helper to get main video stream
function getVideoStream(streams) {
  return streams.find(
    (s) => s.codec_type && s.codec_type.toLowerCase() === "video",
  );
}

// Determine decoder / early exit logic.
function determineDecoder(file) {
  const vc = (file.video_codec_name || "").toLowerCase();
  let log = "";
  switch (vc) {
    case "hevc":
      log += "☑File is already in hevc! \n";
      return { skip: false, presetPrefix: "", log };
    case "vp9":
      log += "☑File is already in vp9! \n";
      return { skip: true, presetPrefix: "", log };
    default:
      log += "☑File is not in a supported codec, decoding with GPU/CPU! \n";
      return { skip: false, presetPrefix: "", log };
  }
}

function appendFilter(vf, add) {
  if (!add) return vf;
  if (!vf) return ` -vf "${add}"`;
  const match = vf.match(/-vf\s+"(.*)"/);
  if (match && match[1]) {
    return ` -vf "${match[1]},${add}"`;
  }
  return `${vf} -vf "${add}"`;
}

function parsePositiveFloat(value, fallback) {
  const parsed =
    typeof value === "number" ? value : parseFloat(String(value).trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePositiveInt(value, fallback) {
  const parsed =
    typeof value === "number" ? value : parseInt(String(value).trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function roundBitrateKbps(value, step = 50) {
  if (!Number.isFinite(value) || value <= 0) return step;
  return Math.max(step, Math.round(value / step) * step);
}

// --- Static configuration objects (moved outside plugin for readability) ---
// CUVID decoder mapping for NVENC hardware decode
const CUVID_DECODER_MAP = Object.freeze({
  h264: "h264_cuvid",
  hevc: "hevc_cuvid",
  mpeg2: "mpeg2_cuvid",
  mpeg1: "mpeg1_cuvid",
  vc1: "vc1_cuvid",
  vp8: "vp8_cuvid",
  mjpeg: "mjpeg_cuvid",
  h263: "h263_cuvid",
});

// Image codecs that should be copied as attachments rather than transcoded
const IMAGE_CODECS = Object.freeze([
  "mjpeg",
  "png",
  "bmp",
  "tiff",
  "gif",
  "jpeg",
  "mjpg",
]);

// Encoder profiles (hardware & software HEVC encoders)
const ENCODER_PROFILES = Object.freeze({
  nvenc_hevc: {
    codec: "hevc_nvenc",
    pix_fmt: "p010le",
    supportsX265Params: false,
    qualityFlag: "-cq",
    qualityValue: 26,
    // Removed temporal-aq due to compatibility issues on some drivers/GPUs
    baseFlags: "-qmin 0 -rc-lookahead 32 -spatial-aq 1 -aq-strength 8 -a53cc 0",
  },
  cpu_x265: {
    codec: "libx265",
    pix_fmt: "yuv420p10le",
    supportsX265Params: true,
    qualityFlag: "-crf",
    qualityValue: 26,
  },
  vaapi_hevc: {
    codec: "hevc_vaapi",
    pix_fmt: "nv12",
    supportsX265Params: false,
    qualityFlag: "-qp",
    qualityValue: 26,
    baseFlags: "-rc_mode VBR",
  },
});

// Resolution-tier configuration table
const RESOLUTION_CONFIGS = Object.freeze([
  {
    match: ["480p", "576p"],
    bitrateCheck: 1000000,
    adaptive: { multiplier: 0.8, divisor: 1000, add: 500 },
    defaults: { target: 1000, max: 1500 },
    fixedMaxRateValue: 1500,
    qualityOverride: 27,
  },
  {
    match: ["720p"],
    bitrateCheck: 2500000,
    adaptive: { multiplier: 0.8, divisor: 1000, add: 2000 },
    defaults: { target: 2000, max: 4000 },
    qualityOverride: 27,
  },
  {
    match: ["1080p"],
    bitrateCheck: 3500000,
    adaptive: { multiplier: 0.8, divisor: 1000, add: 3500 },
    defaults: { target: 5500, max: 12000 },
    qualityOverride: 27,
  },
  {
    match: ["4KUHD"],
    bitrateCheck: 14000000,
    adaptive: { multiplier: 0.7, divisor: 1000, add: 12000 },
    defaults: { target: 18000, max: 25000 },
    qualityOverride: 29,
  },
]);

// Stream processing helper: determines mapping, subtitle copy flags, mux queue, and (optionally) attached pictures.
function processStreams(streams = [], options = {}) {
  const {
    keepAttachedPics = true,
    transcodeAudio = true,
    targetAudioCodec = "libopus",
    audioVBR = true,
  } = options;
  let subcliLocal = ""; // audio handled separately now
  let maxmuxLocal = "";
  // Collect input indexes for all non-attached video streams (to transcode)
  const videoInIndexes = [];
  // Collect input indexes for attached pictures (to copy optionally)
  const attachedPicInIndexes = [];
  // Ordinals among input video streams (v:0, v:1, ...) for non-attached videos
  const videoInOrdinals = [];
  // Keep a running ordinal for all input video streams
  let videoOrdinal = 0;
  let audioStreamCount = 0;
  const audioIndexes = [];
  // Store audio stream metadata for channel layout handling
  const audioStreamInfo = [];
  let log = "";
  try {
    let subtitleDetected = false;
    streams.forEach((s, idx) => {
      try {
        const name = (s.codec_name || "").toLowerCase();
        const type = (s.codec_type || "").toLowerCase();
        const disposition = s.disposition || {};
        if (type === "subtitle") {
          if (!subtitleDetected) {
            subtitleDetected = true;
            log += "☑ Subtitle streams detected (copy all text & bitmap).\n";
            subcliLocal = "-c:s copy -c:t copy -c:d copy";
          }
        }
        if (type === "audio") {
          audioStreamCount += 1;
          audioIndexes.push(idx);
          // Capture channel layout and channel count for Opus compatibility handling
          audioStreamInfo.push({
            index: idx,
            channels: s.channels || 0,
            channelLayout: (s.channel_layout || "").toLowerCase(),
          });
        }
        if (
          name === "truehd" ||
          (name === "dts" && (s.profile || "").toLowerCase() === "dts-hd ma") ||
          (name === "aac" &&
            (s.sample_rate || "").toString() === "44100" &&
            type === "audio")
        ) {
          maxmuxLocal = " -max_muxing_queue_size 9999";
        }
        // Attached pictures
        const isImageCodec = IMAGE_CODECS.includes(name);
        if ((type === "video" && disposition.attached_pic === 1) || isImageCodec) {
          // Skip attached pictures with invalid parameters that could cause encoding issues
          if (!s.width || !s.height || s.width <= 0 || s.height <= 0) {
            const reason = isImageCodec ? "image codec" : "attached picture";
            log += `⚠ Skipping ${reason} stream ${idx} (${name}) due to invalid dimensions.\n`;
            // Even if skipped for copy, still advance video ordinal counter
            videoOrdinal += 1;
            return; // skip this stream for mapping
          }
          if (keepAttachedPics) {
            attachedPicInIndexes.push(idx);
            const reason = isImageCodec ? "image codec" : "attached picture";
            log += `☑ Detected ${reason} stream ${idx} (${name}); will copy.\n`;
          } else {
            const reason = isImageCodec ? "image codec" : "attached picture";
            log += `ⓘ Dropping ${reason} stream ${idx}.\n`;
          }
          videoOrdinal += 1;
          return; // do not treat as main video
        }
        // Regular (moving) video streams to transcode
        if (type === "video" && disposition.attached_pic !== 1) {
          videoInIndexes.push(idx);
          videoInOrdinals.push(videoOrdinal);
          videoOrdinal += 1;
        }
      } catch (_) {
        /* ignore per-stream errors */
      }
    });
  } catch (err) {
    log += `⚠ Error scanning streams: ${err}\n`;
  }
  let map = "-map 0"; // fallback if nothing found
  if (videoInIndexes.length > 0) {
    // Map all non-attached video streams first so they become v:0..v:n in the output
    map = videoInIndexes.map((i) => `-map 0:${i}`).join(" ");
    // Then map attached pictures explicitly as video streams (they have codec_type=video in MKV)
    if (keepAttachedPics && attachedPicInIndexes.length > 0) {
      map += " " + attachedPicInIndexes.map((i) => `-map 0:${i}`).join(" ");
    }
    // Then map all audios/subs/etc
    map += " -map 0:a? -map 0:s? -map 0:t? -map 0:d?";
    // Note: Attached pictures are mapped explicitly above; -c:v copy handles them
    log += `☑ Mapping ${videoInIndexes.length} non-attached video stream(s): [${videoInIndexes.join(", ")}].\n`;
    if (keepAttachedPics && attachedPicInIndexes.length) {
      log += `☑ Will copy ${attachedPicInIndexes.length} attached picture stream(s).\n`;
    }
  } else {
    log += "⚠ No valid non-attached video streams found, skipping mapping.\n";
  }

  // Build audio flags now (transcode or copy).
  let audioFlags = "";
  if (audioStreamCount > 0) {
    if (transcodeAudio) {
      for (let i = 0; i < audioStreamCount; i += 1) {
        let perStream = ` -c:a:${i} ${targetAudioCodec}`;
        const streamMeta = audioStreamInfo[i] || {};
        const channels = streamMeta.channels || 0;
        const layout = streamMeta.channelLayout || "";

        // Handle Opus channel layout compatibility
        // libopus with default mapping_family (-1) only supports mono, stereo, and standard surround layouts
        // 5.1(side), 6.1, 7.1(wide), etc. require mapping_family 1 (Vorbis channel mapping)
        if (targetAudioCodec === "libopus") {
          // Problematic layouts that need mapping_family 1:
          // - 5.1(side) - side surround instead of rear
          // - Any layout with more than 2 channels that isn't standard 5.1/7.1
          // - Layouts with "side" designation
          const needsMappingFamily1 =
            layout.includes("side") ||
            layout.includes("wide") ||
            (channels > 2 &&
              !["5.1", "7.1", "quad", "5.0", "4.0", "6.1", "7.0"].some(
                (std) => layout.includes(std) && !layout.includes("side"),
              ));
          // For channels > 2, always use mapping_family 1 to be safe with various layouts
          if (channels > 2 || needsMappingFamily1) {
            perStream += " -mapping_family 1";
            log += `☑ Audio stream ${i}: Using Opus mapping_family 1 for layout "${layout}" (${channels}ch).\n`;
          }
        }

        if (audioVBR) {
          const tc = targetAudioCodec;
          if (tc === "libopus") {
            perStream += " -vbr on";
          } else if (tc === "aac") {
            // Native AAC VBR using quality scale (approx. ~160kbps at 2)
            perStream += ` -q:a:${i} 2`;
          } else if (tc === "libvorbis") {
            // Vorbis VBR quality 5 (~160kbps)
            perStream += ` -q:a:${i} 5`;
          } else if (tc === "libmp3lame") {
            // MP3 VBR (V2 equivalent)
            perStream += ` -q:a:${i} 2`;
          }
        }
        audioFlags += perStream;
      }
      log += `☑ Transcoding ${audioStreamCount} audio stream(s) to ${targetAudioCodec}${audioVBR ? " with VBR where supported" : ""}.\n`;
    } else {
      audioFlags = " -c:a copy";
      log += "☑ Copying all audio streams.\n";
    }
  }
  return {
    map,
    subcli: subcliLocal,
    maxmux: maxmuxLocal,
    videoInIndexes,
    videoInOrdinals,
    attachedPicInIndexes: keepAttachedPics ? attachedPicInIndexes : [],
    audioStreamCount,
    audioFlags,
    log,
  };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const plugin = (file, librarySettings, inputs, otherArguments) => {
  const lib = require("../methods/lib")();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars,no-param-reassign
  inputs = lib.loadDefaultValues(inputs, details);

  // State vars
  let transcode = false;
  let bitrateprobe = 0;
  let bitratetarget = 0;
  let bitratemax = 0;
  let bitratecheck = 0;
  let subcli = ""; // subtitle copy flags inserted by stream processor; audio handled separately
  let maxmux = "";
  let map = "-map 0"; // refined by helper
  let vfFilter = ""; // optional video filter (e.g., fix odd dimensions)
  let videoBitstreamFlags = "";
  const transcode_preset = inputs.transcode_preset;
  const selectedEncoder = inputs.video_encoder || "nvenc_hevc";
  const hwDecodeMode = inputs.hardware_decode_mode || "auto";
  const nvencSafeMode =
    inputs.nvenc_safe_mode === true || inputs.nvenc_safe_mode === "true";
  const vaapiDevice = inputs.vaapi_device || "/dev/dri/renderD128";
  const vaapiQp = parsePositiveInt(inputs.vaapi_qp, 32);
  const vaapiBitrateMultiplier = parsePositiveFloat(
    inputs.vaapi_bitrate_multiplier,
    0.7,
  );
  const disableBitrateReduction =
    inputs.disable_bitrate_reduction === true ||
    inputs.disable_bitrate_reduction === "true";
  const nodeHW = (
    (otherArguments && otherArguments.nodeHardwareType) ||
    ""
  ).toLowerCase();
  const ffProbeStreams =
    file && file.ffProbeData && Array.isArray(file.ffProbeData.streams)
      ? file.ffProbeData.streams
      : [];
  const firstStreamCodec =
    ffProbeStreams[0] && ffProbeStreams[0].codec_name
      ? ffProbeStreams[0].codec_name.toLowerCase()
      : "";
  const videoStream = getVideoStream(ffProbeStreams) || {};
  // Detect if there are multiple video streams and/or image-like streams (attached pictures)
  let videoStreamCount = 0;
  let hasAttachedPicture = false;
  let hasImageVideoStream = false; // attached pic or image codecs like mjpeg/png/etc
  try {
    ffProbeStreams.forEach((s) => {
      if ((s.codec_type || "").toLowerCase() === "video") {
        videoStreamCount += 1;
        const disp = s.disposition || {};
        const codec = (s.codec_name || "").toLowerCase();
        if (disp.attached_pic === 1) hasAttachedPicture = true;
        // Consider typical image codecs in containers (rare outside attached pics, but be safe)
        if (
          disp.attached_pic === 1 ||
          IMAGE_CODECS.includes(codec)
        ) {
          hasImageVideoStream = true;
        }
      }
    });
  } catch (_) {
    /* noop */
  }

  const encoderConf =
    ENCODER_PROFILES[selectedEncoder] || ENCODER_PROFILES.nvenc_hevc;
  const target_codec = encoderConf.codec;
  let pix_fmt = encoderConf.pix_fmt;

  const response = {
    processFile: false,
    preset: "",
    container: ".mkv",
    handBrakeMode: false,
    FFmpegMode: false,
    reQueueAfter: true,
    infoLog: "",
    maxmux: false,
    // debugData: {
    //   file: file,
    //   librarySettings: librarySettings,
    //   inputs: inputs,
    //   otherArguments: otherArguments,
    // },
  };

  // response.infoLog += `DEBUG inputs: ${JSON.stringify(inputs)}\n`;
  // response.infoLog += `DEBUG otherArguments keys: ${Object.keys(otherArguments || {}).join(", ")}\n`;
  // response.infoLog += `DEBUG file keys: ${Object.keys(file || {}).join(", ")}\n`;
  // response.infoLog += `DEBUG ffProbeData: ${file && file.ffProbeData ? "present" : "missing"}; streams=${file && file.ffProbeData && Array.isArray(file.ffProbeData.streams) ? file.ffProbeData.streams.length : "n/a"}\n`;

  const preserveChroma =
    inputs.preserve_chroma === true || inputs.preserve_chroma === "true";
  const force8bit =
    inputs.force_8bit === true ||
    inputs.force_8bit === "true" ||
    inputs.force_8bit === undefined; // default true when not yet set on older configs

  // Apply 8-bit normalization. This runs before preserve_chroma so that force_8bit wins.
  // VAAPI: nv12 is universally supported (VAProfileHEVCMain). p010le requires
  //   VAProfileHEVCMain10 which is absent on many GPUs — always safe to use nv12.
  // NVENC: default profile is p010le (10-bit); normalise to yuv420p for 8-bit output.
  // x265:  default profile is yuv420p10le; normalise to yuv420p for 8-bit output.
  if (force8bit) {
    if (selectedEncoder === "vaapi_hevc") {
      pix_fmt = "nv12";
    } else if (selectedEncoder === "nvenc_hevc") {
      pix_fmt = "yuv420p";
    } else if (selectedEncoder === "cpu_x265") {
      pix_fmt = "yuv420p";
    }
    response.infoLog += `☑ force_8bit: pix_fmt normalised to ${pix_fmt}.\n`;
  } else if (selectedEncoder === "vaapi_hevc") {
    // Even without force_8bit, VAAPI still defaults to nv12 unless preserve_chroma
    // explicitly opts in to p010le. There is no automatic 10-bit detection because
    // VAProfileHEVCMain10 support cannot be reliably probed at runtime from a plugin.
    pix_fmt = "nv12";
  }

  if (!force8bit && preserveChroma && videoStream && videoStream.pix_fmt) {
    try {
      const srcPix = (videoStream.pix_fmt || "").toLowerCase();
      // Detect subsampling markers
      const is444 = srcPix.includes("444");
      const is422 = !is444 && srcPix.includes("422");
      // Keep bit depth if present (8/10/12). Default to 8 when unknown.
      const depthMatch = srcPix.match(/(\d{2})le/); // e.g. yuv444p10le
      const bitDepth = videoStream.bits_per_raw_sample
        ? parseInt(videoStream.bits_per_raw_sample, 10)
        : depthMatch
          ? parseInt(depthMatch[1], 10)
          : 8;
      if (selectedEncoder === "vaapi_hevc") {
        // Only attempt p010le (Main10) when preserve_chroma is explicitly enabled AND
        // force_8bit is off. Ensure your GPU supports VAProfileHEVCMain10 before enabling.
        const candidate = bitDepth >= 10 ? "p010le" : "nv12";
        if (pix_fmt !== candidate) {
          pix_fmt = candidate;
          response.infoLog += `☑ VAAPI pix_fmt set to ${candidate} for preserve_chroma (${bitDepth}-bit source). Ensure your GPU supports VAProfileHEVCMain10.\n`;
        }
      } else if (is444) {
        // NVENC HEVC 4:4:4 support is limited and may not work in all contexts
        // Only attempt for newer GPUs and add fallback logic
        if (selectedEncoder === "nvenc_hevc") {
          // Conservative approach: only try 4:4:4 for 8-bit, fallback to 4:2:0 for 10-bit
          const candidate = bitDepth <= 8 ? "yuv444p" : encoderConf.pix_fmt;
          if (pix_fmt !== candidate && candidate !== encoderConf.pix_fmt) {
            pix_fmt = candidate;
            response.infoLog += `☑ Attempting 4:4:4 chroma preservation with pix_fmt=${candidate} (NVENC).\n`;
          } else if (candidate === encoderConf.pix_fmt) {
            response.infoLog +=
              "ⓘ Source is 4:4:4 but keeping default 4:2:0 for NVENC compatibility.\n";
          }
        } else {
          // CPU x265 has better 4:4:4 support
          const candidate = bitDepth >= 10 ? "yuv444p10le" : "yuv444p";
          if (pix_fmt !== candidate) {
            pix_fmt = candidate;
            response.infoLog += `☑ Preserving 4:4:4 chroma with pix_fmt=${candidate} (x265).\n`;
          }
        }
      } else if (is422) {
        if (selectedEncoder === "cpu_x265") {
          const candidate = bitDepth >= 10 ? "yuv422p10le" : "yuv422p";
          if (pix_fmt !== candidate) {
            pix_fmt = candidate;
            response.infoLog += `☑ Preserving 4:2:2 chroma with pix_fmt=${candidate} (x265).\n`;
          }
        } else {
          response.infoLog +=
            "ⓘ Source is 4:2:2 but NVENC HEVC 4:2:2 preservation not attempted; keeping default 4:2:0.\n";
        }
      }
    } catch (e) {
      response.infoLog += `⚠ Failed chroma preservation logic: ${e}\n`;
    }
  }
  response.infoLog += `Node type: ${nodeHW}\n`;
  //check if the file is a video, if not the function will be stopped immediately
  if (file.fileMedium !== "video") {
    response.infoLog += "☒File is not a video! \n";
    return response;
  }
  response.infoLog += "☑File is a video! \n";
  bitrateprobe = file.bit_rate;

  // Decoder quick info (currently just logging / early skip for vp9)
  const decoderInfo = determineDecoder(file);
  response.infoLog += decoderInfo.log;
  if (decoderInfo.skip) return response;

  // Process streams via helper (we'll use this info to scope decoders correctly)
  const keepAttachedPics =
    inputs.keep_attached_pics === true || inputs.keep_attached_pics === "true";
  const wantAudioTranscode =
    inputs.transcode_audio === true || inputs.transcode_audio === "true";
  const targetAudioCodec = (inputs.audio_codec || "libopus").toLowerCase();
  const audioVBR = inputs.audio_vbr === true || inputs.audio_vbr === "true";
  const probeStreams = Array.isArray(
    file.ffProbeData && file.ffProbeData.streams,
  )
    ? file.ffProbeData.streams
    : [];
  if (probeStreams.length === 0) {
    response.infoLog +=
      "⚠ ffProbeData.streams missing or empty; stream mapping defaults will be used.\n";
  }
  const streamInfo = processStreams(probeStreams, {
    keepAttachedPics,
    transcodeAudio: wantAudioTranscode,
    targetAudioCodec,
    audioVBR,
  });
  map = streamInfo.map;
  subcli = streamInfo.subcli; // subtitle copy flags (audio handled separately)
  maxmux = streamInfo.maxmux;
  const videoInIndexes = streamInfo.videoInIndexes || [];
  const videoInOrdinals = streamInfo.videoInOrdinals || [];
  const attachedPicCount = (streamInfo.attachedPicInIndexes || []).length;
  const audioFlags = streamInfo.audioFlags;
  response.infoLog += streamInfo.log;

  // --- Dynamic hardware decoding selection ---
  // Provide CUVID decoder mapping for NVENC path; fallback to generic -hwaccel if mapping unsupported.
  let decodePrefix = "";
  let vaapiHwFrames = false;
  const srcCodec = (file.video_codec_name || "").toLowerCase();

  // Detect source bit depth for 8-bit conversion logic
  let sourceBitDepth = 8;
  if (videoStream) {
    const srcPix = (videoStream.pix_fmt || "").toLowerCase();
    const depthMatch = srcPix.match(/(\d{2})le/);
    sourceBitDepth = videoStream.bits_per_raw_sample
      ? parseInt(videoStream.bits_per_raw_sample, 10)
      : depthMatch
        ? parseInt(depthMatch[1], 10)
        : 8;
  }
  const isHevc10Bit = srcCodec === "hevc" && sourceBitDepth >= 10;
  const needs8bitConversion = force8bit && isHevc10Bit;

  // Detect if audio needs transcoding
  let audioNeedsTranscode = false;
  const audioStreams = probeStreams.filter(
    (s) => (s.codec_type || "").toLowerCase() === "audio",
  );
  if (audioStreams.length > 0) {
    // Normalize codec names for comparison: libopus=opus, libvorbis=vorbis, etc.
    const normalizeCodec = (codec) => {
      const c = (codec || "").toLowerCase();
      return c.replace(/^lib/, ""); // libopus -> opus, libvorbis -> vorbis
    };
    // Check if any audio stream doesn't match target codec (and we want to transcode)
    const mismatchedAudio = audioStreams.some(
      (s) => normalizeCodec(s.codec_name) !== normalizeCodec(targetAudioCodec),
    );
    // Only need audio conversion if there's a mismatch AND we want to transcode
    audioNeedsTranscode = wantAudioTranscode && mismatchedAudio;
  }

  // Detect if pixel format needs conversion
  const srcPixFmt = (videoStream.pix_fmt || "").toLowerCase();
  let pixelFormatNeedsConversion = false;
  if (force8bit) {
    // Need conversion if source is 10-bit (has "10le" in pix_fmt)
    pixelFormatNeedsConversion = srcPixFmt.includes("10le");
  } else if (preserveChroma) {
    // If preserve_chroma is on, check if we can preserve the format
    // For now, any difference in pix_fmt counts as needing conversion
    const targetPixFmt = pix_fmt.toLowerCase();
    pixelFormatNeedsConversion = srcPixFmt !== targetPixFmt;
  }

  const needsFormatConversion = audioNeedsTranscode || pixelFormatNeedsConversion;

  const hasNV =
    nodeHW.includes("nvenc") ||
    nodeHW.includes("nvidia") ||
    nodeHW.includes("cuda");
  const hasVAAPI =
    nodeHW.includes("vaapi") ||
    nodeHW.includes("intel") ||
    nodeHW.includes("amd");
  // Use getVideoStream to find the main video stream for profile checks
  const codecIsHigh10H264 =
    srcCodec === "h264" &&
    (videoStream.profile || "").toLowerCase().includes("high 10");
  const cuvidDecoder = CUVID_DECODER_MAP[srcCodec];
  const wantHW =
    hwDecodeMode === "force" ||
    (hwDecodeMode === "auto" && (hasNV || hasVAAPI));

  if (selectedEncoder === "vaapi_hevc" && hwDecodeMode === "force") {
    // Only use VAAPI hw decode when explicitly forced. Software decode is preferred because
    // the H.264 software decoder correctly applies the SPS crop window (e.g. coded_height=1088
    // → display 1080), whereas VAAPI hw decode exposes the raw padded surface which causes
    // bottom warping artifacts. With sw decode the frames arrive at display dimensions so
    // hwupload is used to move them onto the GPU for encoding.
    vaapiHwFrames = true;
    decodePrefix = `-hwaccel vaapi -hwaccel_device ${vaapiDevice} -hwaccel_output_format vaapi`;
    response.infoLog += `☑ Using VAAPI hardware decoder (forced; device ${vaapiDevice}).\n`;
  } else if (selectedEncoder === "vaapi_hevc" && hwDecodeMode === "off") {
    // Software decode + hardware encode.
    // On AMD VAAPI, the reliable software-decode path is the simpler -vaapi_device form.
    // The init_hw_device/filter_hw_device + hwupload=derive_device=va path fails during
    // filter init with "Query format failed for 'Parsed_hwupload_N': Cannot allocate memory".
    decodePrefix = `-vaapi_device ${vaapiDevice}`;
    response.infoLog += `☑ VAAPI encoder: software decode + hwupload via -vaapi_device (${vaapiDevice}).\n`;
  } else if (selectedEncoder === "vaapi_hevc") {
    // Default (auto): same software-decode upload path as "off".
    decodePrefix = `-vaapi_device ${vaapiDevice}`;
    response.infoLog +=
      `☑ VAAPI encoder: software decode + hwupload via -vaapi_device (avoids bottom-padding artifacts from hw decode; device ${vaapiDevice}).\n`;
  } else if (wantHW && selectedEncoder === "nvenc_hevc") {
    if (cuvidDecoder && !codecIsHigh10H264) {
      if (hasImageVideoStream) {
        // Apply CUVID only to the input video ordinals (v:N) that correspond to non-attached videos
        decodePrefix = videoInOrdinals
          .map((vn) => `-c:v:${vn} ${cuvidDecoder}`)
          .join(" ");
        response.infoLog += `☑ Using CUVID hardware decoder on ${videoInIndexes.length} input video stream(s) only: ${cuvidDecoder} (image/attached picture stream detected).\n`;
      } else {
        // Safe to target all video streams globally
        decodePrefix = `-c:v ${cuvidDecoder}`;
        const mvMsg =
          videoStreamCount > 1 ? " (multiple video streams present)" : "";
        response.infoLog += `☑ Using CUVID hardware decoder: ${cuvidDecoder}.${mvMsg}\n`;
      }
    } else if (codecIsHigh10H264) {
      response.infoLog += `⚠ High 10 H.264 profile detected; skipping CUVID (unsupported), falling back to software decode.\n`;
    } else {
      // Use generic hwaccel when no CUVID mapping, but avoid if images/attached pics present
      if (hasImageVideoStream) {
        response.infoLog += `ⓘ No CUVID mapping available; avoiding generic CUDA hwaccel due to image/attached picture streams. Using software decode.\n`;
      } else {
        decodePrefix = `-hwaccel cuda -hwaccel_output_format cuda`;
        response.infoLog += `☑ Using generic CUDA hwaccel for decoding.\n`;
      }
    }
  } else if (hwDecodeMode === "force" && selectedEncoder !== "nvenc_hevc") {
    response.infoLog += `⚠ Force HW decode requested but encoder is ${selectedEncoder}; no compatible HW decoder mapping applied.\n`;
  } else if (hwDecodeMode === "off") {
    response.infoLog += `☑ Hardware decoding disabled by setting.\n`;
  } else if (hwDecodeMode === "auto") {
    response.infoLog += `☑ Auto hardware decode not applied (nodeHardwareType='${nodeHW}' or encoder not NVENC).\n`;
  }

  if (decodePrefix) {
    response.preset = decodePrefix; // seed preset with decoder, encoding flags appended later
  }

  let streamWidth = 0;
  let streamHeight = 0;
  // Ensure even dimensions (required by many codecs) by inserting a scale filter if odd width/height detected.
  // Use the first non-attached video for odd-dimension detection if available
  let dimProbeStream = videoStream;
  if (
    Array.isArray(file.ffProbeData.streams) &&
    videoInIndexes &&
    videoInIndexes.length > 0
  ) {
    dimProbeStream = file.ffProbeData.streams[videoInIndexes[0]] || videoStream;
  }
  if (
    dimProbeStream &&
    dimProbeStream.width != null &&
    dimProbeStream.height != null
  ) {
    const vw = parseInt(dimProbeStream.width, 10);
    const vh = parseInt(dimProbeStream.height, 10);
    if (Number.isFinite(vw) && Number.isFinite(vh)) {
      streamWidth = vw;
      streamHeight = vh;
      response.infoLog += "☑Video stream found! \n";
      if (vw % 2 !== 0 || vh % 2 !== 0) {
        if (selectedEncoder === "vaapi_hevc" && vaapiHwFrames) {
          vfFilter = ' -filter:v:0 "scale_vaapi=w=ceil(iw/2)*2:h=ceil(ih/2)*2"';
          response.infoLog += `⚠ Detected odd resolution ${vw}x${vh}, adding scale_vaapi filter to make dimensions even.\n`;
        } else if (selectedEncoder !== "vaapi_hevc") {
          vfFilter = ' -filter:v:0 "scale=ceil(iw/2)*2:ceil(ih/2)*2"';
          response.infoLog += `⚠ Detected odd resolution ${vw}x${vh}, adding scale filter to make dimensions even.\n`;
        }
        // For VAAPI SW decode path, odd dims are handled in the scale_vaapi filter built below.
      }
    }
  }

  if (selectedEncoder === "vaapi_hevc") {
    response.infoLog += `☑ VAAPI tuning: qp ${vaapiQp}, bitrate multiplier ${vaapiBitrateMultiplier.toFixed(2)}.\n`;
    const vaapiFormat = pix_fmt === "p010le" ? "p010le" : "nv12";
    const vaapiAlign16 =
      inputs.vaapi_align16 === true ||
      inputs.vaapi_align16 === "true" ||
      inputs.vaapi_align16 === undefined; // default true for older configs

    if (vaapiHwFrames) {
      response.infoLog +=
        "☑ VAAPI: using hw frames; skipping hwupload filter.\n";
    } else {
      // Build the software filter chain: format=nv12 → (optional pad) → hwupload
      //
      // 1. format=nv12        — convert decoded frames to 8-bit nv12 in software before
      //                         upload, regardless of source bit depth. Avoids uploading
      //                         raw 10-bit surfaces that some drivers handle incorrectly.
      // 2. pad (conditional)  — AMD VCE/VCE2 requires frame height to be a multiple of 16.
      //                         1080 % 16 = 8, so we pad to ceil(h/16)*16 in software
      //                         before hwupload so the encoder receives a properly-aligned
      //                         surface with black padding instead of uninitialised rows.
      //                         The real display size is preserved via HEVC crop metadata.
      // 3. hwupload           — move the prepared sw frame onto the VAAPI device.
      //
      // We do NOT append scale_vaapi after hwupload. With format=nv12 done in software
      // before hwupload, hwupload already produces a VAAPI nv12 surface that hevc_vaapi
      // can consume directly. Adding scale_vaapi=format=nv12 (even without w/h args)
      // causes FFmpeg to insert an auto_scale filter after it that then fails format
      // negotiation: "Impossible to convert between the formats supported by the filter
      // 'Parsed_scale_vaapi_N' and the filter 'auto_scale_N'". Dropping scale_vaapi
      // entirely avoids this and also avoids the Intel VPP bottom-row artifact that
      // occurred with scale_vaapi=w=iw:h=ih.
      const rawW = streamWidth;
      const rawH = streamHeight;

      // Even-dimension fix (all codecs require this)
      const alignedW = rawW % 2 !== 0 ? rawW + 1 : rawW;
      // 16-row alignment for AMD VCE; also satisfies the even-height requirement
      const alignedH =
        vaapiAlign16 && rawH > 0
          ? Math.ceil(rawH / 16) * 16
          : rawH % 2 !== 0
            ? rawH + 1
            : rawH;

      const needsPad = rawW !== alignedW || rawH !== alignedH;

      // Build sw filter chain: format → optional pad → hwupload.
      // With -vaapi_device set on the command line, plain hwupload targets the correct
      // VAAPI device on AMD without the surface allocation failure seen with derive_device.
      let swChain = `format=${vaapiFormat}`;
      if (needsPad) {
        swChain += `,pad=${alignedW}:${alignedH}:0:0:black`;
        response.infoLog += `☑ VAAPI: padding ${rawW}x${rawH} → ${alignedW}x${alignedH} (AMD VCE 16px alignment; display size preserved via HEVC crop metadata).\n`;
      }
      swChain += ",hwupload";

      if (needsPad) {
        const cropParts = [];
        if (alignedW > rawW) cropParts.push(`crop_right=${alignedW - rawW}`);
        if (alignedH > rawH) cropParts.push(`crop_bottom=${alignedH - rawH}`);

        if (cropParts.length) {
          const cropFilter = `filter_units=remove_types=38,hevc_metadata=${cropParts.join(":")}`;
          videoBitstreamFlags = ` ${videoInIndexes
            .map((_, idx) => `-bsf:v:${idx} ${cropFilter}`)
            .join(" ")}`;
          response.infoLog += `☑ VAAPI: signalling display crop via ${cropFilter}.\n`;
        }
      }

      vfFilter = ` -vf "${swChain}"`;

      response.infoLog += `☑ VAAPI: uploading via ${swChain}${needsPad ? ` (coded: ${alignedW}x${alignedH}, display: ${rawW}x${rawH})` : ""}.\n`;
    }
  }

  // DRY resolution-based logic with config table
  const resCfg = RESOLUTION_CONFIGS.find((c) =>
    c.match.includes(file.video_resolution),
  );
  if (resCfg) {
    bitratecheck = resCfg.bitrateCheck;
    if (bitrateprobe != null && bitrateprobe < bitratecheck) {
      bitratetarget = parseInt(
        (bitrateprobe * resCfg.adaptive.multiplier) / resCfg.adaptive.divisor,
      );
      bitratemax = bitratetarget + resCfg.adaptive.add;
    } else {
      bitratetarget = resCfg.defaults.target;
      bitratemax = resCfg.defaults.max;
    }
    const qualityVal =
      selectedEncoder === "vaapi_hevc"
        ? vaapiQp
        : typeof resCfg.qualityOverride === "number"
        ? resCfg.qualityOverride
        : encoderConf.qualityValue;
    const qualitySegment = encoderConf.supportsX265Params
      ? ` ${encoderConf.qualityFlag} ${qualityVal}`
      : ` ${encoderConf.qualityFlag} ${qualityVal}`;
    let maxRateToUse = resCfg.fixedMaxRateValue
      ? resCfg.fixedMaxRateValue
      : bitratemax;
    // If disable_bitrate_reduction is set, use original bitrate first (before VAAPI multiplier)
    let preserveOriginalBitrate = false;
    if (disableBitrateReduction && bitrateprobe != null) {
      const originalBitrateKbps = Math.round(bitrateprobe / 1000);
      bitratetarget = originalBitrateKbps;
      maxRateToUse = Math.round(originalBitrateKbps * 1.5);
      preserveOriginalBitrate = true;
      response.infoLog += `☑ disable_bitrate_reduction: using original bitrate ${bitratetarget}kbps\n`;
    }
    if (selectedEncoder === "vaapi_hevc" && !disableBitrateReduction) {
      const originalTarget = bitratetarget;
      const originalMax = maxRateToUse;
      bitratetarget = roundBitrateKbps(
        bitratetarget * vaapiBitrateMultiplier,
      );
      maxRateToUse = roundBitrateKbps(maxRateToUse * vaapiBitrateMultiplier);
      maxRateToUse = Math.max(maxRateToUse, bitratetarget + 500);
      response.infoLog += `☑ VAAPI bitrate tuning: target ${originalTarget}k → ${bitratetarget}k, maxrate ${originalMax}k → ${maxRateToUse}k.\n`;
    }
    // If file is already HEVC with lower bitrate than threshold, but needs format conversion,
    // preserve original bitrate to avoid quality loss
    if (
      !preserveOriginalBitrate &&
      firstStreamCodec === "hevc" &&
      bitrateprobe != null &&
      bitrateprobe < bitratecheck &&
      (needs8bitConversion || needsFormatConversion)
    ) {
      const originalBitrateKbps = Math.round(bitrateprobe / 1000);
      bitratetarget = originalBitrateKbps;
      maxRateToUse = Math.round(originalBitrateKbps * 1.5);
      preserveOriginalBitrate = true;
      response.infoLog += `☑ Preserving original bitrate for format conversion: ${bitratetarget}kbps\n`;
    }
    // Build base flags (NVENC adds baseFlags) with optional safe mode override
    let baseFlags = encoderConf.baseFlags ? ` ${encoderConf.baseFlags}` : "";
    if (selectedEncoder === "nvenc_hevc" && nvencSafeMode) {
      baseFlags = " -rc-lookahead 16"; // minimal conservative set
      response.infoLog +=
        "⚠ NVENC safe mode enabled: using conservative flags (no spatial AQ).\n";
    }
    // If no moving video streams were mapped, abort gracefully
    const movingVideoCount = (videoInIndexes || []).length;
    if (movingVideoCount === 0) {
      response.infoLog +=
        "⚠ No non-attached video streams to transcode; skipping.\n";
      return response;
    }
    // Build per-video-stream encoding flags for all mapped non-attached video streams
    let videoEncodeFlags = "";
    for (let vi = 0; vi < movingVideoCount; vi += 1) {
      // For VAAPI, -pix_fmt must not be passed to the encoder — the pixel format is
      // already set on the VAAPI surface via scale_vaapi=format=. Passing -pix_fmt p010le
      // causes FFmpeg to override it to 'vaapi' and then fail to reinitialize the filter
      // chain (error -38 "Function not implemented").
      const pixFmtFlag =
        selectedEncoder === "vaapi_hevc" ? "" : ` -pix_fmt ${pix_fmt}`;
      // When preserving original bitrate, use ABR mode (no CRF/QP) so bitrate is actually used.
      // When both CRF and -b:v are set, x265 ignores bitrate and uses CRF mode.
      const qualityOrBitrate = preserveOriginalBitrate
        ? ` -b:v:${vi} ${bitratetarget}k -maxrate:v:${vi} ${maxRateToUse}k`
        : `${qualitySegment} -b:v:${vi} ${bitratetarget}k -maxrate:v:${vi} ${maxRateToUse}k`;
      videoEncodeFlags += ` -c:v:${vi} ${target_codec}${pixFmtFlag}${qualityOrBitrate}`;
    }
    // Apply preset once (global encoder preset is acceptable; ffmpeg will apply to all encoders)
    videoEncodeFlags += ` -preset ${transcode_preset}${baseFlags}`;
    // If we have attached pictures (cover art as video streams), copy them using -c:v copy
    // Note: These are video streams (codec_type=video with attached_pic=1), not attachment streams
    let attachedPicFlags = "";
    if (attachedPicCount && attachedPicCount > 0) {
      // Map them explicitly above, now add -c:v copy for each attached picture stream
      // The stream indices in output will be after the main video streams
      const firstAttachedPicOutputIndex = movingVideoCount;
      attachedPicFlags = " " + Array.from({ length: attachedPicCount }, (_, i) =>
        `-c:v:${firstAttachedPicOutputIndex + i} copy`
      ).join(" ");
    }
    // Compose final preset additions.
    // Use <io> as the split token between input args and output args. Tdarr checks for
    // <io> before falling back to comma-splitting, so commas inside -vf filter chains
    // (e.g. "hwupload,scale_vaapi=...") are passed through to FFmpeg unharmed.
    // response.preset currently holds the decode prefix (input args); everything after
    // <io> is output args inserted between -i <input> and <output> by Tdarr.
    // Note: Don't use -dn when we want to keep attached pictures (they'd be dropped)
    const dropNonMapping = attachedPicCount > 0 && keepAttachedPics ? "" : "-dn";
    response.preset += `<io>${map} ${dropNonMapping}${vfFilter}${videoEncodeFlags}${videoBitstreamFlags}${attachedPicFlags} ${audioFlags} ${subcli}${maxmux}`;
    transcode = true;
  }
  //check if the file is eligible for transcoding
  //if true the neccessary values will be changed
  if (transcode) {
    response.processFile = true;
    response.FFmpegMode = true;
    response.reQueueAfter = true;
    response.infoLog += `☒File is ${file.video_resolution}!\n`;
    response.infoLog += `☒File bitrate is ${bitrateprobe / 1000}kbps\n`;
    response.infoLog += `☒Target Bitrate set to ${bitratecheck / 1000}kbps!\n`;
    if (bitrateprobe < bitratecheck) {
      response.infoLog += `File bitrate is LOWER than the Default Target Bitrate!\n`;
      // Check if HEVC already
      if (firstStreamCodec === "hevc") {
        // Transcode if we need format conversion (8-bit, audio, or pixel format)
        if (needs8bitConversion || needsFormatConversion) {
          // Already handled above - just log the reason
          if (needs8bitConversion) {
            response.infoLog += `File is HEVC ${sourceBitDepth}-bit but force_8bit is enabled - converting to 8-bit.\n`;
          }
          if (audioNeedsTranscode) {
            response.infoLog += `Audio codec mismatch (${targetAudioCodec} required) - converting without bitrate reduction.\n`;
          }
          if (pixelFormatNeedsConversion) {
            response.infoLog += `Pixel format conversion needed - converting without bitrate reduction.\n`;
          }
        } else {
          response.infoLog += `File is already in HEVC format AND lower than the target bitrate!\n`;
          response.processFile = false;
          response.infoLog += `☒File will not be transcoded!\n`;
          return response;
        }
      }
    } else {
      response.infoLog += `File bitrate is HIGHER than the Default Target Bitrate!\n`;
    }

    response.infoLog += `☒Target Bitrate set to ${bitratetarget}kbps!\n`;
    response.infoLog += `File is being transcoded!\n`;
  }

  return response;
};
module.exports.details = details;
module.exports.plugin = plugin;