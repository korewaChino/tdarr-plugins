/* eslint-disable */

const details = () => ({
    id: "Tdarr_Plugin_korewaChino_HEVC_Transcode_Optimize",
    Name: "Transcode to HEVC or optimize existing HEVC files - Tiered based on resolution and bitrate",
    Type: "Video",
    Operation: "Transcode",
    Description: "Transcode to HEVC using NVENC, based on resolution and bitrate and also keeps everything except video. Attempts to also optimize existing HEVC files to target bitrate if possible.",
    Version: "0.1.0",
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
                    "ultrafast"
                ]
            },
            tooltip: "Choose the desired transcode preset"
        }
    ]
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const plugin = (file, librarySettings, inputs, otherArguments) => {
    const lib = require("../methods/lib")();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars,no-param-reassign
    inputs = lib.loadDefaultValues(inputs, details);
    var transcode = 0; //if this var changes to 1 the file will be transcoded
    var bitrateprobe = 0; //bitrate from ffprobe
    var bitratetarget = 0;
    var bitratemax = 0;
    var bitratecheck = 0;
    var subcli = `-c:s copy -c:t copy -c:d copy`;
    var maxmux = "";
    var map = "-map 0 -map 0:t? -map 0:d?";
    var transcode_preset = inputs.transcode_preset;
    //default values that will be returned
    var response = {
        processFile: false,
        preset: "",
        container: ".mkv",
        handBrakeMode: false,
        FFmpegMode: false,
        reQueueAfter: true,
        infoLog: "",
        maxmux: false,
        // debug: ""
    };
    var target_codec = "hevc_nvenc";

    //check if the file is a video, if not the function will be stopped immediately
    if (file.fileMedium !== "video") {
        response.processFile = false;
        response.infoLog += "☒File is not a video! \n";
        return response;
    } else {
        // bitrateprobe = file.ffProbeData.streams[0].bit_rate; // this doesn't work
        var stream = file.ffProbeData.streams[0];
        // response.infoLog += `file: ${JSON.stringify(file)}\n`;
        // response.debug = JSON.stringify(file);
        bitrateprobe = file.bit_rate;

        // response.infoLog += `bitrateprobe: ${bitrateprobe}\n`;
        // if (file.ffProbeData.bit_rate === undefined) {
        //     if (stream.tags) {
        //         bitrateprobe = stream.tags.BPS;
        //     }
        // } else {
        //     bitrateprobe = stream.bit_rate;
        // }
        
        response.infoLog += "☑File is a video! \n";
    }

    // If already HEVC then keep as is, but optimize anyways
    if (file.ffProbeData.streams[0].codec_name == "hevc") {
        response.processFile = false;
        response.infoLog += "☑File is already in hevc! \n";
        response.preset = `-c:v hevc_cuvid`;
    }

    //codec will be checked so it can be transcoded correctly
    if (file.video_codec_name == "h263") {
        response.preset = `-c:v h263_cuvid`;
    } else if (file.video_codec_name == "h264") {
        if (file.ffProbeData.streams[0].profile != "High 10") {
            //Remove HW Decoding for High 10 Profile
            response.preset = `-c:v h264_cuvid`;
        }
    } else if (file.video_codec_name == "mjpeg") {
        response.preset = `c:v mjpeg_cuvid`;
    } else if (file.video_codec_name == "mpeg1") {
        response.preset = `-c:v mpeg1_cuvid`;
    } else if (file.video_codec_name == "mpeg2") {
        response.preset = `-c:v mpeg2_cuvid`;
    }
    // skipping this one because it's empty
    //  else if (file.video_codec_name == 'mpeg4') {
    //    response.preset = ``
    //  }
    else if (file.video_codec_name == "vc1") {
        response.preset = `-c:v vc1_cuvid`;
    } else if (file.video_codec_name == "vp8") {
        response.preset = `-c:v vp8_cuvid`;
    } else if (file.video_codec_name == "vp9") {
        // response.preset = `-c:v vp9_cuvid`;
        response.processFile = false;
        response.infoLog += "☑File is already in vp9! \n";
    }

    //Set Subtitle Var before adding encode cli
    for (var i = 0; i < file.ffProbeData.streams.length; i++) {
        try {
            if (
                file.ffProbeData.streams[i].codec_name.toLowerCase() ==
                    "mov_text" &&
                file.ffProbeData.streams[i].codec_type.toLowerCase() ==
                    "subtitle"
            ) {
                subcli = `-c:s srt -c:t copy -c:d copy`;
            }
        } catch (err) {}
        //mitigate TrueHD audio causing Too many packets error
        try {
            if (
                file.ffProbeData.streams[i].codec_name.toLowerCase() ==
                    "truehd" ||
                (file.ffProbeData.streams[i].codec_name.toLowerCase() ==
                    "dts" &&
                    file.ffProbeData.streams[i].profile.toLowerCase() ==
                        "dts-hd ma") ||
                (file.ffProbeData.streams[i].codec_name.toLowerCase() ==
                    "aac" &&
                    file.ffProbeData.streams[i].sample_rate.toLowerCase() ==
                        "44100" &&
                    file.ffProbeData.streams[i].codec_type.toLowerCase() ==
                        "audio")
            ) {
                maxmux = ` -max_muxing_queue_size 9999`;
            }
        } catch (err) {}
        //mitigate errors due to embeded pictures
        try {
            if (
                (file.ffProbeData.streams[i].codec_name.toLowerCase() ==
                    "png" ||
                    file.ffProbeData.streams[i].codec_name.toLowerCase() ==
                        "bmp" ||
                    file.ffProbeData.streams[i].codec_name.toLowerCase() ==
                        "mjpeg") &&
                file.ffProbeData.streams[i].codec_type.toLowerCase() == "video"
            ) {
                map = `-map 0:v:0 -map 0:a -map 0:s? -map 0:t? -map 0:d?`;
            }
        } catch (err) {}
    }
        
    //file will be encoded if the resolution is 480p or 576p
    //codec will be checked so it can be transcoded correctly
    if (file.video_resolution === "480p" || file.video_resolution === "576p") {
        bitratecheck = 1000000;
        if (bitrateprobe != null && bitrateprobe < bitratecheck) {
            bitratetarget = parseInt((bitrateprobe * 0.8) / 1000); // Lower Bitrate to 60% of original and convert to KB
            bitratemax = bitratetarget + 500; // Set max bitrate to 6MB Higher
        } else {
            bitratetarget = 1000;
            bitratemax = 1500;
        }
        response.preset += `,${map} -dn -c:v ${target_codec} -pix_fmt p010le -qmin 0 -cq:v 28 -b:v ${bitratetarget}k -maxrate:v 1500k -preset ${transcode_preset} -rc-lookahead 32 -spatial_aq:v 1 -aq-strength:v 8 -a53cc 0 -c:a copy ${subcli}${maxmux}`;
        transcode = 1;
    }

    //file will be encoded if the resolution is 720p
    //codec will be checked so it can be transcoded correctly
    if (file.video_resolution === "720p") {
        bitratecheck = 2500000;
        if (bitrateprobe != null && bitrateprobe < bitratecheck) {
            bitratetarget = parseInt((bitrateprobe * 0.8) / 1000); // Lower Bitrate to 60% of original and convert to KB
            bitratemax = bitratetarget + 2000; // Set max bitrate to 6MB Higher
        } else {
            bitratetarget = 2000;
            bitratemax = 4000;
        }
        response.preset += `,${map} -dn -c:v ${target_codec} -pix_fmt p010le -qmin 0 -cq:v 28 -b:v ${bitratetarget}k -maxrate:v ${bitratemax}k -preset ${transcode_preset} -rc-lookahead 32 -spatial_aq:v 1 -aq-strength:v 8 -a53cc 0 -c:a copy ${subcli}${maxmux}`;
        transcode = 1;
    }
    //file will be encoded if the resolution is 1080p
    //codec will be checked so it can be transcoded correctly
    if (file.video_resolution === "1080p") {
        bitratecheck = 3200000;
        if (bitrateprobe != null && bitrateprobe < bitratecheck) {
            bitratetarget = parseInt((bitrateprobe * 0.8) / 1000); // Lower Bitrate to 60% of original and convert to KB
            bitratemax = bitratetarget + 3200; // Set max bitrate to 6MB Higher
        } else {
            bitratetarget = 3200;
            bitratemax = 5000;
        }

        response.preset += `,${map} -dn -c:v ${target_codec} -pix_fmt p010le -qmin 0 -cq:v 28 -b:v ${bitratetarget}k -maxrate:v ${bitratemax}k -preset ${transcode_preset} -rc-lookahead 32 -spatial_aq:v 1 -aq-strength:v 8 -a53cc 0 -c:a copy -c:t copy ${subcli}${maxmux}`;
        transcode = 1;
    }
    //file will be encoded if the resolution is 4K
    //codec will be checked so it can be transcoded correctly
    if (file.video_resolution === "4KUHD") {
        bitratecheck = 14000000;
        if (bitrateprobe != null && bitrateprobe < bitratecheck) {
            bitratetarget = parseInt((bitrateprobe * 0.7) / 1000); // Lower Bitrate to 60% of original and convert to KB
            bitratemax = bitratetarget + 6000; // Set max bitrate to 6MB Higher
        } else {
            bitratetarget = 14000;
            bitratemax = 20000;
        }
        response.preset += `,${map} -dn -c:v ${target_codec} -pix_fmt p010le -qmin 0 -cq:v 31 -b:v ${bitratetarget}k -maxrate:v ${bitratemax}k -preset ${transcode_preset} -rc-lookahead 32 -spatial_aq:v 1 -aq-strength:v 8 -a53cc 0 -c:a copy ${subcli}${maxmux}`;
        transcode = 1;
    }
    //check if the file is eligible for transcoding
    //if true the neccessary response values will be changed
    if (transcode == 1) {
        response.processFile = true;
        response.FFmpegMode = true;
        response.reQueueAfter = true;
        response.infoLog += `☒File is ${file.video_resolution}!\n`;
        response.infoLog += `☒File bitrate is ${bitrateprobe / 1000}kbps\n`;
        response.infoLog += `☒Target Bitrate set to ${bitratecheck / 1000}kbps!\n`;
        if (bitrateprobe < bitratecheck) {
            response.infoLog += `File bitrate is LOWER than the Default Target Bitrate!\n`;
            // Check if HEVC already
            if (file.ffProbeData.streams[0].codec_name == "hevc") {
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