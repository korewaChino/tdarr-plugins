/* eslint-disable */

const details = () => ({
    id: "Tdarr_Plugin_korewaChino_HEVC_Transcode_Optimize",
    Name: "Transcode to HEVC or optimize existing HEVC files - Tiered based on resolution and bitrate (HW/SW)",
    Type: "Video",
    Operation: "Transcode",
    Description: "Transcode to HEVC (NVENC or CPU x265) based on resolution & bitrate; preserves non-video streams and can optimize existing HEVC.",
    Version: "0.4.2",
    Link: "https://github.com/korewaChino/tdarr-plugins",
    Inputs: [
        {
            name: "transcode_preset",
            type: "string",
            defaultValue: "slow",
            inputUI: {
                type: "dropdown",
                options: [
                    "veryslow", "slower", "slow", "medium", "fast", "faster", "veryfast", "superfast", "ultrafast"
                ]
            },
            tooltip: "Choose the encoder speed/quality preset (passed to selected encoder)."
        },
        {
            name: "video_encoder",
            type: "string",
            defaultValue: "nvenc_hevc",
            inputUI: {
                type: "dropdown",
                options: [
                    "nvenc_hevc",   // hevc_nvenc
                    "cpu_x265"      // libx265 fallback
                ]
            },
            tooltip: "Select HEVC encoder implementation (NVENC GPU or CPU x265)."
        },
        {
            name: "hardware_decode_mode",
            type: "string",
            defaultValue: "auto",
            inputUI: {
                type: "dropdown",
                options: ["auto", "off", "force"]
            },
            tooltip: "Hardware decoding: auto (only if NVENC available & codec supported), off (disable; use software decode), force (try even if not detected)."
        },
        {
            name: "nvenc_safe_mode",
            type: "boolean",
            defaultValue: false,
            tooltip: "Enable conservative NVENC settings (omit advanced AQ flags) for older / limited GPUs or when encountering 'Temporal AQ not supported'."
        },
        {
            name: "keep_attached_pics",
            type: "boolean",
            defaultValue: false,
            tooltip: "Copy embedded cover art / attached picture streams instead of dropping them. Disable to skip them for leaner outputs. Note: Some attached pictures with invalid parameters may be automatically skipped to prevent encoding errors."
        },
        {
            name: "transcode_audio",
            type: "boolean",
            defaultValue: true,
            tooltip: "Transcode all audio streams instead of copying them (uses audio_codec target)."
        },
        {
            name: "audio_codec",
            type: "string",
            defaultValue: "libopus",
            inputUI: {
                type: "dropdown",
                // Use FFmpeg encoder names
                options: ["libopus", "aac", "ac3", "eac3", "flac", "libvorbis", "libmp3lame"]
            },
            tooltip: "Target codec for audio transcoding when enabled."
        },
        {
            name: "audio_vbr",
            type: "boolean",
            defaultValue: true,
            tooltip: "Enable Variable Bitrate (VBR) for audio where supported. Opus: -vbr on. AAC/MP3/Vorbis: use VBR quality (qscale). AC3/EAC3/FLAC ignore this."
        },
        {
            name: "preserve_chroma",
            type: "boolean",
            defaultValue: false,
            tooltip: "If source pixel format uses higher chroma subsampling (4:4:4 or 4:2:2), attempt to preserve it instead of forcing 4:2:0. Conservative approach for NVENC (8-bit 4:4:4 only), full support for x265. May cause encoding failures on some systems."
        },

    ]
});

// Helper to get main video stream
function getVideoStream(streams) {
    return streams.find(s => s.codec_type && s.codec_type.toLowerCase() === "video");
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

// --- Static configuration objects (moved outside plugin for readability) ---
// CUVID decoder mapping for NVENC hardware decode
const CUVID_DECODER_MAP = Object.freeze({
    h264: 'h264_cuvid',
    hevc: 'hevc_cuvid',
    mpeg2: 'mpeg2_cuvid',
    mpeg1: 'mpeg1_cuvid',
    vc1: 'vc1_cuvid',
    vp8: 'vp8_cuvid',
    mjpeg: 'mjpeg_cuvid',
    h263: 'h263_cuvid'
});

// Encoder profiles (hardware & software HEVC encoders)
const ENCODER_PROFILES = Object.freeze({
    nvenc_hevc: {
        codec: "hevc_nvenc",
        pix_fmt: "p010le",
        supportsX265Params: false,
        qualityFlag: "-cq",
        qualityValue: 26,
        // Removed temporal-aq due to compatibility issues on some drivers/GPUs
        baseFlags: "-qmin 0 -rc-lookahead 32 -spatial-aq 1 -aq-strength 8 -a53cc 0"
    },
    cpu_x265: {
        codec: "libx265",
        pix_fmt: "yuv420p10le",
        supportsX265Params: true,
        qualityFlag: "-crf",
        qualityValue: 26
    }
});

// Resolution-tier configuration table
const RESOLUTION_CONFIGS = Object.freeze([
    {
        match: ["480p", "576p"],
        bitrateCheck: 1000000,
        adaptive: { multiplier: 0.8, divisor: 1000, add: 500 },
        defaults: { target: 1000, max: 1500 },
        fixedMaxRateValue: 1500,
        qualityOverride: 27
    },
    {
        match: ["720p"],
        bitrateCheck: 2500000,
        adaptive: { multiplier: 0.8, divisor: 1000, add: 2000 },
        defaults: { target: 2000, max: 4000 },
        qualityOverride: 27
    },
    {
        match: ["1080p"],
        bitrateCheck: 3500000,
        adaptive: { multiplier: 0.8, divisor: 1000, add: 3500 },
        defaults: { target: 5500, max: 12000 },
        qualityOverride: 27
    },
    {
        match: ["4KUHD"],
        bitrateCheck: 14000000,
        adaptive: { multiplier: 0.7, divisor: 1000, add: 12000 },
        defaults: { target: 18000, max: 25000 },
        qualityOverride: 29
    }
]);

// Stream processing helper: determines mapping, subtitle copy flags, mux queue, and (optionally) attached pictures.
function processStreams(streams, options = {}) {
    const {
        keepAttachedPics = true,
        transcodeAudio = true,
        targetAudioCodec = "libopus",
        audioVBR = true
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
                        channelLayout: (s.channel_layout || "").toLowerCase()
                    });
                }
                if (
                    name === "truehd" ||
                    (name === "dts" && (s.profile || "").toLowerCase() === "dts-hd ma") ||
                    (name === "aac" && (s.sample_rate || "").toString() === "44100" && type === "audio")
                ) {
                    maxmuxLocal = " -max_muxing_queue_size 9999";
                }
                // Attached pictures
                if (type === "video" && disposition.attached_pic === 1) {
                    // Skip attached pictures with invalid parameters that could cause encoding issues
                    if (!s.width || !s.height || s.width <= 0 || s.height <= 0) {
                        log += `⚠ Skipping attached picture stream ${idx} (${name}) due to invalid dimensions.\n`;
                        // Even if skipped for copy, still advance video ordinal counter
                        videoOrdinal += 1;
                        return; // skip this stream for mapping
                    }
                    if (keepAttachedPics) {
                        attachedPicInIndexes.push(idx);
                        log += `☑ Detected attached picture stream ${idx} (${name}); will copy.\n`;
                    } else {
                        log += `ⓘ Dropping attached picture stream ${idx}.\n`;
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
            } catch (_) { /* ignore per-stream errors */ }
        });
    } catch (err) {
        log += `⚠ Error scanning streams: ${err}\n`;
    }
    let map = "-map 0"; // fallback if nothing found
    if (videoInIndexes.length > 0) {
        // Map all non-attached video streams first so they become v:0..v:n in the output
        map = videoInIndexes.map(i => `-map 0:${i}`).join(" ");
        // Then map all audios/subs/etc
        map += " -map 0:a? -map 0:s? -map 0:t? -map 0:d?";
        // Finally map attached pictures so they become video streams after the encoded ones
        if (keepAttachedPics && attachedPicInIndexes.length) {
            map += attachedPicInIndexes.map(i => ` -map 0:${i}?`).join("");
        }
        log += `☑ Mapping ${videoInIndexes.length} non-attached video stream(s): [${videoInIndexes.join(', ')}].\n`;
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
                if (targetAudioCodec === 'libopus') {
                    // Problematic layouts that need mapping_family 1:
                    // - 5.1(side) - side surround instead of rear
                    // - Any layout with more than 2 channels that isn't standard 5.1/7.1
                    // - Layouts with "side" designation
                    const needsMappingFamily1 = (
                        layout.includes('side') ||
                        layout.includes('wide') ||
                        (channels > 2 && !['5.1', '7.1', 'quad', '5.0', '4.0', '6.1', '7.0'].some(std => layout.includes(std) && !layout.includes('side')))
                    );
                    // For channels > 2, always use mapping_family 1 to be safe with various layouts
                    if (channels > 2 || needsMappingFamily1) {
                        perStream += ' -mapping_family 1';
                        log += `☑ Audio stream ${i}: Using Opus mapping_family 1 for layout "${layout}" (${channels}ch).\n`;
                    }
                }

                if (audioVBR) {
                    const tc = targetAudioCodec;
                    if (tc === 'libopus') {
                        perStream += ' -vbr on';
                    } else if (tc === 'aac') {
                        // Native AAC VBR using quality scale (approx. ~160kbps at 2)
                        perStream += ` -q:a:${i} 2`;
                    } else if (tc === 'libvorbis') {
                        // Vorbis VBR quality 5 (~160kbps)
                        perStream += ` -q:a:${i} 5`;
                    } else if (tc === 'libmp3lame') {
                        // MP3 VBR (V2 equivalent)
                        perStream += ` -q:a:${i} 2`;
                    }
                }
                audioFlags += perStream;
            }
            log += `☑ Transcoding ${audioStreamCount} audio stream(s) to ${targetAudioCodec}${audioVBR ? ' with VBR where supported' : ''}.\n`;
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
        log
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
    const transcode_preset = inputs.transcode_preset;
    const selectedEncoder = inputs.video_encoder || "nvenc_hevc";
    const hwDecodeMode = inputs.hardware_decode_mode || "auto";
    const nvencSafeMode = (inputs.nvenc_safe_mode === true || inputs.nvenc_safe_mode === "true");
    const nodeHW = (otherArguments && otherArguments.nodeHardwareType || "").toLowerCase();
    const videoStream = getVideoStream(file.ffProbeData.streams) || {};
    // Detect if there are multiple video streams and/or image-like streams (attached pictures)
    let videoStreamCount = 0;
    let hasAttachedPicture = false;
    let hasImageVideoStream = false; // attached pic or image codecs like mjpeg/png/etc
    try {
        (file.ffProbeData.streams || []).forEach(s => {
            if ((s.codec_type || "").toLowerCase() === "video") {
                videoStreamCount += 1;
                const disp = s.disposition || {};
                const codec = (s.codec_name || "").toLowerCase();
                if (disp.attached_pic === 1) hasAttachedPicture = true;
                // Consider typical image codecs in containers (rare outside attached pics, but be safe)
                if (disp.attached_pic === 1 || ["mjpeg", "png", "bmp", "tiff", "gif", "jpeg", "mjpg"].includes(codec)) {
                    hasImageVideoStream = true;
                }
            }
        });
    } catch (_) { /* noop */ }

    const encoderConf = ENCODER_PROFILES[selectedEncoder] || ENCODER_PROFILES.nvenc_hevc;
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
        //     file: file,
        //     librarySettings: librarySettings,
        //     inputs: inputs,
        //     otherArguments: otherArguments,
        // }
    };

    const preserveChroma = (inputs.preserve_chroma === true || inputs.preserve_chroma === "true");
    if (preserveChroma && videoStream && videoStream.pix_fmt) {
        try {
            const srcPix = (videoStream.pix_fmt || "").toLowerCase();
            // Detect subsampling markers
            const is444 = srcPix.includes("444");
            const is422 = !is444 && srcPix.includes("422");
            // Keep bit depth if present (8/10/12). Default to 10 for preservation to align with existing 10-bit target.
            const depthMatch = srcPix.match(/(\d{2})le/); // e.g. yuv444p10le
            const bitDepth = depthMatch ? depthMatch[1] : "10";
            if (is444) {
                // NVENC HEVC 4:4:4 support is limited and may not work in all contexts
                // Only attempt for newer GPUs and add fallback logic
                if (selectedEncoder === 'nvenc_hevc') {
                    // Conservative approach: only try 4:4:4 for 8-bit, fallback to 4:2:0 for 10-bit
                    const candidate = bitDepth === "08" ? "yuv444p" : encoderConf.pix_fmt;
                    if (pix_fmt !== candidate && candidate !== encoderConf.pix_fmt) {
                        pix_fmt = candidate;
                        response.infoLog += `☑ Attempting 4:4:4 chroma preservation with pix_fmt=${candidate} (NVENC).\n`;
                    } else if (candidate === encoderConf.pix_fmt) {
                        response.infoLog += "ⓘ Source is 4:4:4 but keeping default 4:2:0 for NVENC compatibility.\n";
                    }
                } else {
                    // CPU x265 has better 4:4:4 support
                    const candidate = bitDepth === "10" ? "yuv444p10le" : "yuv444p";
                    if (pix_fmt !== candidate) {
                        pix_fmt = candidate;
                        response.infoLog += `☑ Preserving 4:4:4 chroma with pix_fmt=${candidate} (x265).\n`;
                    }
                }
            } else if (is422) {
                if (selectedEncoder === 'cpu_x265') {
                    const candidate = bitDepth === "10" ? "yuv422p10le" : "yuv422p";
                    if (pix_fmt !== candidate) {
                        pix_fmt = candidate;
                        response.infoLog += `☑ Preserving 4:2:2 chroma with pix_fmt=${candidate} (x265).\n`;
                    }
                } else {
                    response.infoLog += "ⓘ Source is 4:2:2 but NVENC HEVC 4:2:2 preservation not attempted; keeping default 4:2:0.\n";
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
    const keepAttachedPics = (inputs.keep_attached_pics === true || inputs.keep_attached_pics === "true");
    const wantAudioTranscode = (inputs.transcode_audio === true || inputs.transcode_audio === "true");
    const targetAudioCodec = (inputs.audio_codec || "libopus").toLowerCase();
    const audioVBR = (inputs.audio_vbr === true || inputs.audio_vbr === "true");
    const streamInfo = processStreams(file.ffProbeData.streams, { keepAttachedPics, transcodeAudio: wantAudioTranscode, targetAudioCodec, audioVBR });
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
    let decodePrefix = '';
    const srcCodec = (file.video_codec_name || '').toLowerCase();
    const hasNV = nodeHW.includes('nvenc') || nodeHW.includes('nvidia') || nodeHW.includes('cuda');
    // Use getVideoStream to find the main video stream for profile checks
    const codecIsHigh10H264 = (srcCodec === 'h264') && ((videoStream.profile || '').toLowerCase().includes('high 10'));
    const cuvidDecoder = CUVID_DECODER_MAP[srcCodec];
    const wantHW = hwDecodeMode === 'force' || (hwDecodeMode === 'auto' && hasNV);

    if (wantHW && selectedEncoder === 'nvenc_hevc') {
        if (cuvidDecoder && !codecIsHigh10H264) {
            if (hasImageVideoStream) {
                // Apply CUVID only to the input video ordinals (v:N) that correspond to non-attached videos
                decodePrefix = videoInOrdinals.map(vn => `-c:v:${vn} ${cuvidDecoder}`).join(' ');
                response.infoLog += `☑ Using CUVID hardware decoder on ${videoInIndexes.length} input video stream(s) only: ${cuvidDecoder} (image/attached picture stream detected).\n`;
            } else {
                // Safe to target all video streams globally
                decodePrefix = `-c:v ${cuvidDecoder}`;
                const mvMsg = videoStreamCount > 1 ? " (multiple video streams present)" : "";
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
    } else if (hwDecodeMode === 'force' && selectedEncoder !== 'nvenc_hevc') {
        response.infoLog += `⚠ Force HW decode requested but encoder is ${selectedEncoder}; no compatible HW decoder mapping applied.\n`;
    } else if (hwDecodeMode === 'off') {
        response.infoLog += `☑ Hardware decoding disabled by setting.\n`;
    } else if (hwDecodeMode === 'auto') {
        response.infoLog += `☑ Auto hardware decode not applied (nodeHardwareType='${nodeHW}' or encoder not NVENC).\n`;
    }

    if (decodePrefix) {
        response.preset = decodePrefix; // seed preset with decoder, encoding flags appended later
    }

    // Ensure even dimensions (required by many codecs) by inserting a scale filter if odd width/height detected.
    // Use the first non-attached video for odd-dimension detection if available
    let dimProbeStream = videoStream;
    if (Array.isArray(file.ffProbeData.streams) && (videoInIndexes && videoInIndexes.length > 0)) {
        dimProbeStream = file.ffProbeData.streams[videoInIndexes[0]] || videoStream;
    }
    if (dimProbeStream && (dimProbeStream.width != null) && (dimProbeStream.height != null)) {
        const vw = parseInt(dimProbeStream.width, 10);
        const vh = parseInt(dimProbeStream.height, 10);
        if (Number.isFinite(vw) && Number.isFinite(vh)) {
            response.infoLog += "☑Video stream found! \n";
            if ((vw % 2 !== 0) || (vh % 2 !== 0)) {
                vfFilter = ' -vf "scale=ceil(iw/2)*2:ceil(ih/2)*2"';
                response.infoLog += `⚠ Detected odd resolution ${vw}x${vh}, adding scale filter to make dimensions even.\n`;
            }
        }
    }

    // DRY resolution-based logic with config table
    const resCfg = RESOLUTION_CONFIGS.find(c => c.match.includes(file.video_resolution));
    if (resCfg) {
        bitratecheck = resCfg.bitrateCheck;
        if (bitrateprobe != null && bitrateprobe < bitratecheck) {
            bitratetarget = parseInt((bitrateprobe * resCfg.adaptive.multiplier) / resCfg.adaptive.divisor);
            bitratemax = bitratetarget + resCfg.adaptive.add;
        } else {
            bitratetarget = resCfg.defaults.target;
            bitratemax = resCfg.defaults.max;
        }
        const qualityVal = (typeof resCfg.qualityOverride === 'number') ? resCfg.qualityOverride : encoderConf.qualityValue;
        const qualitySegment = encoderConf.supportsX265Params
            ? ` ${encoderConf.qualityFlag} ${qualityVal}`
            : ` ${encoderConf.qualityFlag} ${qualityVal}`;
        const maxRateToUse = resCfg.fixedMaxRateValue ? resCfg.fixedMaxRateValue : bitratemax;
        // Build base flags (NVENC adds baseFlags) with optional safe mode override
        let baseFlags = encoderConf.baseFlags ? ` ${encoderConf.baseFlags}` : "";
        if (selectedEncoder === 'nvenc_hevc' && nvencSafeMode) {
            baseFlags = " -rc-lookahead 16"; // minimal conservative set
            response.infoLog += "⚠ NVENC safe mode enabled: using conservative flags (no spatial AQ).\n";
        }
        // If no moving video streams were mapped, abort gracefully
        const movingVideoCount = (videoInIndexes || []).length;
        if (movingVideoCount === 0) {
            response.infoLog += "⚠ No non-attached video streams to transcode; skipping.\n";
            return response;
        }
        // Build per-video-stream encoding flags for all mapped non-attached video streams
        let videoEncodeFlags = "";
        for (let vi = 0; vi < movingVideoCount; vi += 1) {
            videoEncodeFlags += ` -c:v:${vi} ${target_codec} -pix_fmt ${pix_fmt}${qualitySegment} -b:v:${vi} ${bitratetarget}k -maxrate:v:${vi} ${maxRateToUse}k`;
        }
        // Apply preset once (global encoder preset is acceptable; ffmpeg will apply to all encoders)
        videoEncodeFlags += ` -preset ${transcode_preset}${baseFlags}`;
        // If we have attached pictures, copy them and mark disposition with the correct output video index offset
        let attachedPicFlags = "";
        if (attachedPicCount && attachedPicCount > 0) {
            for (let i = 0; i < attachedPicCount; i += 1) {
                const outIdx = movingVideoCount + i; // attachments follow encoded video streams
                attachedPicFlags += ` -c:v:${outIdx} copy -disposition:v:${outIdx} attached_pic`;
            }
        }
        // Compose final preset additions
        response.preset += `,${map} -dn${vfFilter}${videoEncodeFlags}${attachedPicFlags} ${audioFlags} ${subcli}${maxmux}`;
        transcode = true;
    }
    //check if the file is eligible for transcoding
    //if true the neccessary response values will be changed
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
            if (file.ffProbeData.streams[0].codec_name === "hevc") {
                response.infoLog += `File is already in HEVC format AND lower than the target bitrate!\n`;
                response.processFile = false;
                response.infoLog += `☒File will not be transcoded!\n`;
                return response;
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
