package com.lycansync.api.rtc.service;

import com.auth0.jwt.JWT;
import com.auth0.jwt.algorithms.Algorithm;
import com.lycansync.api.auth.exception.AuthException;
import com.lycansync.api.group.mapper.GroupMapper;
import com.lycansync.api.rtc.config.LiveKitProperties;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.Base64;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * 信令凭证校验与数据库当前成员资格边界。
 *
 * @author Wreckloud
 * @since 2026-10-13
 */
class GroupRtcAdmissionServiceTests {
    private static final String SECRET = "test-secret-at-least-32-characters";
    private final UUID groupId = UUID.randomUUID();
    private final UUID roomKey = UUID.randomUUID();
    private final UUID userId = UUID.randomUUID();
    private final GroupMapper groups = mock(GroupMapper.class);
    private final GroupRtcAccessService rtc = mock(GroupRtcAccessService.class);
    private final GroupRtcAdmissionService admission = new GroupRtcAdmissionService(groups,
            new LiveKitProperties("wss://localhost:8443", "http://localhost:7990", "test-key", SECRET), rtc);

    @Test
    void acceptsCurrentMemberUsingQueryOrBearerCredential() {
        when(groups.lockRtcGroup(roomKey)).thenReturn(groupId.toString());
        when(groups.memberExists(groupId, userId)).thenReturn(true);
        String token = token(SECRET, "test-key", Instant.now().plusSeconds(600), roomKey, userId);
        admission.requireMember(null, token);
        admission.requireMember("Bearer " + token, "irrelevant-query-value");
        verify(groups, org.mockito.Mockito.times(2)).memberExists(groupId, userId);
    }

    @Test
    void rejectsRemovedMemberEvenWhenSignedTokenHasNotExpired() {
        when(groups.lockRtcGroup(roomKey)).thenReturn(groupId.toString());
        String token = token(SECRET, "test-key", Instant.now().plusSeconds(600), roomKey, userId);
        assertThatThrownBy(() -> admission.requireMember(null, token)).isInstanceOf(AuthException.class)
                .hasMessage("你已不在此群，无法连接语音");
    }

    @Test
    void rejectsMissingDissolvedOrLegacyRoom() {
        String token = token(SECRET, "test-key", Instant.now().plusSeconds(600), roomKey, userId);
        assertThatThrownBy(() -> admission.requireMember(null, token)).isInstanceOf(AuthException.class)
                .hasMessage("你已不在此群，无法连接语音");
    }

    @Test
    void rejectsInvalidIssuerSignatureAndExpiredTokensBeforeReadingMembership() {
        for (String token : new String[] {
                token("forged-key", "test-key", Instant.now().plusSeconds(60), roomKey, userId),
                token(SECRET, "other-key", Instant.now().plusSeconds(60), roomKey, userId),
                token(SECRET, "test-key", Instant.now().minusSeconds(1), roomKey, userId),
                "not-a-jwt"}) {
            assertThatThrownBy(() -> admission.requireMember(null, token)).isInstanceOf(AuthException.class);
        }
        verifyNoInteractions(groups);
    }

    @Test
    void requiresExpirationAndRoomJoinGrantWithCanonicalIdentity() {
        for (String token : new String[] {
                JWT.create().withIssuer("test-key").withSubject("user-" + userId)
                        .withClaim("video", Map.of("roomJoin", true, "room", "lycan-sync-group-" + roomKey))
                        .sign(Algorithm.HMAC256(SECRET)),
                JWT.create().withIssuer("test-key").withSubject("user-1-1-1-1-1")
                        .withExpiresAt(Instant.now().plusSeconds(60))
                        .withClaim("video", Map.of("roomJoin", true, "room", "lycan-sync-group-" + roomKey))
                        .sign(Algorithm.HMAC256(SECRET)),
                JWT.create().withIssuer("test-key").withSubject("user-" + userId)
                        .withExpiresAt(Instant.now().plusSeconds(60))
                        .withClaim("video", Map.of("roomJoin", false, "room", "lycan-sync-group-" + roomKey))
                        .sign(Algorithm.HMAC256(SECRET))}) {
            assertThatThrownBy(() -> admission.requireMember(null, token)).isInstanceOf(AuthException.class);
        }
        verifyNoInteractions(groups);
    }

    @Test
    void doesNotFallBackToQueryWhenAuthorizationHeaderIsInvalid() {
        assertThatThrownBy(() -> admission.requireMember("Basic invalid",
                token(SECRET, "test-key", Instant.now().plusSeconds(60), roomKey, userId)))
                .isInstanceOf(AuthException.class);
        verifyNoInteractions(groups);
    }

    private String token(String secret, String issuer, Instant expiry, UUID key, UUID member) {
        return JWT.create().withIssuer(issuer).withSubject("user-" + member).withExpiresAt(expiry)
                .withClaim("video", Map.of("roomJoin", true, "room", "lycan-sync-group-" + key))
                .sign(Algorithm.HMAC256(secret));
    }

    @Test
    void signedLateJoinEventDisconnectsOnlyRemovedParticipant() throws Exception {
        when(groups.lockRtcGroup(roomKey)).thenReturn(groupId.toString());
        String body = joinedEvent();
        admission.checkJoinedParticipant(body, eventToken(body));
        verify(rtc).removeParticipant(roomKey, userId);
    }

    @Test
    void signedJoinEventKeepsCurrentMemberConnected() throws Exception {
        when(groups.lockRtcGroup(roomKey)).thenReturn(groupId.toString());
        when(groups.memberExists(groupId, userId)).thenReturn(true);
        String body = joinedEvent();
        admission.checkJoinedParticipant(body, eventToken(body));
        verifyNoInteractions(rtc);
    }

    @Test
    void forgedOrAlteredWebhookCannotTriggerParticipantRemoval() throws Exception {
        String body = joinedEvent();
        assertThatThrownBy(() -> admission.checkJoinedParticipant(body, "forged"))
                .isInstanceOf(AuthException.class);
        String signature = eventToken(body);
        assertThatThrownBy(() -> admission.checkJoinedParticipant(body + " ", signature))
                .isInstanceOf(AuthException.class);
        verifyNoInteractions(groups, rtc);
    }

    private String joinedEvent() {
        return "{\"event\":\"participant_joined\",\"room\":{\"name\":\"lycan-sync-group-" + roomKey
                + "\"},\"participant\":{\"identity\":\"user-" + userId + "\"}}";
    }

    private String eventToken(String body) throws Exception {
        String digest = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256")
                .digest(body.getBytes(StandardCharsets.UTF_8)));
        return JWT.create().withIssuer("test-key").withExpiresAt(Instant.now().plusSeconds(60))
                .withClaim("sha256", digest).sign(Algorithm.HMAC256(SECRET));
    }
}
