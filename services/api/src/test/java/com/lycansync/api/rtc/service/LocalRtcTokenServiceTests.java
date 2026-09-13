package com.lycansync.api.rtc.service;

import com.auth0.jwt.JWT;
import com.auth0.jwt.algorithms.Algorithm;
import com.auth0.jwt.interfaces.DecodedJWT;
import com.lycansync.api.rtc.config.LiveKitProperties;
import com.lycansync.api.rtc.dto.RtcTokenResponse;
import com.lycansync.api.group.service.GroupService;
import com.lycansync.api.group.exception.GroupException;
import com.lycansync.api.common.error.ApiErrorCode;
import org.springframework.http.HttpStatus;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.UUID;
import com.lycansync.api.auth.model.AuthenticatedUser;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

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
    private static final UUID GROUP_ID = UUID.fromString("01b08c29-d1e5-4bca-987f-64946541e93b");
    private final GroupService groupService = mock(GroupService.class);

    private final LocalRtcTokenService localRtcTokenService = new LocalRtcTokenService(
            new LiveKitProperties("ws://127.0.0.1:7880", "http://127.0.0.1:7880", API_KEY, API_SECRET),
            groupService, Clock.fixed(SERVER_TIME, ZoneOffset.UTC));

    @Test
    void shouldSignGroupRoomTokenWithOnlyRequiredMediaPermissions() {
        RtcTokenResponse response = localRtcTokenService.issueToken(
                GROUP_ID, new AuthenticatedUser(UUID.randomUUID(), "小狼", false));
        DecodedJWT token = JWT.decode(response.token());

        // 解码只能读取内容，另外验证签名才能确认凭证确实由指定密钥签发。
        Algorithm.HMAC256(API_SECRET).verify(token);
        assertThat(token.getAlgorithm()).isEqualTo("HS256");
        assertThat(token.getIssuer()).isEqualTo(API_KEY);
        assertThat(token.getSubject()).isEqualTo(response.participantIdentity());
        assertThat(token.getClaim("name").asString()).isEqualTo("小狼");
        assertThat(response.serverUrl()).isEqualTo("ws://127.0.0.1:7880");
        assertThat(response.roomName()).isEqualTo("lycan-sync-group-" + GROUP_ID);

        Map<String, Object> grants = token.getClaim("video").asMap();
        assertThat(grants).containsExactlyInAnyOrderEntriesOf(Map.of(
                "room", "lycan-sync-group-" + GROUP_ID,
                "roomJoin", true,
                "canPublish", true,
                "canSubscribe", true,
                "canPublishSources", List.of("microphone", "screen_share"),
                "canPublishData", false,
                "canUpdateOwnMetadata", true
        ));
    }

    @Test
    void shouldUseClockForTenMinuteExpiryAndMatchResponseToJwtPrecision() {
        RtcTokenResponse response = localRtcTokenService.issueToken(
                GROUP_ID, new AuthenticatedUser(UUID.randomUUID(), "小狼", false));
        DecodedJWT token = JWT.decode(response.token());

        assertThat(token.getNotBeforeAsInstant()).isEqualTo(Instant.parse("2026-09-03T07:00:00Z"));
        assertThat(token.getExpiresAtAsInstant()).isEqualTo(Instant.parse("2026-09-03T07:10:00Z"));
        assertThat(response.expiresAt()).isEqualTo(token.getExpiresAtAsInstant());
    }

    @Test
    void shouldReuseAccountIdentityAcrossDevices() {
        AuthenticatedUser user = new AuthenticatedUser(UUID.randomUUID(), "小狼", false);
        RtcTokenResponse first = localRtcTokenService.issueToken(GROUP_ID, user);
        RtcTokenResponse second = localRtcTokenService.issueToken(GROUP_ID, user);
        assertThat(first.participantIdentity()).isEqualTo("user-" + user.id());
        assertThat(second.participantIdentity()).isEqualTo(first.participantIdentity());
    }

    @Test
    void shouldAssignDifferentIdentitiesToRequestsWithTheSameNickname() {
        RtcTokenResponse first = localRtcTokenService.issueToken(
                GROUP_ID, new AuthenticatedUser(UUID.randomUUID(), "小狼", false));
        RtcTokenResponse second = localRtcTokenService.issueToken(
                GROUP_ID, new AuthenticatedUser(UUID.randomUUID(), "小狼", false));

        assertThat(first.participantIdentity()).startsWith("user-");
        assertThat(first.participantIdentity()).isNotEqualTo(second.participantIdentity());
        assertThat(first.token()).isNotEqualTo(second.token());
    }

    @Test
    void shouldRejectUnknownBusinessRoomBeforeSigningToken() {
        AuthenticatedUser user = new AuthenticatedUser(UUID.randomUUID(), "小狼", false);

        doThrow(new GroupException(HttpStatus.NOT_FOUND, ApiErrorCode.GROUP_NOT_FOUND, "群组不存在"))
                .when(groupService).requireGroup(GROUP_ID);
        assertThatThrownBy(() -> localRtcTokenService.issueToken(GROUP_ID, user))
                .isInstanceOf(GroupException.class)
                .hasMessage("群组不存在");
        verify(groupService).requireGroup(GROUP_ID);
    }

    @Test
    void shouldKeepDifferentGroupsInDifferentRooms() {
        AuthenticatedUser user = new AuthenticatedUser(UUID.randomUUID(), "小狼", false);
        RtcTokenResponse first = localRtcTokenService.issueToken(GROUP_ID, user);
        RtcTokenResponse second = localRtcTokenService.issueToken(UUID.randomUUID(), user);
        assertThat(first.roomName()).isNotEqualTo(second.roomName());
        assertThat(first.participantIdentity()).isEqualTo(second.participantIdentity());
    }
}
