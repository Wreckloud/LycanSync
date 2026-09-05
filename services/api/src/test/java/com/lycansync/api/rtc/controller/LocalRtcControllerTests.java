package com.lycansync.api.rtc.controller;

import com.lycansync.api.rtc.dto.RtcTokenResponse;
import com.lycansync.api.rtc.dto.RtcRoomSummaryResponse;
import com.lycansync.api.rtc.exception.RtcServiceUnavailableException;
import com.lycansync.api.rtc.service.LocalRtcRoomSummaryService;
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
import java.util.List;

import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
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

    @MockitoBean
    private LocalRtcRoomSummaryService localRtcRoomSummaryService;

    @Test
    void shouldReturnTokenWithoutCaching() throws Exception {
        when(localRtcTokenService.issueToken("pack", "小狼")).thenReturn(new RtcTokenResponse(
                "ws://127.0.0.1:7880", "lycan-sync-dev-pack", "dev-test",
                "test-token", Instant.parse("2026-09-03T07:10:00Z")));

        mockMvc.perform(post("/api/rtc/token")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"groupId\":\"pack\",\"displayName\":\"小狼\"}"))
                .andExpect(status().isOk())
                .andExpect(header().string("Cache-Control", "no-store"))
                .andExpect(jsonPath("$.serverUrl").value("ws://127.0.0.1:7880"))
                .andExpect(jsonPath("$.roomName").value("lycan-sync-dev-pack"))
                .andExpect(jsonPath("$.participantIdentity").value("dev-test"))
                .andExpect(jsonPath("$.token").value("test-token"))
                .andExpect(jsonPath("$.expiresAt").value("2026-09-03T07:10:00Z"))
                .andExpect(jsonPath("$.apiSecret").doesNotExist());
    }

    @ParameterizedTest
    @ValueSource(strings = {"{}", "{\"groupId\":\"pack\",\"displayName\":null}",
            "{\"groupId\":\"pack\",\"displayName\":\"\"}",
            "{\"groupId\":\"pack\",\"displayName\":\"   \"}",
            "{\"groupId\":\"INVALID GROUP\",\"displayName\":\"小狼\"}"})
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
                        .content("{\"groupId\":\"pack\",\"displayName\":\"" + "狼".repeat(33) + "\"}"))
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

    @Test
    void shouldReturnOnlyParticipantCountAndNamesWithoutCaching() throws Exception {
        when(localRtcRoomSummaryService.getSummary("pack"))
                .thenReturn(new RtcRoomSummaryResponse(2, List.of("小北", "阿澈")));

        mockMvc.perform(get("/api/rtc/room-summary").queryParam("groupId", "pack"))
                .andExpect(status().isOk())
                .andExpect(header().string("Cache-Control", "no-store"))
                .andExpect(jsonPath("$.participantCount").value(2))
                .andExpect(jsonPath("$.participantNames[0]").value("小北"))
                .andExpect(jsonPath("$.participantNames[1]").value("阿澈"))
                .andExpect(jsonPath("$.isSpeaking").doesNotExist())
                .andExpect(jsonPath("$.screenShares").doesNotExist());
    }

    @Test
    void shouldRejectInvalidSummaryGroupId() throws Exception {
        mockMvc.perform(get("/api/rtc/room-summary").queryParam("groupId", "INVALID GROUP"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("INVALID_REQUEST"));

        verifyNoInteractions(localRtcRoomSummaryService);
    }

    @Test
    void shouldReturnServiceUnavailableWhenLiveKitCannotBeQueried() throws Exception {
        when(localRtcRoomSummaryService.getSummary("pack"))
                .thenThrow(new RtcServiceUnavailableException("无法连接 LiveKit 房间服务"));

        mockMvc.perform(get("/api/rtc/room-summary").queryParam("groupId", "pack"))
                .andExpect(status().isServiceUnavailable())
                .andExpect(content().contentTypeCompatibleWith("application/problem+json"))
                .andExpect(jsonPath("$.code").value("RTC_SERVICE_UNAVAILABLE"));
    }
}
