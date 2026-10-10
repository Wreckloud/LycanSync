package com.lycansync.api.auth.service;

import com.lycansync.api.auth.config.AccountAccessProperties;
import com.lycansync.api.auth.mapper.AuthMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Files;
import java.nio.file.Path;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * 正式部署入口与测试数据库隔离。
 * @author Wreckloud
 * @since 2026-10-10
 */
class AccountBootstrapTests {
    @TempDir Path directory;
    private final AccountAccessProperties settings = new AccountAccessProperties();
    private final AccessLinkService links = mock(AccessLinkService.class);
    private final AuthMapper users = mock(AuthMapper.class);

    @Test
    void shouldRejectRemovedPasswordLoginMode() {
        settings.setMode("test");
        assertThatThrownBy(() -> new AccountBootstrap(settings, links, users).run(null))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("只支持 invite");
        verifyNoInteractions(links, users);
    }

    @Test
    void shouldRejectTestDatabaseInFormalMode() {
        when(users.countLocalCredentials()).thenReturn(1L);
        assertThatThrownBy(() -> new AccountBootstrap(settings, links, users).run(null))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("独立数据库");
        verifyNoInteractions(links);
    }

    @Test
    void shouldNormalizeRootAddressAndWritePrivateActivationFile() throws Exception {
        settings.setPublicUrl("https://example.com/");
        settings.setBootstrapFile(directory.resolve("admin.txt").toString());
        when(links.activation()).thenReturn(new AccessLinkService.GeneratedLink(null, "https://example.com/join#token=" + "a".repeat(43)));
        new AccountBootstrap(settings, links, users).run(null);
        assertThat(settings.getPublicUrl()).isEqualTo("https://example.com");
        assertThat(Files.readString(directory.resolve("admin.txt"))).startsWith("https://example.com/join#token=");
        if (Files.getFileStore(directory).supportsFileAttributeView("posix")) {
            assertThat(Files.getPosixFilePermissions(directory.resolve("admin.txt")))
                    .isEqualTo(java.nio.file.attribute.PosixFilePermissions.fromString("rw-------"));
        }
    }

    @Test
    void shouldRejectNonHttpsOrPathBasedEntrypoint() {
        for (String url : new String[] {"http://example.com", "https://example.com/api", "https://user@example.com", "https://example.com#token=abc"}) {
            settings.setPublicUrl(url);
            assertThatThrownBy(() -> new AccountBootstrap(settings, links, users).run(null)).isInstanceOf(IllegalStateException.class);
        }
        verifyNoInteractions(links);
    }
}
