const details = () => ({
    id: "Tdarr_Plugin_korewaChino_Standardize_Audio_Codecs",
    Stage: "Pre-processing",
    Name: "Standardise Audio Codecs",
    Type: "Video",
    Operation: "Transcode",
    Description: `
This action has a built-in filter. Additional filters can be added.\n\n

All audio tracks which are not in the specified codec will be transcoded
into the specified codec. Bitrate and channel count are kept the same.
  `,
    Version: "1.00",
    Tags: "action",
    Inputs: [
        {
            name: "audioCodec",
            type: "string",
            defaultValue: "libopus",
            inputUI: {
                type: "dropdown",
                options: [
                    "aac",
                    "ac3",
                    "eac3",
                    "dca",
                    "flac",
                    "mp2",
                    "libmp3lame",
                    "truehd",
                    "libopus",
                ],
            },
            tooltip: "Enter the desired audio codec",
        },
    ],
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const plugin = (file, librarySettings, inputs, otherArguments) => {
    const lib = require("../methods/lib")();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars,no-param-reassign
    inputs = lib.loadDefaultValues(inputs, details);
    const response = {
        processFile: false,
        preset: "",
        container: "",
        handBrakeMode: false,
        FFmpegMode: false,
        reQueueAfter: false,
        infoLog: "",
    };

    if (inputs.audioCodec === "libopus") {
        // Opus is a special case, we do have an `opus` codec, but it's not stable yet.

        // Check if any audio streams are already opus
        var streams = file.ffProbeData.streams;

        // Check if all streams of type `audio` has `codec_name` of `opus`

        var streams_audio_not_opus = streams.filter(function (stream) {
            return (
                stream.codec_type === "audio" && stream.codec_name !== "opus"
            );
        });

        if (streams_audio_not_opus.length === 0) {
            response.infoLog +=
                "File already has all audio streams in opus codec. Skipping this plugin. ";
            return response;
        }
    }

    const transcodeStandardiseAudioCodecs =
        lib.actions.transcodeStandardiseAudioCodecs(file, inputs.audioCodec);

    response.infoLog += transcodeStandardiseAudioCodecs.preset;

    var preset = transcodeStandardiseAudioCodecs.preset;

    preset += " -map 0:t?";

    response.preset = preset;
    response.container = `.${file.container}`;
    response.handbrakeMode = false;
    response.ffmpegMode = true;
    response.reQueueAfter = true;
    response.processFile = transcodeStandardiseAudioCodecs.processFile;
    response.infoLog += transcodeStandardiseAudioCodecs.note;
    return response;
};

module.exports.details = details;
module.exports.plugin = plugin;
