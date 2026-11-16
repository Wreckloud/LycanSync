package com.lycansync.api.rtc.service;

import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.group.exception.GroupException;
import com.lycansync.api.group.service.GroupService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.annotation.DirtiesContext;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 在隔离 PostgreSQL 中验证真实区间累计、恢复及成员访问边界。
 *
 * @author Wreckloud
 * @since 2026-11-02
 */
@SpringBootTest
@Testcontainers
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class SharedVoiceTimeApplicationIT {
    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>("postgres:18.6-bookworm")
            .withDatabaseName("voice_test");
    private static final Instant START = Instant.parse("2026-11-02T00:00:00Z");
    private final UUID own = UUID.randomUUID();
    private final UUID peer = UUID.randomUUID();
    private final UUID outsider = UUID.randomUUID();
    private final UUID group = UUID.randomUUID();
    @Autowired private SharedVoiceTimeService time;
    @Autowired private GroupService groups;
    @Autowired private JdbcClient jdbc;

    @DynamicPropertySource
    static void database(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        registry.add("spring.datasource.username", POSTGRES::getUsername);
        registry.add("spring.datasource.password", POSTGRES::getPassword);
        registry.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        registry.add("spring.flyway.user", POSTGRES::getUsername);
        registry.add("spring.flyway.password", POSTGRES::getPassword);
    }

    @BeforeEach
    void prepareMembers() {
        jdbc.sql("TRUNCATE app_user CASCADE").update();
        for (UUID user : List.of(own, peer, outsider)) {
            jdbc.sql("INSERT INTO app_user(id,nickname,avatar,administrator,created_at) VALUES (?,?,'',false,now())")
                    .params(user, "测试成员").update();
        }
        jdbc.sql("INSERT INTO chat_group(id,name,description,avatar,owner_user_id,created_at,updated_at) VALUES (?,'测试群','','',?,now(),now())")
                .params(group, own).update();
        for (UUID user : List.of(own, peer)) {
            jdbc.sql("INSERT INTO group_member(group_id,user_id,joined_at) VALUES (?,?,now())").params(group, user).update();
        }
    }

    private void confirm(long seconds) {
        time.confirmRoom("RM_test", List.of(new SharedVoiceTimeService.ConnectedMember("PA_own", own),
                new SharedVoiceTimeService.ConnectedMember("PA_peer", peer)), START.plusSeconds(seconds));
    }

    private long seconds() {
        return groups.findMemberProfile(group, peer, new AuthenticatedUser(own, "自己", false)).sharedVoiceSeconds();
    }

    @Test
    void ownTimeUnionsMultipleDevicesAndRoomsWithoutInventingHistory() {
        assertThat(time.findOwnSeconds(own)).isZero();
        for (String room : List.of("RM_one", "RM_two")) {
            String participant = "PA_" + room;
            time.joined(room, participant, own, START);
            time.confirmRoom(room, List.of(new SharedVoiceTimeService.ConnectedMember(participant, own)), START.plusSeconds(30));
        }
        assertThat(time.findOwnSeconds(own)).isEqualTo(30);
        assertThat(time.findOwnSeconds(peer)).isZero();
    }

    @Test
    void countsIntersectionAndDoesNotReopenAfterRepeatedJoinOrLeave() {
        time.joined("RM_test", "PA_own", own, START);
        time.joined("RM_test", "PA_peer", peer, START.plusSeconds(5));
        confirm(20);
        time.left("RM_test", "PA_own", START.plusSeconds(25));
        confirm(30);
        assertThat(seconds()).isEqualTo(20);
        time.joined("RM_test", "PA_own", own, START);
        time.left("RM_test", "PA_own", START.plusSeconds(25));
        confirm(40);
        assertThat(seconds()).isEqualTo(20);
    }

    @Test
    void freezesUnconfirmedGapAndResumesWithoutCountingDowntime() {
        confirm(0);
        confirm(30);
        confirm(180);
        confirm(210);
        assertThat(seconds()).isEqualTo(60);
    }

    @Test
    void unionsOverlappingDevicesInsteadOfCountingTwice() {
        confirm(0);
        time.joined("RM_test", "PA_other_device", own, START.plusSeconds(10));
        time.confirmRoom("RM_test", List.of(new SharedVoiceTimeService.ConnectedMember("PA_own", own),
                new SharedVoiceTimeService.ConnectedMember("PA_peer", peer),
                new SharedVoiceTimeService.ConnectedMember("PA_other_device", own)), START.plusSeconds(30));
        assertThat(seconds()).isEqualTo(30);
    }

    @Test
    void missingParticipantDoesNotAccumulateUntilNextConfirmedInterval() {
        confirm(0);
        confirm(15);
        time.confirmRoom("RM_test", List.of(new SharedVoiceTimeService.ConnectedMember("PA_peer", peer)), START.plusSeconds(30));
        confirm(45);
        confirm(60);
        assertThat(seconds()).isEqualTo(30);
    }

    @Test
    void lateLeaveTrimsTheTailAndRoomFinishStopsBothParticipants() {
        confirm(0);
        confirm(30);
        time.left("RM_test", "PA_own", START.plusSeconds(25));
        assertThat(seconds()).isEqualTo(25);
        time.roomFinished("RM_test", START.plusSeconds(25));
        confirm(40);
        assertThat(seconds()).isEqualTo(25);
    }

    @Test
    void differentRoomsAndMissingHistoryReturnZeroButSelfRemainsAbsent() {
        time.confirmRoom("RM_a", List.of(new SharedVoiceTimeService.ConnectedMember("PA_own", own)), START);
        time.confirmRoom("RM_b", List.of(new SharedVoiceTimeService.ConnectedMember("PA_peer", peer)), START);
        time.confirmRoom("RM_a", List.of(new SharedVoiceTimeService.ConnectedMember("PA_own", own)), START.plusSeconds(30));
        time.confirmRoom("RM_b", List.of(new SharedVoiceTimeService.ConnectedMember("PA_peer", peer)), START.plusSeconds(30));
        assertThat(seconds()).isZero();
        assertThat(groups.findMemberProfile(group, own, new AuthenticatedUser(own, "自己", false)).sharedVoiceSeconds()).isNull();
        assertThatThrownBy(() -> groups.findMemberProfile(group, peer, new AuthenticatedUser(outsider, "群外", false)))
                .isInstanceOf(GroupException.class);
    }
}
