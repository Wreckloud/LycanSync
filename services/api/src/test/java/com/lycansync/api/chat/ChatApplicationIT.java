package com.lycansync.api.chat;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.flywaydb.core.Flyway;
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
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.util.UUID;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import javax.sql.DataSource;

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
        jdbc.sql("TRUNCATE user_presence, chat_attachment, chat_message, chat_group, auth_session, auth_local_credential, app_user").update();
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

    @Test
    void shouldSerializeConcurrentSendsAndKeepPollingCursorComplete() throws Exception {
        String token = localAuth.register(new LocalRegistrationRequest("Owner", PASSWORD)).sessionToken();
        UUID groupId = UUID.fromString(createGroup(token));
        UUID senderId = jdbc.sql("SELECT owner_user_id FROM chat_group WHERE id = :groupId")
                .param("groupId", groupId).query(UUID.class).single();
        UUID firstMessageId = UUID.randomUUID();
        UUID secondMessageId = UUID.randomUUID();
        CountDownLatch firstInserted = new CountDownLatch(1);
        CountDownLatch allowFirstCommit = new CountDownLatch(1);
        CountDownLatch secondAttempting = new CountDownLatch(1);
        CountDownLatch secondInserted = new CountDownLatch(1);
        CountDownLatch allowSecondCommit = new CountDownLatch(1);
        AtomicInteger secondBackendPid = new AtomicInteger();
        ExecutorService executor = Executors.newFixedThreadPool(2);
        DataSource dataSource = new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
        try {
            Future<?> first = executor.submit(() -> {
                try (Connection connection = dataSource.getConnection()) {
                    connection.setAutoCommit(false);
                    insertSequencedMessage(connection, groupId, senderId, firstMessageId,
                            "2026-09-01T00:00:00Z");
                    firstInserted.countDown();
                    await(allowFirstCommit);
                    connection.commit();
                } catch (Exception exception) {
                    throw new RuntimeException(exception);
                }
            });
            assertThat(firstInserted.await(10, TimeUnit.SECONDS)).isTrue();

            Future<?> second = executor.submit(() -> {
                try (Connection connection = dataSource.getConnection()) {
                    connection.setAutoCommit(false);
                    try (PreparedStatement statement = connection.prepareStatement("SELECT pg_backend_pid()")) {
                        try (ResultSet result = statement.executeQuery()) {
                            result.next();
                            secondBackendPid.set(result.getInt(1));
                        }
                    }
                    secondAttempting.countDown();
                    insertSequencedMessage(connection, groupId, senderId, secondMessageId,
                            "2026-09-02T00:00:00Z");
                    secondInserted.countDown();
                    await(allowSecondCommit);
                    connection.commit();
                } catch (Exception exception) {
                    throw new RuntimeException(exception);
                }
            });
            assertThat(secondAttempting.await(10, TimeUnit.SECONDS)).isTrue();
            awaitDatabaseLock(secondBackendPid.get());
            assertThat(secondInserted.getCount()).isEqualTo(1);

            allowFirstCommit.countDown();
            first.get(10, TimeUnit.SECONDS);
            assertThat(secondInserted.await(10, TimeUnit.SECONDS)).isTrue();
            mvc.perform(get("/api/groups/{groupId}/messages", groupId)
                            .header(HttpHeaders.AUTHORIZATION, "Bearer " + token))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.messages.length()").value(1))
                    .andExpect(jsonPath("$.messages[0].id").value(firstMessageId.toString()));

            allowSecondCommit.countDown();
            second.get(10, TimeUnit.SECONDS);
            mvc.perform(get("/api/groups/{groupId}/messages", groupId)
                            .param("afterMessageId", firstMessageId.toString())
                            .header(HttpHeaders.AUTHORIZATION, "Bearer " + token))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.messages.length()").value(1))
                    .andExpect(jsonPath("$.messages[0].id").value(secondMessageId.toString()))
                    .andExpect(jsonPath("$.hasMore").value(false));
        } finally {
            allowFirstCommit.countDown();
            allowSecondCommit.countDown();
            executor.shutdownNow();
            assertThat(executor.awaitTermination(10, TimeUnit.SECONDS)).isTrue();
        }
    }

    @Test
    void shouldKeepSequenceAndMessageWhenAttachmentWriteFails() throws Exception {
        String token = localAuth.register(new LocalRegistrationRequest("Owner", PASSWORD)).sessionToken();
        String groupId = createGroup(token);
        jdbc.sql("CREATE FUNCTION chat_test_reject_attachment() RETURNS trigger LANGUAGE plpgsql AS $$ "
                + "BEGIN RAISE EXCEPTION 'forced attachment failure'; END $$").update();
        jdbc.sql("CREATE TRIGGER chat_test_reject_attachment BEFORE INSERT ON chat_attachment "
                + "FOR EACH ROW EXECUTE FUNCTION chat_test_reject_attachment()").update();
        try {
            mvc.perform(multipart("/api/groups/{groupId}/messages", groupId)
                            .file(new MockMultipartFile("image", "screen.png", "image/png", PNG))
                            .header(HttpHeaders.AUTHORIZATION, "Bearer " + token))
                    .andExpect(status().is5xxServerError());
            assertThat(jdbc.sql("SELECT count(*) FROM chat_message WHERE group_id = :groupId")
                    .param("groupId", UUID.fromString(groupId)).query(Long.class).single()).isZero();
            assertThat(jdbc.sql("SELECT next_message_sequence FROM chat_group WHERE id = :groupId")
                    .param("groupId", UUID.fromString(groupId)).query(Long.class).single()).isEqualTo(1L);
        } finally {
            jdbc.sql("DROP TRIGGER chat_test_reject_attachment ON chat_attachment").update();
            jdbc.sql("DROP FUNCTION chat_test_reject_attachment()").update();
        }
    }

    @Test
    void shouldBackfillOldMessagesInCreatedAtAndIdOrderAndPreservePageBoundaries() throws Exception {
        String schema = "chat_migration_" + UUID.randomUUID().toString().replace("-", "");
        Flyway.configure().dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .schemas(schema).defaultSchema(schema).target("4").load().migrate();
        String jdbcUrl = POSTGRES.getJdbcUrl();
        String schemaJdbcUrl = jdbcUrl + (jdbcUrl.contains("?") ? "&" : "?") + "currentSchema=" + schema;
        DataSource migrationDataSource = new DriverManagerDataSource(
                schemaJdbcUrl, POSTGRES.getUsername(), POSTGRES.getPassword());
        JdbcTemplate migrationJdbc = new JdbcTemplate(migrationDataSource);
        try {
            assertThat(migrationJdbc.queryForObject("SELECT current_schema()", String.class)).isEqualTo(schema);
            assertThat(migrationJdbc.queryForObject("SELECT version FROM flyway_schema_history "
                    + "WHERE success ORDER BY installed_rank DESC LIMIT 1", String.class)).isEqualTo("4");
            UUID senderId = UUID.randomUUID();
            UUID firstGroupId = UUID.randomUUID();
            UUID secondGroupId = UUID.randomUUID();
            migrationJdbc.update("INSERT INTO app_user (id, nickname, avatar, administrator, created_at) "
                    + "VALUES (?, 'Migration', '', FALSE, TIMESTAMPTZ '2026-01-01T00:00:00Z')", senderId);
            insertMigrationGroup(migrationJdbc, firstGroupId, senderId);
            insertMigrationGroup(migrationJdbc, secondGroupId, senderId);
            UUID first = UUID.fromString("00000000-0000-0000-0000-000000000001");
            UUID second = UUID.fromString("00000000-0000-0000-0000-000000000002");
            UUID third = UUID.fromString("00000000-0000-0000-0000-000000000003");
            insertOldMessage(migrationJdbc, first, firstGroupId, senderId, "2026-01-01T00:00:00Z");
            insertOldMessage(migrationJdbc, second, firstGroupId, senderId, "2026-01-01T00:00:00Z");
            insertOldMessage(migrationJdbc, third, firstGroupId, senderId, "2026-01-02T00:00:00Z");
            insertOldMessage(migrationJdbc, UUID.randomUUID(), secondGroupId, senderId, "2026-01-01T00:00:00Z");

            Flyway.configure().dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                    .schemas(schema).defaultSchema(schema).load().migrate();
            assertThat(migrationJdbc.queryForList("SELECT sequence_number FROM chat_message WHERE group_id = ? "
                    + "ORDER BY created_at, id", Long.class, firstGroupId)).containsExactly(1L, 2L, 3L);
            assertThat(migrationJdbc.queryForObject("SELECT next_message_sequence FROM chat_group WHERE id = ?",
                    Long.class, firstGroupId)).isEqualTo(4L);
            assertThat(migrationJdbc.queryForObject("SELECT next_message_sequence FROM chat_group WHERE id = ?",
                    Long.class, secondGroupId)).isEqualTo(2L);
            assertThat(org.assertj.core.api.Assertions.catchThrowable(() -> migrationJdbc.update(
                    "UPDATE chat_message SET sequence_number = NULL WHERE id = ?", first)))
                    .isInstanceOf(DataIntegrityViolationException.class);
            assertThat(org.assertj.core.api.Assertions.catchThrowable(() -> migrationJdbc.update(
                    "INSERT INTO chat_message (id, group_id, sender_user_id, type, content, created_at, sequence_number) "
                            + "SELECT ?, group_id, sender_user_id, type, content, created_at, sequence_number "
                            + "FROM chat_message WHERE id = ?", UUID.randomUUID(), first)))
                    .isInstanceOf(DataIntegrityViolationException.class);

            String token = localAuth.register(new LocalRegistrationRequest("Owner", PASSWORD)).sessionToken();
            String groupId = createGroup(token);
            UUID liveGroupId = UUID.fromString(groupId);
            UUID liveSenderId = jdbc.sql("SELECT owner_user_id FROM chat_group WHERE id = :groupId")
                    .param("groupId", liveGroupId).query(UUID.class).single();
            List<UUID> ids = insertPagedMessages(liveGroupId, liveSenderId);
            mvc.perform(get("/api/groups/{groupId}/messages", groupId)
                            .header(HttpHeaders.AUTHORIZATION, "Bearer " + token))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.messages.length()").value(30))
                    .andExpect(jsonPath("$.messages[0].id").value(ids.get(2).toString()))
                    .andExpect(jsonPath("$.messages[29].id").value(ids.get(31).toString()))
                    .andExpect(jsonPath("$.hasMore").value(true));
            mvc.perform(get("/api/groups/{groupId}/messages", groupId)
                            .param("afterMessageId", ids.get(29).toString())
                            .header(HttpHeaders.AUTHORIZATION, "Bearer " + token))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.messages.length()").value(2))
                    .andExpect(jsonPath("$.messages[0].id").value(ids.get(30).toString()))
                    .andExpect(jsonPath("$.messages[1].id").value(ids.get(31).toString()))
                    .andExpect(jsonPath("$.hasMore").value(false));
            mvc.perform(get("/api/groups/{groupId}/messages", groupId)
                            .param("beforeMessageId", ids.get(3).toString())
                            .header(HttpHeaders.AUTHORIZATION, "Bearer " + token))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.messages.length()").value(3))
                    .andExpect(jsonPath("$.messages[0].id").value(ids.get(0).toString()))
                    .andExpect(jsonPath("$.messages[2].id").value(ids.get(2).toString()))
                    .andExpect(jsonPath("$.hasMore").value(false));
        } finally {
            migrationJdbc.execute("DROP SCHEMA " + schema + " CASCADE");
        }
    }

    private void insertSequencedMessage(Connection connection, UUID groupId, UUID senderId, UUID messageId,
                                        String createdAt) throws SQLException {
        long sequenceNumber;
        try (PreparedStatement statement = connection.prepareStatement("UPDATE chat_group "
                + "SET next_message_sequence = next_message_sequence + 1 WHERE id = ? "
                + "RETURNING next_message_sequence - 1")) {
            statement.setObject(1, groupId);
            try (ResultSet result = statement.executeQuery()) {
                result.next();
                sequenceNumber = result.getLong(1);
            }
        }
        try (PreparedStatement statement = connection.prepareStatement("INSERT INTO chat_message "
                + "(id, group_id, sender_user_id, type, content, created_at, sequence_number) "
                + "VALUES (?, ?, ?, 'TEXT', 'concurrent', ?::timestamptz, ?)")) {
            statement.setObject(1, messageId);
            statement.setObject(2, groupId);
            statement.setObject(3, senderId);
            statement.setString(4, createdAt);
            statement.setLong(5, sequenceNumber);
            statement.executeUpdate();
        }
    }

    private void insertMigrationGroup(JdbcTemplate template, UUID groupId, UUID ownerId) {
        template.update("INSERT INTO chat_group (id, name, description, created_at, updated_at, owner_user_id) "
                + "VALUES (?, 'Migration', '', TIMESTAMPTZ '2026-01-01T00:00:00Z', "
                + "TIMESTAMPTZ '2026-01-01T00:00:00Z', ?)", groupId, ownerId);
    }

    private void insertOldMessage(JdbcTemplate template, UUID messageId, UUID groupId, UUID senderId,
                                  String createdAt) {
        template.update("INSERT INTO chat_message (id, group_id, sender_user_id, type, content, created_at) "
                + "VALUES (?, ?, ?, 'TEXT', 'old', ?::timestamptz)", messageId, groupId, senderId, createdAt);
    }

    private List<UUID> insertPagedMessages(UUID groupId, UUID senderId) {
        List<UUID> ids = new ArrayList<>();
        for (int sequenceNumber = 1; sequenceNumber <= 32; sequenceNumber++) {
            UUID messageId = UUID.randomUUID();
            ids.add(messageId);
            jdbc.sql("INSERT INTO chat_message (id, group_id, sender_user_id, type, content, created_at, sequence_number) "
                            + "VALUES (:id, :groupId, :senderId, 'TEXT', 'page', TIMESTAMPTZ '2026-01-01T00:00:00Z', :sequenceNumber)")
                    .param("id", messageId).param("groupId", groupId).param("senderId", senderId)
                    .param("sequenceNumber", sequenceNumber).update();
        }
        jdbc.sql("UPDATE chat_group SET next_message_sequence = 33 WHERE id = :groupId")
                .param("groupId", groupId).update();
        return ids;
    }

    private void await(CountDownLatch latch) throws InterruptedException {
        if (!latch.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("Timed out waiting for transaction gate");
    }

    private void awaitDatabaseLock(int backendPid) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (System.nanoTime() < deadline) {
            Integer blockers = jdbc.sql("SELECT cardinality(pg_blocking_pids(:backendPid))")
                    .param("backendPid", backendPid).query(Integer.class).single();
            if (blockers > 0) return;
            Thread.sleep(25);
        }
        throw new IllegalStateException("Concurrent message write did not block on the group row");
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
