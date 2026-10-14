package com.lycansync.api.rtc;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.google.protobuf.InvalidProtocolBufferException;
import com.lycansync.api.auth.mapper.AuthMapper;
import com.lycansync.api.auth.model.AuthUser;
import com.lycansync.api.auth.service.AuthSecrets;
import com.lycansync.api.rtc.dto.RtcTokenResponse;
import io.livekit.server.RoomServiceClient;
import livekit.LivekitModels;
import livekit.LivekitRtc;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.images.builder.Transferable;
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
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
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
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
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
                            keys:
                              %s: %s
                            """.formatted(API_KEY, API_SECRET))
                    .waitingFor(Wait.forHttp("/").forStatusCode(200));

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private AuthMapper authMapper;

    private String sessionToken;

    @LocalServerPort
    private int apiPort;

    private static GenericContainer<?> gateway;

    @org.junit.jupiter.api.AfterAll
    static void stopGateway() {
        if (gateway != null) gateway.stop();
    }

    private String gatewayAddress() throws Exception {
        if (gateway == null) {
            org.testcontainers.Testcontainers.exposeHostPorts(apiPort, LIVEKIT.getMappedPort(7880));
            // 复用部署配置的路由与预检，仅在隔离测试内换成明文随机端口，不修改客户端 TLS。
            String config = Files.readString(Path.of("../../deploy/server/Caddyfile.lan"))
                    .replace("https://{$SERVER_DOMAIN}:8443", "http://:8443")
                    .replace("https://{$SERVER_DOMAIN}", "http://:80")
                    .replace("    tls internal", "")
                    .replace("api:18080", "host.testcontainers.internal:" + apiPort)
                    .replace("livekit:7990", "host.testcontainers.internal:" + LIVEKIT.getMappedPort(7880));
            gateway = new GenericContainer<>("caddy:2.10.2-alpine").withExposedPorts(80, 8443)
                    .withEnv("SERVER_DOMAIN", "localhost")
                    .withCopyToContainer(Transferable.of(config), "/etc/caddy/Caddyfile")
                    .waitingFor(Wait.forListeningPorts(80, 8443));
            gateway.start();
        }
        return gateway.getHost() + ":" + gateway.getMappedPort(8443);
    }

    @BeforeEach
    void createAuthenticatedUser() {
        AuthUser user = new AuthUser(UUID.randomUUID(), "小狼", "", false, "", Instant.now());
        authMapper.insertUser(user, Instant.now());
        sessionToken = AuthSecrets.generate();
        authMapper.replaceSession(AuthSecrets.hash(sessionToken), user.id(), Instant.now().plusSeconds(600));
    }

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
        registry.add("lycansync.rtc.api-url", () -> "http://" + liveKitAddress());
        registry.add("lycansync.rtc.api-key", () -> API_KEY);
        registry.add("lycansync.rtc.api-secret", () -> API_SECRET);
    }

    @Test
    void shouldJoinLiveKitUsingTokenIssuedByHttpEndpoint() throws Exception {
        String groupBody = mockMvc.perform(post("/api/groups").header("Authorization", "Bearer " + sessionToken)
                        .contentType("application/json").content("{\"name\":\"媒体测试群组\"}"))
                .andExpect(status().isCreated()).andReturn().getResponse().getContentAsString();
        String groupId = objectMapper.readTree(groupBody).get("id").asText();
        String responseBody = mockMvc.perform(post("/api/rtc/token").header("Authorization", "Bearer " + sessionToken)
                        .contentType("application/json")
                        .content("{\"groupId\":\"" + groupId + "\"}"))
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
            assertThat(join.getRoom().getMaxParticipants()).isZero();

            mockMvc.perform(get("/api/rtc/room-summary").header("Authorization", "Bearer " + sessionToken).queryParam("groupId", groupId))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.participantCount").value(1))
                    .andExpect(jsonPath("$.participants[0].displayName").value("小狼"))
                    .andExpect(jsonPath("$.participants[0].participantIdentity").value(credential.participantIdentity()))
                    .andExpect(jsonPath("$.tracks").doesNotExist());

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
    void shouldOnlyAllowExplicitGroupMembersAndRejectMissingGroup() throws Exception {
        String groupBody = mockMvc.perform(post("/api/groups").header("Authorization", "Bearer " + sessionToken)
                        .contentType("application/json").content("{\"name\":\"开黑小队\"}"))
                .andExpect(status().isCreated()).andReturn().getResponse().getContentAsString();
        String groupId = objectMapper.readTree(groupBody).get("id").asText();
        AuthUser friend = new AuthUser(UUID.randomUUID(), "新朋友", "", false, "", Instant.now());
        authMapper.insertUser(friend, Instant.now());
        String friendToken = AuthSecrets.generate();
        authMapper.replaceSession(AuthSecrets.hash(friendToken), friend.id(), Instant.now().plusSeconds(600));

        mockMvc.perform(post("/api/rtc/token").header("Authorization", "Bearer " + friendToken)
                        .contentType("application/json").content("{\"groupId\":\"" + groupId + "\"}"))
                .andExpect(status().isNotFound());
        mockMvc.perform(get("/api/rtc/room-summary").header("Authorization", "Bearer " + friendToken)
                        .queryParam("groupId", groupId)).andExpect(status().isNotFound());
        mockMvc.perform(post("/api/groups/{id}/members", groupId).header("Authorization", "Bearer " + sessionToken)
                        .contentType("application/json").content("{\"userId\":\"" + friend.id() + "\"}"))
                .andExpect(status().isOk());

        mockMvc.perform(post("/api/rtc/token").header("Authorization", "Bearer " + friendToken)
                        .contentType("application/json").content("{\"groupId\":\"" + groupId + "\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.roomName").value(org.hamcrest.Matchers.startsWith("lycan-sync-group-")))
                .andExpect(jsonPath("$.participantIdentity").value("user-" + friend.id()));
        mockMvc.perform(get("/api/rtc/room-summary").header("Authorization", "Bearer " + friendToken)
                        .queryParam("groupId", groupId))
                .andExpect(status().isOk()).andExpect(jsonPath("$.participantCount").value(0));

        String missingGroupId = UUID.randomUUID().toString();
        mockMvc.perform(post("/api/rtc/token").header("Authorization", "Bearer " + friendToken)
                        .contentType("application/json").content("{\"groupId\":\"" + missingGroupId + "\"}"))
                .andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("GROUP_NOT_FOUND"));
        mockMvc.perform(get("/api/rtc/room-summary").header("Authorization", "Bearer " + friendToken)
                        .queryParam("groupId", missingGroupId))
                .andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("GROUP_NOT_FOUND"));
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
                .andExpect(jsonPath("$.paths['/api/rtc/room-summary'].get.responses['200']").exists())
                .andExpect(jsonPath("$.components.schemas.LocalRtcTokenRequest.required").isArray())
                .andExpect(jsonPath("$.components.schemas.RtcTokenResponse.properties.token").exists())
                .andExpect(jsonPath("$.components.schemas.RtcTokenResponse.properties.apiSecret").doesNotExist());
    }

    private static String liveKitAddress() {
        return LIVEKIT.getHost() + ":" + LIVEKIT.getMappedPort(7880);
    }

    @Test
    void shouldDisconnectOnlyRemovedMemberAndBlockCachedTokenAtGateway() throws Exception {
        String groupBody = mockMvc.perform(post("/api/groups").header("Authorization", "Bearer " + sessionToken)
                        .contentType("application/json").content("{\"name\":\"撤销权限测试\"}"))
                .andExpect(status().isCreated()).andReturn().getResponse().getContentAsString();
        String groupId = objectMapper.readTree(groupBody).path("id").asText();
        AuthUser member = new AuthUser(UUID.randomUUID(), "待移出成员", "", false, "", Instant.now());
        authMapper.insertUser(member, Instant.now());
        String memberToken = AuthSecrets.generate();
        authMapper.replaceSession(AuthSecrets.hash(memberToken), member.id(), Instant.now().plusSeconds(600));
        mockMvc.perform(post("/api/groups/{id}/members", groupId).header("Authorization", "Bearer " + sessionToken)
                        .contentType("application/json").content("{\"userId\":\"" + member.id() + "\"}"))
                .andExpect(status().isOk());
        RtcTokenResponse ownerCredential = roomCredential(groupId);
        String memberBody = mockMvc.perform(post("/api/rtc/token").header("Authorization", "Bearer " + memberToken)
                        .contentType("application/json").content("{\"groupId\":\"" + groupId + "\"}"))
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsString();
        RtcTokenResponse memberCredential = objectMapper.readValue(memberBody, RtcTokenResponse.class);
        String signalUrl = "ws://" + gatewayAddress() + "/rtc?protocol=15&auto_subscribe=0";
        JoinResponseListener ownerListener = new JoinResponseListener();
        JoinResponseListener memberListener = new JoinResponseListener();
        WebSocket ownerConnection = HttpClient.newHttpClient().newWebSocketBuilder()
                .connectTimeout(Duration.ofSeconds(10)).header("Authorization", "Bearer " + ownerCredential.token())
                .buildAsync(URI.create(signalUrl), ownerListener).get(10, TimeUnit.SECONDS);
        WebSocket memberConnection = HttpClient.newHttpClient().newWebSocketBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .buildAsync(URI.create(signalUrl + "&access_token=" + memberCredential.token()), memberListener)
                .get(10, TimeUnit.SECONDS);
        try {
            assertThat(ownerListener.joinResponse.get(10, TimeUnit.SECONDS).getRoom().getName()).isEqualTo(ownerCredential.roomName());
            assertThat(memberListener.joinResponse.get(10, TimeUnit.SECONDS).getRoom().getName()).isEqualTo(ownerCredential.roomName());
            mockMvc.perform(delete("/api/groups/{id}/members/{userId}", groupId, member.id())
                            .header("Authorization", "Bearer " + sessionToken)).andExpect(status().isNoContent());
            memberListener.leftRoom.get(10, TimeUnit.SECONDS);
            assertThat(ownerListener.leftRoom.isDone()).isFalse();
            assertThat(roomCredential(groupId).roomName()).isEqualTo(ownerCredential.roomName());
            RoomServiceClient rooms = RoomServiceClient.createClient("http://" + liveKitAddress(), API_KEY, API_SECRET);
            assertThat(rooms.listParticipants(ownerCredential.roomName()).execute().body())
                    .extracting(LivekitModels.ParticipantInfo::getIdentity).containsExactly(ownerCredential.participantIdentity());
            mockMvc.perform(post("/api/rtc/token").header("Authorization", "Bearer " + memberToken)
                            .contentType("application/json").content("{\"groupId\":\"" + groupId + "\"}"))
                    .andExpect(status().isNotFound());
            for (String path : List.of("/rtc/validate", "/rtc/v1/validate")) {
                HttpResponse<String> denied = HttpClient.newHttpClient().send(HttpRequest.newBuilder()
                                .uri(URI.create("http://" + gatewayAddress() + path + "?access_token=" + memberCredential.token()))
                                .header("X-Lycan-Rtc-Token", ownerCredential.token())
                                .GET().build(), HttpResponse.BodyHandlers.ofString());
                assertThat(denied.statusCode()).isEqualTo(403);
            }
            assertThatThrownBy(() -> HttpClient.newHttpClient().newWebSocketBuilder()
                    .buildAsync(URI.create(signalUrl + "&access_token=" + memberCredential.token() + "&reconnect=1"),
                            new JoinResponseListener()).get(10, TimeUnit.SECONDS))
                    .hasCauseInstanceOf(java.net.http.WebSocketHandshakeException.class);
            assertThat(ownerListener.leftRoom.isDone()).isFalse();
            // 模拟撤权前已通过预检、但撤权后才入房的迟到连接；签名事件必须只断开它。
            JoinResponseListener lateListener = new JoinResponseListener();
            WebSocket lateConnection = HttpClient.newHttpClient().newWebSocketBuilder()
                    .header("Authorization", "Bearer " + memberCredential.token())
                    .buildAsync(URI.create(memberCredential.serverUrl() + "/rtc?protocol=15&auto_subscribe=0"), lateListener)
                    .get(10, TimeUnit.SECONDS);
            try {
                lateListener.joinResponse.get(10, TimeUnit.SECONDS);
                String event = "{\"event\":\"participant_joined\",\"room\":{\"name\":\"" + memberCredential.roomName()
                        + "\"},\"participant\":{\"identity\":\"" + memberCredential.participantIdentity() + "\"}}";
                String digest = java.util.Base64.getEncoder().encodeToString(java.security.MessageDigest.getInstance("SHA-256")
                        .digest(event.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
                String signature = com.auth0.jwt.JWT.create().withIssuer(API_KEY).withExpiresAt(Instant.now().plusSeconds(60))
                        .withClaim("sha256", digest).sign(com.auth0.jwt.algorithms.Algorithm.HMAC256(API_SECRET));
                mockMvc.perform(post("/internal/rtc/events").header("Authorization", signature)
                                .contentType("application/webhook+json").content(event)).andExpect(status().isNoContent());
                lateListener.leftRoom.get(10, TimeUnit.SECONDS);
                assertThat(ownerListener.leftRoom.isDone()).isFalse();
            } finally { lateConnection.abort(); }
        } finally {
            ownerConnection.abort();
            memberConnection.abort();
        }
    }

    @Test
    void shouldRejectForgedTokensAndDirectInternalPathsAtGateway() throws Exception {
        for (String path : List.of("/rtc", "/rtc/validate", "/rtc/v1", "/rtc/v1/validate")) {
            HttpResponse<String> response = HttpClient.newHttpClient().send(HttpRequest.newBuilder()
                            .uri(URI.create("http://" + gatewayAddress() + path + "?access_token=forged"))
                            .header("X-Lycan-Rtc-Token", "forged").GET().build(), HttpResponse.BodyHandlers.ofString());
            assertThat(response.statusCode()).isEqualTo(401);
        }
        HttpResponse<String> signalInternal = HttpClient.newHttpClient().send(HttpRequest.newBuilder()
                        .uri(URI.create("http://" + gatewayAddress() + "/internal/rtc/access")).GET().build(),
                HttpResponse.BodyHandlers.ofString());
        assertThat(signalInternal.statusCode()).isEqualTo(404);
        HttpResponse<String> apiInternal = HttpClient.newHttpClient().send(HttpRequest.newBuilder()
                        .uri(URI.create("http://" + gateway.getHost() + ":" + gateway.getMappedPort(80) + "/internal/rtc/access"))
                        .GET().build(), HttpResponse.BodyHandlers.ofString());
        assertThat(apiInternal.statusCode()).isEqualTo(404);
        HttpResponse<String> preflight = HttpClient.newHttpClient().send(HttpRequest.newBuilder()
                        .uri(URI.create("http://" + gatewayAddress() + "/rtc/validate"))
                        .method("OPTIONS", HttpRequest.BodyPublishers.noBody())
                        .header("Origin", "http://localhost:5173")
                        .header("Access-Control-Request-Headers", "Authorization").build(), HttpResponse.BodyHandlers.ofString());
        assertThat(preflight.statusCode()).isEqualTo(204);
        assertThat(preflight.headers().firstValue("Access-Control-Allow-Headers")).contains("Authorization");
        mockMvc.perform(post("/internal/rtc/events").header("Authorization", "forged")
                        .contentType("application/webhook+json").content("{\"event\":\"participant_joined\"}"))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void shouldDisconnectOnlyDepartingMemberWhenTheyLeaveVoluntarily() throws Exception {
        String groupBody = mockMvc.perform(post("/api/groups").header("Authorization", "Bearer " + sessionToken)
                        .contentType("application/json").content("{\"name\":\"主动退出测试\"}"))
                .andExpect(status().isCreated()).andReturn().getResponse().getContentAsString();
        String groupId = objectMapper.readTree(groupBody).path("id").asText();
        AuthUser member = new AuthUser(UUID.randomUUID(), "退出成员", "", false, "", Instant.now());
        authMapper.insertUser(member, Instant.now());
        String memberToken = AuthSecrets.generate();
        authMapper.replaceSession(AuthSecrets.hash(memberToken), member.id(), Instant.now().plusSeconds(600));
        mockMvc.perform(post("/api/groups/{id}/members", groupId).header("Authorization", "Bearer " + sessionToken)
                        .contentType("application/json").content("{\"userId\":\"" + member.id() + "\"}"))
                .andExpect(status().isOk());
        RtcTokenResponse before = roomCredential(groupId);
        JoinResponseListener listener = new JoinResponseListener();
        WebSocket connection = HttpClient.newHttpClient().newWebSocketBuilder()
                .connectTimeout(Duration.ofSeconds(10)).header("Authorization", "Bearer " + before.token())
                .buildAsync(URI.create(before.serverUrl() + "/rtc?protocol=15&auto_subscribe=0"), listener)
                .get(10, TimeUnit.SECONDS);
        try {
            assertThat(listener.joinResponse.get(10, TimeUnit.SECONDS).getRoom().getName()).isEqualTo(before.roomName());
            mockMvc.perform(delete("/api/groups/{id}/members/{userId}", groupId, member.id())
                            .header("Authorization", "Bearer " + memberToken)).andExpect(status().isNoContent());
            assertThat(listener.leftRoom.isDone()).isFalse();
            RtcTokenResponse after = roomCredential(groupId);
            assertThat(after.roomName()).isEqualTo(before.roomName());
            mockMvc.perform(post("/api/rtc/token").header("Authorization", "Bearer " + memberToken)
                            .contentType("application/json").content("{\"groupId\":\"" + groupId + "\"}"))
                    .andExpect(status().isNotFound());
        } finally { connection.abort(); }
    }

    private RtcTokenResponse roomCredential(String groupId) throws Exception {
        String body = mockMvc.perform(post("/api/rtc/token").header("Authorization", "Bearer " + sessionToken)
                        .contentType("application/json").content("{\"groupId\":\"" + groupId + "\"}"))
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsString();
        return objectMapper.readValue(body, RtcTokenResponse.class);
    }

    private static class JoinResponseListener implements WebSocket.Listener {

        private final CompletableFuture<LivekitRtc.JoinResponse> joinResponse = new CompletableFuture<>();
        private final CompletableFuture<Void> leftRoom = new CompletableFuture<>();
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
                    if (response.hasLeave()) leftRoom.complete(null);
                } catch (InvalidProtocolBufferException exception) {
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
            leftRoom.completeExceptionally(error);
        }

        @Override
        public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
            leftRoom.complete(null);
            return null;
        }
    }
}
