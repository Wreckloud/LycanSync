package com.lycansync.api.rtc.config;

import com.lycansync.api.group.mapper.GroupMapper;
import com.lycansync.api.rtc.exception.RtcServiceUnavailableException;
import com.lycansync.api.rtc.service.GroupRtcAccessService;
import com.sun.net.httpserver.HttpServer;
import io.livekit.server.RoomServiceClient;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.support.StaticListableBeanFactory;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

import java.io.IOException;
import java.io.InterruptedIOException;
import java.net.InetSocketAddress;
import java.time.Duration;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;

/**
 * 用持续慢回包验证两种 RTC 配置均能结束真实请求，而非仅检查超时参数。
 *
 * @author Wreckloud
 * @since 2026-11-18
 */
class RtcCallTimeoutTests {

    @ParameterizedTest
    @ValueSource(strings = {"rtc-local", "rtc-server"})
    void shouldShareRevocationDeadlineAcrossRooms(String profile) throws Exception {
        var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        var httpWorkers = Executors.newSingleThreadExecutor();
        var callWorker = Executors.newSingleThreadExecutor();
        var requests = new AtomicInteger();
        var completed = new AtomicInteger();
        server.setExecutor(httpWorkers);
        server.createContext("/", exchange -> {
            try {
                exchange.getRequestBody().readAllBytes();
                requests.incrementAndGet();
                Thread.sleep(6_000);
                exchange.sendResponseHeaders(404, -1);
                completed.incrementAndGet();
            } catch (IOException expectedDisconnect) {
                // 整批到期会关闭正在等待的请求。
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            } finally {
                exchange.close();
            }
        });
        server.start();
        try {
            new ApplicationContextRunner()
                    .withUserConfiguration(LocalRtcConfiguration.class, RtcServerConfiguration.class)
                    .withPropertyValues(
                            "spring.profiles.active=" + profile,
                            "server.address=127.0.0.1",
                            "lycansync.rtc.server-url=" + (profile.equals("rtc-server") ? "wss" : "ws") + "://synthetic.invalid",
                            "lycansync.rtc.api-url=http://127.0.0.1:" + server.getAddress().getPort(),
                            "lycansync.rtc.api-key=timeout-test-key",
                            "lycansync.rtc.api-secret=timeout-test-secret-at-least-32-characters")
                    .run(context -> {
                        assertThat(context).hasNotFailed();
                        var beans = new StaticListableBeanFactory();
                        beans.addBean("rooms", context.getBean(RoomServiceClient.class));
                        var access = new GroupRtcAccessService(beans.getBeanProvider(RoomServiceClient.class), mock(GroupMapper.class));
                        long started = System.nanoTime();
                        var result = callWorker.submit(() -> access.removeParticipantFromRooms(
                                List.of(UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID()), UUID.randomUUID(), Duration.ofSeconds(10)));
                        try {
                            assertThatThrownBy(() -> result.get(13, TimeUnit.SECONDS))
                                    .isInstanceOf(ExecutionException.class)
                                    .hasCauseInstanceOf(RtcServiceUnavailableException.class);
                            assertThat(Duration.ofNanos(System.nanoTime() - started).toMillis()).isBetween(9_000L, 13_000L);
                            assertThat(requests.get()).isEqualTo(2);
                            assertThat(completed.get()).isEqualTo(1);
                        } finally {
                            result.cancel(true);
                        }
                    });
        } finally {
            server.stop(0);
            callWorker.shutdownNow();
            httpWorkers.shutdownNow();
            assertThat(callWorker.awaitTermination(5, TimeUnit.SECONDS)).isTrue();
            assertThat(httpWorkers.awaitTermination(5, TimeUnit.SECONDS)).isTrue();
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"rtc-local", "rtc-server"})
    void shouldFailRevocationWithinDeadlineWhenErrorBodyKeepsArriving(String profile) throws Exception {
        var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        var httpWorkers = Executors.newSingleThreadExecutor();
        var callWorker = Executors.newSingleThreadExecutor();
        var stop = new CountDownLatch(1);
        var entered = new CountDownLatch(1);
        var chunks = new AtomicInteger();
        server.setExecutor(httpWorkers);
        server.createContext("/", exchange -> {
            try {
                exchange.getRequestBody().readAllBytes();
                exchange.sendResponseHeaders(500, 0);
                entered.countDown();
                // 每半秒有新数据，不能依靠默认的十秒单次读取超时结束请求。
                do {
                    exchange.getResponseBody().write(' ');
                    exchange.getResponseBody().flush();
                    chunks.incrementAndGet();
                } while (!stop.await(500, TimeUnit.MILLISECONDS));
            } catch (IOException expectedDisconnect) {
                // 客户端到达总时限会关闭连接，服务端仍须回收交换。
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            } finally {
                exchange.close();
            }
        });
        server.start();
        try {
            new ApplicationContextRunner()
                    .withUserConfiguration(LocalRtcConfiguration.class, RtcServerConfiguration.class)
                    .withPropertyValues(
                            "spring.profiles.active=" + profile,
                            "server.address=127.0.0.1",
                            "lycansync.rtc.server-url=" + (profile.equals("rtc-server") ? "wss" : "ws") + "://synthetic.invalid",
                            "lycansync.rtc.api-url=http://127.0.0.1:" + server.getAddress().getPort(),
                            "lycansync.rtc.api-key=timeout-test-key",
                            "lycansync.rtc.api-secret=timeout-test-secret-at-least-32-characters")
                    .run(context -> {
                        assertThat(context).hasNotFailed().hasSingleBean(RoomServiceClient.class);
                        var beans = new StaticListableBeanFactory();
                        beans.addBean("rooms", context.getBean(RoomServiceClient.class));
                        var access = new GroupRtcAccessService(beans.getBeanProvider(RoomServiceClient.class), mock(GroupMapper.class));
                        var result = callWorker.submit(() -> access.removeParticipant(UUID.randomUUID(), UUID.randomUUID()));
                        try {
                            assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
                            assertThatThrownBy(() -> result.get(13, TimeUnit.SECONDS))
                                    .isInstanceOf(ExecutionException.class)
                                    .hasCauseInstanceOf(RtcServiceUnavailableException.class)
                                    .satisfies(failure -> assertThat(failure.getCause().getCause())
                                            .isInstanceOf(InterruptedIOException.class));
                            assertThat(chunks.get()).isGreaterThanOrEqualTo(10);
                        } finally {
                            stop.countDown();
                            result.cancel(true);
                        }
                    });
        } finally {
            stop.countDown();
            server.stop(0);
            callWorker.shutdownNow();
            httpWorkers.shutdownNow();
            assertThat(callWorker.awaitTermination(5, TimeUnit.SECONDS)).isTrue();
            assertThat(httpWorkers.awaitTermination(5, TimeUnit.SECONDS)).isTrue();
        }
    }
}
