#include <windows.h>
#include <algorithm>
#include <cmath>
#include <iostream>
#include <stdexcept>
#include <string>
extern "C" {
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libavutil/opt.h>
#include <libswscale/swscale.h>
}

namespace {
void check(int result) {
  if (result >= 0) return;
  char error[AV_ERROR_MAX_STRING_SIZE];
  av_strerror(result, error, sizeof(error));
  throw std::runtime_error(error);
}
std::string utf8(const wchar_t *value) {
  int size = WideCharToMultiByte(CP_UTF8, 0, value, -1, nullptr, 0, nullptr, nullptr);
  std::string result(size, '\0');
  WideCharToMultiByte(CP_UTF8, 0, value, -1, result.data(), size, nullptr, nullptr);
  result.pop_back();
  return result;
}

// 独立进程复用随 OBS 发布的 FFmpeg。精确解码截取视频，原片和采集进程不参与写入。
struct Clip {
  AVFormatContext *input = nullptr, *output = nullptr;
  AVCodecContext *decoder = nullptr, *encoder = nullptr;
  AVFrame *decoded = av_frame_alloc(), *converted = av_frame_alloc();
  AVPacket *packet = av_packet_alloc(), *encoded = av_packet_alloc();
  SwsContext *scale = nullptr;
  int video_index = -1, audio_index = -1;
  AVStream *video = nullptr, *audio = nullptr;
  double begin = 0, end = 0, origin = 0;
  int64_t last_pts = -1, frames = 0;
  int progress = -1;
  ~Clip() {
    av_packet_free(&packet); av_packet_free(&encoded);
    av_frame_free(&decoded); av_frame_free(&converted);
    sws_freeContext(scale);
    avcodec_free_context(&decoder); avcodec_free_context(&encoder);
    avformat_close_input(&input);
    if (output) { if (output->pb) avio_closep(&output->pb); avformat_free_context(output); }
  }
  void drain_encoder() {
    int result;
    while ((result = avcodec_receive_packet(encoder, encoded)) >= 0) {
      // 编码器可能不传递 duration；MP4 最后一帧不能因此成为零时长样本。
      if (encoded->duration <= 0) encoded->duration = av_rescale_q(1, av_inv_q(encoder->framerate), encoder->time_base);
      int64_t remaining = static_cast<int64_t>(std::llround((end - begin) / av_q2d(encoder->time_base))) - encoded->pts;
      if (remaining > 0) encoded->duration = std::min(encoded->duration, remaining);
      av_packet_rescale_ts(encoded, encoder->time_base, video->time_base);
      encoded->stream_index = video->index;
      check(av_interleaved_write_frame(output, encoded));
      av_packet_unref(encoded);
    }
    if (result != AVERROR(EAGAIN) && result != AVERROR_EOF) check(result);
  }
  void drain_decoder() {
    int result;
    while ((result = avcodec_receive_frame(decoder, decoded)) >= 0) {
      if (decoded->best_effort_timestamp == AV_NOPTS_VALUE) throw std::runtime_error("Missing video timestamps");
      double time = decoded->best_effort_timestamp * av_q2d(input->streams[video_index]->time_base) - origin;
      if (time + 0.000001 >= begin && time < end) {
        check(av_frame_make_writable(converted));
        scale = sws_getCachedContext(scale, decoded->width, decoded->height, static_cast<AVPixelFormat>(decoded->format),
          encoder->width, encoder->height, encoder->pix_fmt, SWS_BILINEAR, nullptr, nullptr, nullptr);
        if (!scale) throw std::runtime_error("Pixel conversion unavailable");
        if (sws_scale(scale, decoded->data, decoded->linesize, 0, decoded->height, converted->data, converted->linesize) <= 0)
          throw std::runtime_error("Pixel conversion failed");
        converted->pts = std::max(last_pts + 1, static_cast<int64_t>(std::llround((time - begin) / av_q2d(encoder->time_base))));
        converted->duration = decoded->duration > 0
          ? av_rescale_q(decoded->duration, input->streams[video_index]->time_base, encoder->time_base)
          : av_rescale_q(1, av_inv_q(encoder->framerate), encoder->time_base);
        converted->duration = std::max<int64_t>(1, std::min(converted->duration,
          static_cast<int64_t>(std::llround((end - time) / av_q2d(encoder->time_base)))));
        last_pts = converted->pts;
        check(avcodec_send_frame(encoder, converted)); drain_encoder(); frames++;
        int percent = std::min(99, static_cast<int>((time - begin) * 100 / (end - begin)));
        if (percent != progress) { progress = percent; std::cout << progress << std::endl; }
      }
      av_frame_unref(decoded);
    }
    if (result != AVERROR(EAGAIN) && result != AVERROR_EOF) check(result);
  }
  void run(const std::string &source, const std::string &destination) {
    check(avformat_open_input(&input, source.c_str(), nullptr, nullptr));
    check(avformat_find_stream_info(input, nullptr));
    video_index = av_find_best_stream(input, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0); check(video_index);
    audio_index = av_find_best_stream(input, AVMEDIA_TYPE_AUDIO, -1, -1, nullptr, 0);
    auto *source_video = input->streams[video_index];
    origin = input->start_time != AV_NOPTS_VALUE ? input->start_time / double(AV_TIME_BASE)
      : source_video->start_time != AV_NOPTS_VALUE ? source_video->start_time * av_q2d(source_video->time_base) : 0;
    if (input->duration != AV_NOPTS_VALUE && end > input->duration / double(AV_TIME_BASE) + 0.1)
      throw std::runtime_error("Clip exceeds recording duration");
    const auto *decode_codec = avcodec_find_decoder(source_video->codecpar->codec_id);
    const auto *encode_codec = avcodec_find_encoder_by_name("libx264");
    if (!decode_codec || !encode_codec) throw std::runtime_error("Video codec unavailable");
    decoder = avcodec_alloc_context3(decode_codec); encoder = avcodec_alloc_context3(encode_codec);
    if (!decoder || !encoder || !decoded || !converted || !packet || !encoded) throw std::bad_alloc();
    check(avcodec_parameters_to_context(decoder, source_video->codecpar));
    decoder->thread_count = 2; check(avcodec_open2(decoder, decode_codec, nullptr));
    check(avformat_alloc_output_context2(&output, nullptr, "mp4", destination.c_str()));
    video = avformat_new_stream(output, nullptr);
    if (!video) throw std::bad_alloc();
    encoder->width = decoder->width & ~1; encoder->height = decoder->height & ~1;
    encoder->pix_fmt = AV_PIX_FMT_YUV420P; encoder->time_base = AVRational{1, 90000};
    encoder->framerate = av_guess_frame_rate(input, source_video, nullptr);
    if (encoder->framerate.num <= 0 || encoder->framerate.den <= 0) throw std::runtime_error("Recording frame rate unavailable");
    encoder->sample_aspect_ratio = decoder->sample_aspect_ratio;
    encoder->thread_count = 2;
    encoder->color_range = AVCOL_RANGE_MPEG;
    encoder->colorspace = decoder->colorspace;
    encoder->color_primaries = decoder->color_primaries; encoder->color_trc = decoder->color_trc;
    if (output->oformat->flags & AVFMT_GLOBALHEADER) encoder->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
    check(av_opt_set(encoder->priv_data, "preset", "veryfast", 0));
    check(av_opt_set(encoder->priv_data, "crf", "20", 0));
    check(avcodec_open2(encoder, encode_codec, nullptr));
    check(avcodec_parameters_from_context(video->codecpar, encoder)); video->time_base = encoder->time_base;
    if (audio_index >= 0) {
      // 正式录像只有一条混合 AAC 音轨。保留音频包，边界以 AAC 帧（约 21ms）为单位。
      auto *source_audio = input->streams[audio_index];
      if (source_audio->codecpar->codec_id != AV_CODEC_ID_AAC) throw std::runtime_error("Recording audio must be AAC");
      audio = avformat_new_stream(output, nullptr); if (!audio) throw std::bad_alloc();
      check(avcodec_parameters_copy(audio->codecpar, source_audio->codecpar));
      audio->codecpar->codec_tag = 0; audio->time_base = source_audio->time_base;
    }
    converted->format = encoder->pix_fmt; converted->width = encoder->width; converted->height = encoder->height;
    check(av_frame_get_buffer(converted, 32));
    check(avio_open(&output->pb, destination.c_str(), AVIO_FLAG_WRITE));
    AVDictionary *options = nullptr; av_dict_set(&options, "movflags", "+faststart", 0);
    int header = avformat_write_header(output, &options); av_dict_free(&options); check(header);
    check(av_seek_frame(input, -1, static_cast<int64_t>((begin + origin) * AV_TIME_BASE), AVSEEK_FLAG_BACKWARD));
    bool video_done = false, audio_done = audio_index < 0;
    int read_result;
    while ((read_result = av_read_frame(input, packet)) >= 0) {
      if (packet->stream_index == video_index && !video_done) {
        double time = packet->dts == AV_NOPTS_VALUE ? begin : packet->dts * av_q2d(source_video->time_base) - origin;
        if (time >= end + 1) video_done = true;
        else { check(avcodec_send_packet(decoder, packet)); drain_decoder(); }
      } else if (packet->stream_index == audio_index && !audio_done) {
        auto *source_audio = input->streams[audio_index];
        if (packet->pts == AV_NOPTS_VALUE || packet->dts == AV_NOPTS_VALUE) throw std::runtime_error("Missing audio timestamps");
        double time = packet->pts * av_q2d(source_audio->time_base) - origin;
        if (time >= end) audio_done = true;
        else if (time >= begin) {
          int64_t offset = static_cast<int64_t>(std::llround((begin + origin) / av_q2d(source_audio->time_base)));
          packet->pts -= offset; packet->dts -= offset;
          av_packet_rescale_ts(packet, source_audio->time_base, audio->time_base);
          packet->stream_index = audio->index; packet->pos = -1;
          check(av_interleaved_write_frame(output, packet));
        }
      }
      av_packet_unref(packet);
      if (video_done && audio_done) break;
    }
    if (read_result < 0 && read_result != AVERROR_EOF) check(read_result);
    check(avcodec_send_packet(decoder, nullptr)); drain_decoder();
    if (!frames) throw std::runtime_error("No frames in selected range");
    check(avcodec_send_frame(encoder, nullptr)); drain_encoder();
    check(av_write_trailer(output)); check(avio_closep(&output->pb));
    std::cout << "100" << std::endl;
  }
};
}

int wmain(int argc, wchar_t **argv) {
  av_log_set_level(AV_LOG_ERROR);
  try {
    if (argc != 5) throw std::runtime_error("Expected input output startMs endMs");
    Clip clip;
    clip.begin = std::stod(argv[3]) / 1000; clip.end = std::stod(argv[4]) / 1000;
    if (!std::isfinite(clip.begin) || !std::isfinite(clip.end) || clip.begin < 0 || clip.end <= clip.begin)
      throw std::runtime_error("Invalid clip range");
    clip.run(utf8(argv[1]), utf8(argv[2])); return 0;
  } catch (const std::exception &error) { std::cerr << error.what() << std::endl; return 1; }
}
