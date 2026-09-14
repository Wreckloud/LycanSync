package com.lycansync.api.chat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.lycansync.api.auth.dto.LocalRegistrationRequest;
import com.lycansync.api.auth.service.LocalAuthService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 使用隔离 PostgreSQL 验证群聊文本和图片附件的完整链路。
 *
 * @author Wreckloud
 * @since 2026-09-14
 */
@Testcontainers
@SpringBootTest
@AutoConfigureMockMvc
class ChatApplicationIT {

    private static final String PASSWORD = "chat-test-password";
    private static final byte[] PNG = java.util.Base64.getDecoder().decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=");

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
    private JdbcClient jdbc;

    @Autowired
    private MockMvc mvc;

    @Autowired
    private ObjectMapper objectMapper;

    @BeforeEach
    void resetDatabase() {
        jdbc.sql("TRUNCATE chat_attachment, chat_message, chat_group, auth_session, auth_local_credential, app_user").update();
        jdbc.sql("UPDATE system_state SET initialized_at = NULL WHERE id = 1").update();
    }

    @Test
    void shouldSendAndReadTextAndImageWithoutInliningBinaryData() throws Exception {
        String ownerToken = localAuth.register(new LocalRegistrationRequest("Owner", PASSWORD)).sessionToken();
        String friendToken = localAuth.register(new LocalRegistrationRequest("Friend", PASSWORD)).sessionToken();
        String groupId = createGroup(ownerToken);

        String textResponse = mvc.perform(multipart("/api/groups/{groupId}/messages", groupId)
                        .header(HttpHeaders.AUTHORIZATION, "Bearer " + ownerToken)
                        .param("content", "今晚八点见"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.type").value("TEXT"))
                .andExpect(jsonPath("$.content").value("今晚八点见"))
                .andExpect(jsonPath("$.attachment").doesNotExist())
                .andReturn().getResponse().getContentAsString();
        String textId = objectMapper.readTree(textResponse).get("id").asText();

        String imageResponse = mvc.perform(multipart("/api/groups/{groupId}/messages", groupId)
                        .file(new MockMultipartFile("image", "screen.png", "image/png", PNG))
                        .header(HttpHeaders.AUTHORIZATION, "Bearer " + friendToken)
                        .param("content", "截图"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.type").value("IMAGE"))
                .andExpect(jsonPath("$.attachment.contentType").value("image/png"))
                .andExpect(jsonPath("$.attachment.byteSize").value(PNG.length))
                .andReturn().getResponse().getContentAsString();
        String attachmentId = objectMapper.readTree(imageResponse).path("attachment").path("id").asText();

        mvc.perform(get("/api/groups/{groupId}/messages", groupId)
                        .header(HttpHeaders.AUTHORIZATION, "Bearer " + friendToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.messages.length()").value(2))
                .andExpect(jsonPath("$.messages[0].id").value(textId))
                .andExpect(jsonPath("$.messages[1].attachment.id").value(attachmentId));
        byte[] attachment = mvc.perform(get("/api/groups/{groupId}/attachments/{attachmentId}", groupId, attachmentId)
                        .header(HttpHeaders.AUTHORIZATION, "Bearer " + ownerToken))
                .andExpect(status().isOk())
                .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.content()
                        .contentType(MediaType.IMAGE_PNG))
                .andReturn().getResponse().getContentAsByteArray();
        assertThat(attachment).isEqualTo(PNG);
    }

    @Test
    void shouldRejectAnEmptyMessageWithoutCreatingData() throws Exception {
        String token = localAuth.register(new LocalRegistrationRequest("Owner", PASSWORD)).sessionToken();
        String groupId = createGroup(token);
        mvc.perform(multipart("/api/groups/{groupId}/messages", groupId)
                        .header(HttpHeaders.AUTHORIZATION, "Bearer " + token)
                        .param("content", "   "))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("INVALID_REQUEST"));
        assertThat(jdbc.sql("SELECT count(*) FROM chat_message").query(Long.class).single()).isZero();
    }

    private String createGroup(String token) throws Exception {
        String response = mvc.perform(post("/api/groups")
                        .header(HttpHeaders.AUTHORIZATION, "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"测试群组\"}"))
                .andExpect(status().isCreated()).andReturn().getResponse().getContentAsString();
        return objectMapper.readTree(response).get("id").asText();
    }
}
