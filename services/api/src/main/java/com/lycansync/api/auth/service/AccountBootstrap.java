package com.lycansync.api.auth.service;

import com.lycansync.api.auth.config.AccountAccessProperties;
import com.lycansync.api.auth.mapper.AuthMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;

/**
 * 首次启动将激活链接写入部署侧私有文件，不写入公开接口或日志。
 *
 * @author Wreckloud
 * @since 2026-10-10
 */
@Component
@Profile("!test-fixtures")
@RequiredArgsConstructor
public class AccountBootstrap implements ApplicationRunner {
    private final AccountAccessProperties settings;
    private final AccessLinkService links;
    private final AuthMapper users;

    @Override
    public void run(ApplicationArguments arguments) throws Exception {
        if (!"invite".equals(settings.getMode())) {
            throw new IllegalStateException("账号登录只支持 invite 模式");
        }
        if (users.countLocalCredentials() != 0) {
            throw new IllegalStateException("正式邀请模式必须使用独立数据库，不能继承测试账号");
        }
        URI url = URI.create(settings.getPublicUrl());
        if (!"https".equals(url.getScheme()) || url.getHost() == null || url.getUserInfo() != null
                || url.getQuery() != null || url.getFragment() != null
                || !(url.getPath().isEmpty() || "/".equals(url.getPath()))) {
            throw new IllegalStateException("邀请模式必须配置不含路径的 HTTPS ACCOUNT_PUBLIC_URL");
        }
        settings.setPublicUrl(url.toString().replaceAll("/$", ""));
        Path file = Path.of(settings.getBootstrapFile());
        var activation = links.activation();
        if (activation == null) {
            Files.deleteIfExists(file);
            return;
        }
        Files.createDirectories(file.toAbsolutePath().getParent());
        if (Files.getFileStore(file.toAbsolutePath().getParent()).supportsFileAttributeView("posix")) {
            if (!Files.exists(file)) Files.createFile(file,
                    PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
            Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-------"));
        }
        Files.writeString(file, activation.url() + System.lineSeparator());
    }
}
