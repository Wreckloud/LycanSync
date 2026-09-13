package com.lycansync.api.group;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.lycansync.api.auth.dto.LocalRegistrationRequest;
import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.auth.service.LocalAuthService;
import com.lycansync.api.group.dto.CreateGroupRequest;
import com.lycansync.api.group.service.GroupService;
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
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
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
    private JdbcClient jdbc;

    @Autowired
    private MockMvc mvc;

    @Autowired
    private ObjectMapper objectMapper;

    @BeforeEach
    void resetDatabase() {
        jdbc.sql("TRUNCATE chat_group, auth_session, auth_local_credential, app_user").update();
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
    void shouldStoreValidatedGroupAvatar() throws Exception {
        String token = localAuth.register(new LocalRegistrationRequest("Owner", PASSWORD)).sessionToken();
        String body = objectMapper.writeValueAsString(new CreateGroupRequest("有头像的小队", "", AVATAR));
        mvc.perform(post("/api/groups")
                        .header(HttpHeaders.AUTHORIZATION, "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.avatar").value(AVATAR));
        mvc.perform(get("/api/groups").header(HttpHeaders.AUTHORIZATION, "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].avatar").value(AVATAR));
        assertThat(jdbc.sql("SELECT avatar FROM chat_group").query(String.class).single()).isEqualTo(AVATAR);
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
