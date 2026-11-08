#pragma once

#include <obs.h>
#include <string>

void register_voice_filter();
bool voice_filter_failed();
std::string voice_filter_metrics(obs_source_t *filter);
