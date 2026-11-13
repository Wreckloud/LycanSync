#pragma once

#include <obs.h>
#include <string>

void register_voice_filter();
bool voice_filter_failed();
std::string voice_filter_metrics(obs_source_t *filter);
void voice_filter_echo_enabled(obs_source_t *filter, bool enabled);
void voice_filter_reference(obs_source_t *filter, const obs_audio_data *audio);
std::string voice_filter_echo_metrics(obs_source_t *filter);
