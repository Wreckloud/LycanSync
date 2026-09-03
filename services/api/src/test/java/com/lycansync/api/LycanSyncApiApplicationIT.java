package com.lycansync.api;

import com.lycansync.api.system.mapper.SystemStateMapper;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.output.MigrateResult;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 后端应用与 PostgreSQL 集成测试。
 *
 * @author Wreckloud
 * @since 2026-09-02
 */
@Testcontainers
@SpringBootTest(properties = "logging.level.com.lycansync.api.common.error=OFF")
@AutoConfigureMockMvc
class LycanSyncApiApplicationIT {

    @Container
    private static final PostgreSQLContainer<?> POSTGRESQL =
            new PostgreSQLContainer<>("postgres:18.6-bookworm")
                    .withDatabaseName("lycansync")
                    .withUsername("lycansync_test")
                    .withPassword("lycansync_test");

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private JdbcClient jdbcClient;

    @Autowired
    private SystemStateMapper systemStateMapper;

    @Autowired
    private Flyway flyway;

    @DynamicPropertySource
    static void configureDatabase(DynamicPropertyRegistry registry) {
        // 同时覆盖应用与迁移连接，防止测试误用本机开发数据库。
        registry.add("spring.datasource.url", POSTGRESQL::getJdbcUrl);
        registry.add("spring.datasource.username", POSTGRESQL::getUsername);
        registry.add("spring.datasource.password", POSTGRESQL::getPassword);
        registry.add("spring.flyway.url", POSTGRESQL::getJdbcUrl);
        registry.add("spring.flyway.user", POSTGRESQL::getUsername);
        registry.add("spring.flyway.password", POSTGRESQL::getPassword);
    }

    @BeforeEach
    void resetSystemState() {
        // 仅重置临时测试库，避免用例之间共享初始化状态。
        jdbcClient.sql("""
                        INSERT INTO system_state (id, initialized_at)
                        VALUES (1, NULL)
                        ON CONFLICT (id) DO UPDATE SET initialized_at = NULL
                        """)
                .update();
    }

    @Test
    void shouldMapUninitializedState() {
        assertThat(systemStateMapper.findInitialized()).contains(false);
    }

    @Test
    void shouldMapInitializedState() {
        jdbcClient.sql("UPDATE system_state SET initialized_at = CURRENT_TIMESTAMP WHERE id = 1")
                .update();

        assertThat(systemStateMapper.findInitialized()).contains(true);
    }

    @Test
    void shouldMapMissingStateToEmptyOptional() {
        jdbcClient.sql("DELETE FROM system_state WHERE id = 1").update();

        assertThat(systemStateMapper.findInitialized()).isEmpty();
    }

    @Test
    void shouldReturnUninitializedStateFromDatabase() throws Exception {
        mockMvc.perform(get("/api/v1/system/initialization"))
                .andExpect(status().isOk())
                .andExpect(header().string("Cache-Control", "no-store"))
                .andExpect(jsonPath("$.initialized").value(false));
    }

    @Test
    void shouldReturnInitializedStateFromDatabase() throws Exception {
        jdbcClient.sql("UPDATE system_state SET initialized_at = CURRENT_TIMESTAMP WHERE id = 1")
                .update();

        mockMvc.perform(get("/api/v1/system/initialization"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.initialized").value(true));
    }

    @Test
    void shouldFailWhenSystemStateIsMissing() throws Exception {
        jdbcClient.sql("DELETE FROM system_state WHERE id = 1").update();

        mockMvc.perform(get("/api/v1/system/initialization"))
                .andExpect(status().isInternalServerError())
                .andExpect(jsonPath("$.code").value("SYSTEM_STATE_NOT_FOUND"));
    }

    @Test
    void shouldKeepExistingSystemStatusEndpoint() throws Exception {
        mockMvc.perform(get("/api/v1/system/status"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.apiVersion").value("v1"))
                .andExpect(jsonPath("$.serverTime").isNotEmpty());
    }

    @Test
    void shouldKeepOpenApiContract() throws Exception {
        mockMvc.perform(get("/v3/api-docs"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.paths['/api/v1/system/status'].get").exists())
                .andExpect(jsonPath("$.paths['/api/v1/system/initialization'].get.responses['200']").exists())
                .andExpect(jsonPath("$.components.schemas.SystemInitializationStatusResponse.properties.initialized.type")
                        .value("boolean"));
    }

    @Test
    void shouldNotRepeatAppliedMigration() {
        MigrateResult result = flyway.migrate();

        assertThat(result.migrationsExecuted).isZero();
    }
}
