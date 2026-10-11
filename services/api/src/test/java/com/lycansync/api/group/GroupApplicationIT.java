package com.lycansync.api.group;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.lycansync.api.auth.dto.LocalRegistrationRequest;
import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.auth.service.AuthService;
import com.lycansync.api.auth.service.LocalAuthService;
import com.lycansync.api.common.image.AvatarImageProcessor;
import com.lycansync.api.group.dto.CreateGroupRequest;
import com.lycansync.api.group.service.GroupService;
import com.lycansync.api.presence.dto.PresenceHeartbeatRequest;
import com.lycansync.api.presence.mapper.PresenceMapper;
import com.lycansync.api.presence.model.UserPresenceStatus;
import com.lycansync.api.presence.service.PresenceService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.time.Instant;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.asyncDispatch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.request;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 使用隔离 PostgreSQL 验证注册账号的隐式群组成员身份。
 *
 * @author Wreckloud
 * @since 2026-09-10
 */
@Testcontainers
@SpringBootTest
@AutoConfigureMockMvc
class GroupApplicationIT {

    private static final String PASSWORD = "group-test-password";
    private static final String AVATAR = "data:image/png;base64,"
            + "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>("postgres:18.6-bookworm");

    @DynamicPropertySource
    static void database(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        registry.add("spring.datasource.username", POSTGRES::getUsername);
        registry.add("spring.datasource.password", POSTGRES::getPassword);
        registry.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        registry.add("spring.flyway.user", POSTGRES::getUsername);
        registry.add("spring.flyway.password", POSTGRES::getPassword);
    }

    @Autowired
    private LocalAuthService localAuth;

    @Autowired
    private GroupService groupService;

    @Autowired
    private PresenceService presenceService;

    @Autowired
    private AuthService authService;

    @Autowired
    private PresenceMapper presenceMapper;

    @Autowired
    private JdbcClient jdbc;

    @Autowired
    private MockMvc mvc;

    @Autowired
    private ObjectMapper objectMapper;

    @BeforeEach
    void resetDatabase() {
        jdbc.sql("TRUNCATE auth_access_link, user_presence, chat_attachment, chat_file_attachment, chat_message, chat_group, auth_session, auth_local_credential, app_user").update();
        jdbc.sql("UPDATE system_state SET initialized_at = NULL WHERE id = 1").update();
    }

    @Test
    void shouldShowNewGroupToEveryRegisteredUser() throws Exception {
        String ownerToken = localAuth.register(new LocalRegistrationRequest("Owner", PASSWORD)).sessionToken();
        String friendToken = localAuth.register(new LocalRegistrationRequest("Friend", PASSWORD)).sessionToken();

        String response = mvc.perform(post("/api/groups")
                        .header(HttpHeaders.AUTHORIZATION, "Bearer " + ownerToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"  周末开黑  \",\"description\":\"  周六晚上  \"}"))
                .andExpect(status().isCreated())
                .andExpect(header().string(HttpHeaders.LOCATION,
                        org.hamcrest.Matchers.matchesPattern("/api/groups/[0-9a-f-]+")))
                .andExpect(jsonPath("$.name").value("周末开黑"))
                .andExpect(jsonPath("$.description").value("周六晚上"))
                .andExpect(jsonPath("$.role").value("OWNER"))
                .andExpect(jsonPath("$.memberCount").value(2))
                .andExpect(jsonPath("$.members[0].nickname").value("Owner"))
                .andExpect(jsonPath("$.members[0].role").value("OWNER"))
                .andExpect(jsonPath("$.members[1].nickname").value("Friend"))
                .andExpect(jsonPath("$.members[1].role").value("MEMBER"))
                .andReturn().getResponse().getContentAsString();

        String groupId = objectMapper.readTree(response).get("id").asText();
        mvc.perform(get("/api/groups").header(HttpHeaders.AUTHORIZATION, "Bearer " + friendToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].id").value(groupId))
                .andExpect(jsonPath("$[0].role").value("MEMBER"))
                .andExpect(jsonPath("$[0].memberCount").value(2));
        mvc.perform(get("/api/groups/{groupId}", groupId)
                        .header(HttpHeaders.AUTHORIZATION, "Bearer " + friendToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.role").value("MEMBER"))
                .andExpect(jsonPath("$.members.length()").value(2));
        assertThat(jdbc.sql("SELECT count(*) FROM chat_group WHERE owner_user_id IS NOT NULL")
                .query(Long.class).single()).isOne();
    }

    @Test
    void shouldUpdateOnlineStatusAfterHeartbeat() throws Exception {
        String ownerToken = localAuth.register(new LocalRegistrationRequest("Owner", PASSWORD)).sessionToken();
        String response = mvc.perform(post("/api/groups")
                        .header(HttpHeaders.AUTHORIZATION, "Bearer " + ownerToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"心跳测试\"}"))
                .andExpect(status().isCreated())
                .andReturn().getResponse().getContentAsString();
        String groupId = objectMapper.readTree(response).get("id").asText();

        mvc.perform(post("/api/presence/heartbeat")
                        .header(HttpHeaders.AUTHORIZATION, "Bearer " + ownerToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"status\":\"ONLINE\",\"activity\":null}"))
                .andExpect(status().isNoContent());

        mvc.perform(post("/api/presence/heartbeat")
                        .header(HttpHeaders.AUTHORIZATION, "Bearer " + ownerToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"status\":\"ONLINE\",\"activity\":{\"type\":\"GAME\",\"name\":\"Core Keeper\"}}"))
                .andExpect(status().isNoContent());

        mvc.perform(get("/api/groups/{groupId}", groupId)
                        .header(HttpHeaders.AUTHORIZATION, "Bearer " + ownerToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.members[0].nickname").value("Owner"))
                .andExpect(jsonPath("$.members[0].status").doesNotExist())
                .andExpect(jsonPath("$.members[0].activityName").doesNotExist());

        mvc.perform(get("/api/groups/{groupId}/presences", groupId)
                        .header(HttpHeaders.AUTHORIZATION, "Bearer " + ownerToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].status").value("ONLINE"))
                .andExpect(jsonPath("$[0].lastSeenAt").isNotEmpty())
                .andExpect(jsonPath("$[0].activityType").value("GAME"))
                .andExpect(jsonPath("$[0].activityName").value("Core Keeper"))
                .andExpect(jsonPath("$[0].activityStartedAt").isNotEmpty());

        jdbc.sql("UPDATE user_presence SET last_seen_at = now() - interval '2 minutes'").update();
        presenceService.markExpiredOffline();
        mvc.perform(get("/api/groups/{groupId}/presences", groupId)
                        .header(HttpHeaders.AUTHORIZATION, "Bearer " + ownerToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].status").value("OFFLINE"))
                .andExpect(jsonPath("$[0].lastSeenAt").isNotEmpty());

        mvc.perform(post("/api/presence/heartbeat")
                        .header(HttpHeaders.AUTHORIZATION, "Bearer " + ownerToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"status\":\"ONLINE\",\"activity\":{\"type\":\"GAME\",\"name\":\" \"}}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("INVALID_REQUEST"));
    }

    @Test
    void shouldWakeGroupPresenceWaitersOnlyAfterACommittedStatusChange() throws Exception {
        String token = localAuth.register(new LocalRegistrationRequest("PresenceWaiter", PASSWORD)).sessionToken();
        String groupBody = mvc.perform(post("/api/groups")
                        .header(HttpHeaders.AUTHORIZATION, "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON).content("{\"name\":\"状态等待\"}"))
                .andExpect(status().isCreated()).andReturn().getResponse().getContentAsString();
        String groupId = objectMapper.readTree(groupBody).get("id").asText();
        String clientId = UUID.randomUUID().toString();

        MvcResult initialWait = mvc.perform(get("/api/groups/{groupId}/presence-changes", groupId)
                        .header(HttpHeaders.AUTHORIZATION, "Bearer " + token)
                        .param("clientId", clientId).param("requestId", "1"))
                .andExpect(request().asyncStarted()).andReturn();
        String initialBody = mvc.perform(asyncDispatch(initialWait))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.changed").value(true))
                .andExpect(jsonPath("$.version").value(0))
                .andExpect(jsonPath("$.length()").value(3))
                .andReturn().getResponse().getContentAsString();
        String serverInstanceId = objectMapper.readTree(initialBody).get("serverInstanceId").asText();
        String secondClientId = UUID.randomUUID().toString();
        MvcResult secondInitialWait = mvc.perform(get("/api/groups/{groupId}/presence-changes", groupId)
                        .header(HttpHeaders.AUTHORIZATION, "Bearer " + token)
                        .param("clientId", secondClientId).param("requestId", "1"))
                .andExpect(request().asyncStarted()).andReturn();
        mvc.perform(asyncDispatch(secondInitialWait))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.version").value(0));

        MvcResult firstWaiting = mvc.perform(get("/api/groups/{groupId}/presence-changes", groupId)
                        .header(HttpHeaders.AUTHORIZATION, "Bearer " + token)
                        .param("clientId", clientId).param("requestId", "2")
                        .param("serverInstanceId", serverInstanceId).param("version", "0"))
                .andExpect(request().asyncStarted()).andReturn();
        MvcResult secondWaiting = mvc.perform(get("/api/groups/{groupId}/presence-changes", groupId)
                        .header(HttpHeaders.AUTHORIZATION, "Bearer " + token)
                        .param("clientId", secondClientId).param("requestId", "2")
                        .param("serverInstanceId", serverInstanceId).param("version", "0"))
                .andExpect(request().asyncStarted()).andReturn();
        mvc.perform(post("/api/presence/heartbeat")
                        .header(HttpHeaders.AUTHORIZATION, "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"status\":\"AWAY\",\"activity\":{\"type\":\"GAME\",\"name\":\"Core Keeper\"}}"))
                .andExpect(status().isNoContent());

        mvc.perform(asyncDispatch(firstWaiting))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.serverInstanceId").value(serverInstanceId))
                .andExpect(jsonPath("$.version").value(1))
                .andExpect(jsonPath("$.changed").value(true));
        mvc.perform(asyncDispatch(secondWaiting))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.version").value(1))
                .andExpect(jsonPath("$.changed").value(true));

        MvcResult offlineWaiting = mvc.perform(get("/api/groups/{groupId}/presence-changes", groupId)
                        .header(HttpHeaders.AUTHORIZATION, "Bearer " + token)
                        .param("clientId", clientId).param("requestId", "3")
                        .param("serverInstanceId", serverInstanceId).param("version", "1"))
                .andExpect(request().asyncStarted()).andReturn();
        mvc.perform(post("/api/presence/heartbeat")
                        .header(HttpHeaders.AUTHORIZATION, "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"status\":\"OFFLINE\",\"activity\":null}"))
                .andExpect(status().isNoContent());
        mvc.perform(asyncDispatch(offlineWaiting))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.version").value(2))
                .andExpect(jsonPath("$.changed").value(true));
        mvc.perform(get("/api/groups/{groupId}/presences", groupId)
                        .header(HttpHeaders.AUTHORIZATION, "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].status").value("OFFLINE"))
                .andExpect(jsonPath("$[0].activityName").doesNotExist());
    }

    @Test
    void shouldRejectAnOfflineWriteFromAReplacedLoginSession() {
        String oldToken = localAuth.register(new LocalRegistrationRequest("PresenceSession", PASSWORD)).sessionToken();
        AuthenticatedUser oldSession = authService.authenticate(oldToken);
        localAuth.login(new com.lycansync.api.auth.dto.LocalLoginRequest("PresenceSession", PASSWORD));

        presenceService.heartbeat(oldSession, new PresenceHeartbeatRequest(UserPresenceStatus.OFFLINE, null));

        assertThat(jdbc.sql("SELECT count(*) FROM user_presence WHERE user_id = ?")
                .param(oldSession.id()).query(Long.class).single()).isZero();
    }

    @Test
    void shouldRejectAnInFlightPresenceWaitAfterItsSessionWasReplaced() throws Exception {
        String oldToken = localAuth.register(new LocalRegistrationRequest("PresenceOldWait", PASSWORD)).sessionToken();
        String groupBody = mvc.perform(post("/api/groups")
                        .header(HttpHeaders.AUTHORIZATION, "Bearer " + oldToken)
                        .contentType(MediaType.APPLICATION_JSON).content("{\"name\":\"状态会话\"}"))
                .andExpect(status().isCreated()).andReturn().getResponse().getContentAsString();
        String groupId = objectMapper.readTree(groupBody).get("id").asText();
        String clientId = UUID.randomUUID().toString();
        MvcResult initialWait = mvc.perform(get("/api/groups/{groupId}/presence-changes", groupId)
                        .header(HttpHeaders.AUTHORIZATION, "Bearer " + oldToken)
                        .param("clientId", clientId).param("requestId", "1"))
                .andExpect(request().asyncStarted()).andReturn();
        String initialBody = mvc.perform(asyncDispatch(initialWait))
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsString();
        String serverInstanceId = objectMapper.readTree(initialBody).get("serverInstanceId").asText();

        MvcResult waiting = mvc.perform(get("/api/groups/{groupId}/presence-changes", groupId)
                        .header(HttpHeaders.AUTHORIZATION, "Bearer " + oldToken)
                        .param("clientId", clientId).param("requestId", "2")
                        .param("serverInstanceId", serverInstanceId).param("version", "0"))
                .andExpect(request().asyncStarted()).andReturn();
        String newToken = localAuth.login(new com.lycansync.api.auth.dto.LocalLoginRequest(
                "PresenceOldWait", PASSWORD)).sessionToken();
        mvc.perform(post("/api/presence/heartbeat")
                        .header(HttpHeaders.AUTHORIZATION, "Bearer " + newToken)
                        .contentType(MediaType.APPLICATION_JSON).content("{\"status\":\"ONLINE\"}"))
                .andExpect(status().isNoContent());

        mvc.perform(asyncDispatch(waiting)).andExpect(status().isUnauthorized());
    }

    @Test
    void shouldNotLetAnOlderHeartbeatResurrectAnOfflinePresence() {
        String token = localAuth.register(new LocalRegistrationRequest("PresenceRace", PASSWORD)).sessionToken();
        AuthenticatedUser user = authService.authenticate(token);
        presenceService.heartbeat(user, new PresenceHeartbeatRequest(UserPresenceStatus.ONLINE, null));
        Instant delayedHeartbeatAt = Instant.now();
        presenceService.heartbeat(user, new PresenceHeartbeatRequest(UserPresenceStatus.OFFLINE, null));

        int delayedUpdateCount = presenceMapper.upsert(user.id(), user.sessionHash(), UserPresenceStatus.ONLINE,
                null, null, delayedHeartbeatAt);

        assertThat(delayedUpdateCount).isZero();
        assertThat(jdbc.sql("SELECT status FROM user_presence WHERE user_id = ?")
                .param(user.id()).query(String.class).single()).isEqualTo("OFFLINE");
    }

    @Test
    void shouldStoreNormalizedGroupAvatar() throws Exception {
        String token = localAuth.register(new LocalRegistrationRequest("Owner", PASSWORD)).sessionToken();
        String body = objectMapper.writeValueAsString(new CreateGroupRequest("有头像的小队", "", AVATAR));
        String normalizedAvatar = AvatarImageProcessor.normalize(AVATAR);
        mvc.perform(post("/api/groups")
                        .header(HttpHeaders.AUTHORIZATION, "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.avatar").value(normalizedAvatar));
        mvc.perform(get("/api/groups").header(HttpHeaders.AUTHORIZATION, "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].avatar").value(normalizedAvatar));
        assertThat(jdbc.sql("SELECT avatar FROM chat_group").query(String.class).single()).isEqualTo(normalizedAvatar);
    }

    @Test
    void shouldIncludeAccountsRegisteredAfterGroupCreation() throws Exception {
        String ownerToken = localAuth.register(new LocalRegistrationRequest("Owner", PASSWORD)).sessionToken();
        String groupBody = mvc.perform(post("/api/groups")
                        .header(HttpHeaders.AUTHORIZATION, "Bearer " + ownerToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"开黑小队\"}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.memberCount").value(1))
                .andReturn().getResponse().getContentAsString();
        String groupId = objectMapper.readTree(groupBody).get("id").asText();

        String newToken = localAuth.register(new LocalRegistrationRequest("NewFriend", PASSWORD)).sessionToken();
        mvc.perform(get("/api/groups/{groupId}", groupId)
                        .header(HttpHeaders.AUTHORIZATION, "Bearer " + newToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.memberCount").value(2))
                .andExpect(jsonPath("$.members[1].nickname").value("NewFriend"))
                .andExpect(jsonPath("$.members[1].role").value("MEMBER"));
        mvc.perform(get("/api/groups").header(HttpHeaders.AUTHORIZATION, "Bearer " + newToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].id").value(groupId));
        mvc.perform(post("/api/groups/{groupId}/members", groupId)
                        .header(HttpHeaders.AUTHORIZATION, "Bearer " + ownerToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"NewFriend\"}"))
                .andExpect(status().isNotFound());
    }

    @Test
    void shouldRejectAnonymousAndInvalidRequests() throws Exception {
        mvc.perform(get("/api/groups")).andExpect(status().isUnauthorized());
        String token = localAuth.register(new LocalRegistrationRequest("Owner", PASSWORD)).sessionToken();
        mvc.perform(post("/api/groups")
                        .header(HttpHeaders.AUTHORIZATION, "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"   \",\"description\":\"description\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("INVALID_REQUEST"));
        assertThat(jdbc.sql("SELECT count(*) FROM chat_group").query(Long.class).single()).isZero();

        mvc.perform(post("/api/groups")
                        .header(HttpHeaders.AUTHORIZATION, "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"坏头像\",\"avatar\":\"data:image/png;base64,AAAA\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("INVALID_REQUEST"));
        assertThat(jdbc.sql("SELECT count(*) FROM chat_group").query(Long.class).single()).isZero();

        mvc.perform(get("/api/groups/abc").header(HttpHeaders.AUTHORIZATION, "Bearer " + token))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("INVALID_REQUEST"));
        mvc.perform(get("/api/groups/{groupId}", UUID.randomUUID())
                        .header(HttpHeaders.AUTHORIZATION, "Bearer " + token))
                .andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("GROUP_NOT_FOUND"));
        mvc.perform(post("/api/groups")
                        .header(HttpHeaders.AUTHORIZATION, "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"无描述群组\"}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.description").value(""));
    }

    @Test
    void shouldNotSaveGroupWithUnknownOwner() {
        AuthenticatedUser missingUser = new AuthenticatedUser(UUID.randomUUID(), "不存在", false);
        assertThatThrownBy(() -> groupService.createGroup(missingUser, new CreateGroupRequest("回滚测试", null, null)))
                .isInstanceOf(org.springframework.dao.DataIntegrityViolationException.class);
        assertThat(jdbc.sql("SELECT count(*) FROM chat_group").query(Long.class).single()).isZero();
    }
}
