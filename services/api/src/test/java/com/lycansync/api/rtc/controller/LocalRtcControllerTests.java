package com.lycansync.api.rtc.controller;

import com.lycansync.api.rtc.dto.RtcTokenResponse;
import com.lycansync.api.rtc.service.LocalRtcTokenService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import java.time.Instant;

import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 本地 RTC 凭证接口测试。
 *
 * @author Wreckloud
 * @since 2026-09-03
 */
@WebMvcTest(LocalRtcController.class)
@ActiveProfiles("rtc-local")
class LocalRtcControllerTests {

    @Autowired
    private MockMvc mockMvc;

    @MockitoBean
    private LocalRtcTokenService localRtcTokenService;

    @Test
    void shouldReturnTokenWithoutCaching() throws Exception {
        when(localRtcTokenService.issueToken("小狼")).thenReturn(new RtcTokenResponse(
                "ws://127.0.0.1:7880", "lycan-sync-dev", "dev-test",
                "test-token", Instant.parse("2026-09-03T07:10:00Z")));

        mockMvc.perform(post("/api/rtc/token")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"displayName\":\"小狼\"}"))
                .andExpect(status().isOk())
                .andExpect(header().string("Cache-Control", "no-store"))
                .andExpect(jsonPath("$.serverUrl").value("ws://127.0.0.1:7880"))
                .andExpect(jsonPath("$.roomName").value("lycan-sync-dev"))
                .andExpect(jsonPath("$.participantIdentity").value("dev-test"))
                .andExpect(jsonPath("$.token").value("test-token"))
                .andExpect(jsonPath("$.expiresAt").value("2026-09-03T07:10:00Z"))
                .andExpect(jsonPath("$.apiSecret").doesNotExist());
    }

    @ParameterizedTest
    @ValueSource(strings = {"{}", "{\"displayName\":null}", "{\"displayName\":\"\"}", "{\"displayName\":\"   \"}"})
    void shouldRejectMissingOrBlankNickname(String requestBody) throws Exception {
        mockMvc.perform(post("/api/rtc/token")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(requestBody))
                .andExpect(status().isBadRequest())
                .andExpect(content().contentTypeCompatibleWith("application/problem+json"))
                .andExpect(jsonPath("$.code").value("INVALID_REQUEST"));

        verifyNoInteractions(localRtcTokenService);
    }

    @Test
    void shouldRejectNicknameLongerThanThirtyTwoCharacters() throws Exception {
        mockMvc.perform(post("/api/rtc/token")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"displayName\":\"" + "狼".repeat(33) + "\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("INVALID_REQUEST"));

        verifyNoInteractions(localRtcTokenService);
    }

    @ParameterizedTest
    @ValueSource(strings = {"", "{"})
    void shouldRejectMissingOrMalformedJson(String requestBody) throws Exception {
        mockMvc.perform(post("/api/rtc/token")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(requestBody))
                .andExpect(status().isBadRequest())
                .andExpect(content().contentTypeCompatibleWith("application/problem+json"))
                .andExpect(jsonPath("$.code").value("INVALID_REQUEST"));

        verifyNoInteractions(localRtcTokenService);
    }
}
