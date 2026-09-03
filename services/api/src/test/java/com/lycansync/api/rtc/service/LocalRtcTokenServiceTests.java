package com.lycansync.api.rtc.service;

import com.auth0.jwt.JWT;
import com.auth0.jwt.algorithms.Algorithm;
import com.auth0.jwt.interfaces.DecodedJWT;
import com.lycansync.api.rtc.config.LiveKitProperties;
import com.lycansync.api.rtc.dto.RtcTokenResponse;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 本地 RTC 凭证签名与权限测试。
 *
 * @author Wreckloud
 * @since 2026-09-03
 */
class LocalRtcTokenServiceTests {

    private static final String API_KEY = "local-test-key";
    private static final String API_SECRET = "local-test-secret-at-least-32-characters";
    private static final Instant SERVER_TIME = Instant.parse("2026-09-03T07:00:00.123Z");

    private final LocalRtcTokenService localRtcTokenService = new LocalRtcTokenService(
            new LiveKitProperties("ws://127.0.0.1:7880", API_KEY, API_SECRET),
            Clock.fixed(SERVER_TIME, ZoneOffset.UTC));

    @Test
    void shouldSignFixedRoomTokenWithOnlyRequiredMediaPermissions() {
        RtcTokenResponse response = localRtcTokenService.issueToken(" 小狼 ");
        DecodedJWT token = JWT.decode(response.token());

        // 解码只能读取内容，另外验证签名才能确认凭证确实由指定密钥签发。
        Algorithm.HMAC256(API_SECRET).verify(token);
        assertThat(token.getAlgorithm()).isEqualTo("HS256");
        assertThat(token.getIssuer()).isEqualTo(API_KEY);
        assertThat(token.getSubject()).isEqualTo(response.participantIdentity());
        assertThat(token.getClaim("name").asString()).isEqualTo("小狼");
        assertThat(response.serverUrl()).isEqualTo("ws://127.0.0.1:7880");
        assertThat(response.roomName()).isEqualTo("lycan-sync-dev");

        Map<String, Object> grants = token.getClaim("video").asMap();
        assertThat(grants).containsExactlyInAnyOrderEntriesOf(Map.of(
                "room", "lycan-sync-dev",
                "roomJoin", true,
                "canPublish", true,
                "canSubscribe", true,
                "canPublishSources", List.of("microphone", "screen_share"),
                "canPublishData", false,
                "canUpdateOwnMetadata", false
        ));
    }

    @Test
    void shouldUseClockForTenMinuteExpiryAndMatchResponseToJwtPrecision() {
        RtcTokenResponse response = localRtcTokenService.issueToken("小狼");
        DecodedJWT token = JWT.decode(response.token());

        assertThat(token.getNotBeforeAsInstant()).isEqualTo(Instant.parse("2026-09-03T07:00:00Z"));
        assertThat(token.getExpiresAtAsInstant()).isEqualTo(Instant.parse("2026-09-03T07:10:00Z"));
        assertThat(response.expiresAt()).isEqualTo(token.getExpiresAtAsInstant());
    }

    @Test
    void shouldAssignDifferentIdentitiesToRequestsWithTheSameNickname() {
        RtcTokenResponse first = localRtcTokenService.issueToken("小狼");
        RtcTokenResponse second = localRtcTokenService.issueToken("小狼");

        assertThat(first.participantIdentity()).startsWith("dev-");
        assertThat(first.participantIdentity()).isNotEqualTo(second.participantIdentity());
        assertThat(first.token()).isNotEqualTo(second.token());
    }
}
