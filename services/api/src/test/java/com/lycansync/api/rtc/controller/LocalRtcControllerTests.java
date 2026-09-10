package com.lycansync.api.rtc.controller;

import com.lycansync.api.auth.config.AuthConfiguration;
import com.lycansync.api.auth.model.AuthUser;
import com.lycansync.api.auth.service.AuthService;
import com.lycansync.api.rtc.dto.RtcRoomSummaryResponse;
import com.lycansync.api.rtc.dto.RtcTokenResponse;
import com.lycansync.api.rtc.exception.RtcServiceUnavailableException;
import com.lycansync.api.rtc.service.LocalRtcRoomSummaryService;
import com.lycansync.api.rtc.service.LocalRtcTokenService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

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
@Import(AuthConfiguration.class)
class LocalRtcControllerTests {

    private static final String SESSION_TOKEN = "test-session-token";
    private static final String AUTHORIZATION = "Bearer " + SESSION_TOKEN;
    private static final AuthUser AUTHENTICATED_USER =
            new AuthUser(UUID.fromString("2d983469-4442-44f5-b5a8-f3819f16a611"), "小狼", "", false);

    @Autowired
    private MockMvc mockMvc;

    @MockitoBean
    private LocalRtcTokenService localRtcTokenService;

    @MockitoBean
    private LocalRtcRoomSummaryService localRtcRoomSummaryService;

    @MockitoBean
    private AuthService authService;

    @BeforeEach
    void authenticateRequest() {
        when(authService.authenticate(SESSION_TOKEN)).thenReturn(AUTHENTICATED_USER);
    }

    @Test
    void shouldReturnTokenWithoutCaching() throws Exception {
        when(localRtcTokenService.issueToken("pack", AUTHENTICATED_USER)).thenReturn(new RtcTokenResponse(
                "ws://127.0.0.1:7880", "lycan-sync-dev-pack", "dev-test",
                "test-token", Instant.parse("2026-09-03T07:10:00Z")));

        mockMvc.perform(post("/api/rtc/token")
                        .header(HttpHeaders.AUTHORIZATION, AUTHORIZATION)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"groupId\":\"pack\"}"))
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
    @ValueSource(strings = {"{}", "{\"groupId\":\"INVALID GROUP\"}"})
    void shouldRejectMissingOrInvalidGroup(String requestBody) throws Exception {
        mockMvc.perform(post("/api/rtc/token")
                        .header(HttpHeaders.AUTHORIZATION, AUTHORIZATION)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(requestBody))
                .andExpect(status().isBadRequest())
                .andExpect(content().contentTypeCompatibleWith("application/problem+json"))
                .andExpect(jsonPath("$.code").value("INVALID_REQUEST"));

        verifyNoInteractions(localRtcTokenService);
    }
    @ParameterizedTest
    @ValueSource(strings = {"", "{"})
    void shouldRejectMissingOrMalformedJson(String requestBody) throws Exception {
        mockMvc.perform(post("/api/rtc/token")
                        .header(HttpHeaders.AUTHORIZATION, AUTHORIZATION)
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

        mockMvc.perform(get("/api/rtc/room-summary")
                        .header(HttpHeaders.AUTHORIZATION, AUTHORIZATION)
                        .queryParam("groupId", "pack"))
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
        mockMvc.perform(get("/api/rtc/room-summary")
                        .header(HttpHeaders.AUTHORIZATION, AUTHORIZATION)
                        .queryParam("groupId", "INVALID GROUP"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("INVALID_REQUEST"));

        verifyNoInteractions(localRtcRoomSummaryService);
    }

    @Test
    void shouldReturnServiceUnavailableWhenLiveKitCannotBeQueried() throws Exception {
        when(localRtcRoomSummaryService.getSummary("pack"))
                .thenThrow(new RtcServiceUnavailableException("无法连接 LiveKit 房间服务"));

        mockMvc.perform(get("/api/rtc/room-summary")
                        .header(HttpHeaders.AUTHORIZATION, AUTHORIZATION)
                        .queryParam("groupId", "pack"))
                .andExpect(status().isServiceUnavailable())
                .andExpect(content().contentTypeCompatibleWith("application/problem+json"))
                .andExpect(jsonPath("$.code").value("RTC_SERVICE_UNAVAILABLE"));
    }
}
