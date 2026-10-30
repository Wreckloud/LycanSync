package com.lycansync.api.audio.controller;

import com.lycansync.api.audio.exception.AudioProcessingException;
import com.lycansync.api.audio.service.EntranceSoundService;
import com.lycansync.api.auth.config.AuthConfiguration;
import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.auth.service.AuthService;
import com.lycansync.api.common.error.ApiErrorCode;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import java.util.UUID;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 音效处理认证边界、二进制响应与固定错误说明。
 *
 * @author Wreckloud
 * @since 2026-10-30
 */
@WebMvcTest(EntranceSoundController.class)
@Import(AuthConfiguration.class)
class EntranceSoundControllerTests {

    @Autowired private MockMvc mvc;
    @MockitoBean private AuthService auth;
    @MockitoBean private EntranceSoundService service;

    @Test
    void shouldRequireAuthenticationBeforeReadingAudio() throws Exception {
        mvc.perform(post("/api/audio/entrance-sound/normalize").contentType(MediaType.APPLICATION_OCTET_STREAM).content(new byte[10]))
                .andExpect(status().isUnauthorized());
        verifyNoInteractions(service);
    }

    @Test
    void shouldReturnOnlyProcessedWavWithoutCaching() throws Exception {
        when(auth.authenticate("test-session")).thenReturn(new AuthenticatedUser(UUID.randomUUID(), "测试", false));
        when(service.normalize(any())).thenReturn(new byte[]{1, 2});
        mvc.perform(post("/api/audio/entrance-sound/normalize").header("Authorization", "Bearer test-session")
                        .contentType(MediaType.APPLICATION_OCTET_STREAM).content(new byte[10]))
                .andExpect(status().isOk()).andExpect(header().string("Cache-Control", "no-store"))
                .andExpect(header().string("X-Content-Type-Options", "nosniff"))
                .andExpect(content().contentType("audio/wav")).andExpect(content().bytes(new byte[]{1, 2}));
    }

    @Test
    void shouldExposeBusyReasonWithoutToolOutput() throws Exception {
        when(auth.authenticate("test-session")).thenReturn(new AuthenticatedUser(UUID.randomUUID(), "测试", false));
        when(service.normalize(any())).thenThrow(new AudioProcessingException(HttpStatus.TOO_MANY_REQUESTS,
                ApiErrorCode.AUDIO_PROCESSING_BUSY, "服务器正在处理另一段音效，请稍后重试"));
        mvc.perform(post("/api/audio/entrance-sound/normalize").header("Authorization", "Bearer test-session")
                        .contentType(MediaType.APPLICATION_OCTET_STREAM).content(new byte[10]))
                .andExpect(status().isTooManyRequests()).andExpect(jsonPath("$.code").value("AUDIO_PROCESSING_BUSY"));
    }
}
