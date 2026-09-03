package com.lycansync.api.rtc;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.lycansync.api.rtc.dto.RtcTokenResponse;
import io.livekit.server.RoomServiceClient;
import livekit.LivekitModels;
import livekit.LivekitRtc;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import retrofit2.Response;

import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.WebSocket;
import java.nio.ByteBuffer;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 本地 RTC 接口与真实 LiveKit 信令集成测试。
 *
 * @author Wreckloud
 * @since 2026-09-03
 */
@Testcontainers
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("rtc-local")
class LocalRtcApplicationIT {

    private static final String API_KEY = "local-test-key";
    private static final String API_SECRET = "local-test-secret-at-least-32-characters";

    @Container
    private static final PostgreSQLContainer<?> POSTGRESQL =
            new PostgreSQLContainer<>("postgres:18.6-bookworm")
                    .withDatabaseName("lycansync")
                    .withUsername("lycansync_test")
                    .withPassword("lycansync_test");

    @Container
    private static final GenericContainer<?> LIVEKIT =
            new GenericContainer<>("livekit/livekit-server:v1.13.6")
                    .withExposedPorts(7880)
                    .withEnv("LIVEKIT_CONFIG", """
                            port: 7880
                            bind_addresses: ["0.0.0.0"]
                            rtc:
                              tcp_port: 7881
                              udp_port: 7882
                              use_external_ip: false
                              node_ip: 127.0.0.1
                            room:
                              max_participants: 8
                            keys:
                              %s: %s
                            """.formatted(API_KEY, API_SECRET))
                    .waitingFor(Wait.forHttp("/").forStatusCode(200));

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @DynamicPropertySource
    static void configureDependencies(DynamicPropertyRegistry registry) {
        // 使用独立数据库和随机映射端口，测试不会修改开发库或占用本地 LiveKit。
        registry.add("spring.datasource.url", POSTGRESQL::getJdbcUrl);
        registry.add("spring.datasource.username", POSTGRESQL::getUsername);
        registry.add("spring.datasource.password", POSTGRESQL::getPassword);
        registry.add("spring.flyway.url", POSTGRESQL::getJdbcUrl);
        registry.add("spring.flyway.user", POSTGRESQL::getUsername);
        registry.add("spring.flyway.password", POSTGRESQL::getPassword);
        registry.add("lycansync.rtc.server-url", () -> "ws://" + liveKitAddress());
        registry.add("lycansync.rtc.api-key", () -> API_KEY);
        registry.add("lycansync.rtc.api-secret", () -> API_SECRET);
    }

    @Test
    void shouldJoinLiveKitUsingTokenIssuedByHttpEndpoint() throws Exception {
        String responseBody = mockMvc.perform(post("/api/rtc/token")
                        .contentType("application/json")
                        .content("{\"displayName\":\"小狼\"}"))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString();
        RtcTokenResponse credential = objectMapper.readValue(responseBody, RtcTokenResponse.class);
        JoinResponseListener listener = new JoinResponseListener();
        WebSocket connection = HttpClient.newHttpClient().newWebSocketBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .header("Authorization", "Bearer " + credential.token())
                .buildAsync(URI.create(credential.serverUrl() + "/rtc?protocol=15&auto_subscribe=0"), listener)
                .get(10, TimeUnit.SECONDS);

        try {
            // JoinResponse 证明签名和房间授权被接受；没有发送 SDP，因此不证明媒体已经连通。
            LivekitRtc.JoinResponse join = listener.joinResponse.get(10, TimeUnit.SECONDS);
            assertThat(join.getRoom().getName()).isEqualTo(credential.roomName());
            assertThat(join.getParticipant().getIdentity()).isEqualTo(credential.participantIdentity());
            assertThat(join.getParticipant().getName()).isEqualTo("小狼");
            assertThat(join.getRoom().getMaxParticipants()).isEqualTo(8);

            RoomServiceClient roomClient = RoomServiceClient.createClient(
                    "http://" + liveKitAddress(), API_KEY, API_SECRET);
            Response<List<LivekitModels.Room>> rooms =
                    roomClient.listRooms(List.of(credential.roomName())).execute();
            assertThat(rooms.isSuccessful()).isTrue();
            assertThat(rooms.body()).isNotNull();
            assertThat(rooms.body()).extracting(LivekitModels.Room::getName)
                    .contains(credential.roomName());
        } finally {
            connection.abort();
        }
    }

    @Test
    void shouldRejectInvalidTokenAtLiveKit() throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create("http://" + liveKitAddress() + "/rtc/validate"))
                .timeout(Duration.ofSeconds(10))
                .header("Authorization", "Bearer invalid-token")
                .GET().build();

        HttpResponse<Void> response = HttpClient.newHttpClient()
                .send(request, HttpResponse.BodyHandlers.discarding());

        assertThat(response.statusCode()).isEqualTo(401);
    }

    @Test
    void shouldIncludeLocalRtcEndpointInOpenApiOnlyWhenEnabled() throws Exception {
        mockMvc.perform(get("/v3/api-docs"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.paths['/api/rtc/token'].post.responses['200']").exists())
                .andExpect(jsonPath("$.paths['/api/rtc/token'].post.responses['400']").exists())
                .andExpect(jsonPath("$.components.schemas.LocalRtcTokenRequest.required[0]").value("displayName"))
                .andExpect(jsonPath("$.components.schemas.RtcTokenResponse.properties.token").exists())
                .andExpect(jsonPath("$.components.schemas.RtcTokenResponse.properties.apiSecret").doesNotExist());
    }

    private static String liveKitAddress() {
        return LIVEKIT.getHost() + ":" + LIVEKIT.getMappedPort(7880);
    }

    /**
     * 收集信令分片，等待 LiveKit 返回入房结果。
     *
     * @author Wreckloud
     * @since 2026-09-03
     */
    private static class JoinResponseListener implements WebSocket.Listener {

        private final CompletableFuture<LivekitRtc.JoinResponse> joinResponse = new CompletableFuture<>();
        private final ByteArrayOutputStream fragments = new ByteArrayOutputStream();

        @Override
        public CompletionStage<?> onBinary(WebSocket webSocket, ByteBuffer payload, boolean last) {
            byte[] bytes = new byte[payload.remaining()];
            payload.get(bytes);
            fragments.writeBytes(bytes);
            if (last) {
                try {
                    LivekitRtc.SignalResponse response = LivekitRtc.SignalResponse.parseFrom(fragments.toByteArray());
                    if (response.hasJoin()) {
                        joinResponse.complete(response.getJoin());
                    }
                } catch (com.google.protobuf.InvalidProtocolBufferException exception) {
                    joinResponse.completeExceptionally(exception);
                }
                fragments.reset();
            }
            webSocket.request(1);
            return null;
        }

        @Override
        public void onError(WebSocket webSocket, Throwable error) {
            joinResponse.completeExceptionally(error);
        }
    }
}
